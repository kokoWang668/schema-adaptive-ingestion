# Schema-Adaptive Spreadsheet Ingestion

Every customer sends the same data in a different spreadsheet. This is a small
reference implementation of the pattern I use in production to ingest them
without calling an LLM on every file.

**Core idea:** the LLM runs on the cold path, deterministic code runs on the hot
path. A new layout costs one model call; every file after that costs zero.

It is one idea, not a library: `src/ingest.ts` is 50 lines and everything else
exists to keep it that short.

---

## The problem

I run a tour-operator scheduling product. Each operator exports their passenger
manifest from a different system, so no two files agree on anything:

| What I need     | Operator A (FR) | Operator B (EN) | Operator C |
| --------------- | --------------- | --------------- | ---------- |
| `customerName`  | `Nom du client` | `Customer`      | `PAX NAME` |
| `phone`         | `Tél.`          | `Phone Number`  | `CONTACT`  |
| `email`         | `Courriel`      | `Email`         | `E-MAIL`   |
| `departureDate` | `Départ`        | `Travel Date`   | `DEP_DT`   |
| `pax`           | `Personnes`     | `Pax`           | `QTY`      |

Column order varies between exports from the same operator, and a layout changes
without warning when someone edits the template.

## Why the obvious options don't work

**Ask customers to use my template.** They won't. The export comes out of
software they don't control.

**Hand-write a parser per customer.** Correct on day one. It is also a code
change every time an operator is onboarded or edits their template, which means
ingestion is blocked on a deploy. This scales with headcount, not with customers.

**Keep an alias table — `tél`, `tel`, `phone`, `contact` → `phone`.** Fine until
two readings are both common. `Contact` is a phone number for one operator and an
email address for another; `Pax` is a passenger name in one file and a headcount
in the next. The alias table cannot see the values, so it guesses, and it guesses
silently. The failure looks like clean data.

**Send every file to an LLM.** Works, but you pay per file forever, latency is
unpredictable, and the same file can parse differently on two different runs. The
answer is identical for the ten thousand files sharing one layout, and it also
makes ingestion — the step that runs before everything else — depend on an
external service being up.

The layouts are few. The files are many. The mapping only needs to be computed
per layout.

## The approach

```
        upload
          │
          ▼
   ┌──────────────┐
   │  fingerprint │  normalised header set, sorted, hashed
   └──────┬───────┘
          │
     ┌────┴────┐
   hit        miss
     │           │
     ▼           ▼
┌─────────┐  ┌───────────────┐
│ cached  │  │  LLM infers   │
│ mapping │  │ column → field│
└────┬────┘  └──────┬────────┘
     │              │
     ▼              │
┌──────────────┐    │
│ sample check │    │
│  (N rows)    │    │
└────┬────┬────┘    │
   pass  fail       │
     │    └─────────┤
     ▼              ▼
   parse      write mapping
                to cache
```

Two paths, one loop:

1. **Fingerprint the layout.** Normalise the header row (lowercase, accents
   stripped via NFD, punctuation and whitespace removed), **sort** it, hash it.
   Sorting is what makes a reordered export a cache hit rather than a new layout.
   `Tél.` and `TEL` land on the same key.
2. **Cache hit → deterministic parse.** No model call, no variance, single-digit
   milliseconds.
3. **Cache miss → LLM maps columns to canonical fields.** The mapping is stored
   against the fingerprint, so this cost is paid once per layout, not once per
   file.
4. **Validate by sampling.** After a cache hit, check a few rows against the
   expected shape for each mapped field. If validation fails, fall back to the
   LLM path and **overwrite** the stored mapping.

Step 4 is what makes the system self-healing. When a customer's export tool
changes what sits under a header, the pipeline notices, re-learns the layout
once, and goes back to the fast path — no ticket, no manual fix.

Two details that are easy to get wrong:

**The mapping is keyed by normalised header, never by column index.** If it were
keyed by index, a customer inserting a column would shift every field by one and
the parse would still "succeed".

**Nothing reaches the parser without passing the canonical allow-list.** Models
return `customer_name`, or `notes`, or a header the file does not have.
`sanitiseMapping` drops all of it. An unmapped field is a visible hole; an
invented one is a silent wrong answer.

The cold path sits behind a one-method interface with two implementations: an
offline one (no key, no network — this is what `npm test` and `npm run demo` use)
and an Anthropic one. Which provider is installed does not change which branch a
file takes.

The offline provider infers from **value shape first** (email regex, digit count,
date parse, small integer) and falls back to header keywords only for ties and
all-blank columns. That ordering is not a shortcut around the model — it is the
same judgement the model is asked to make, and it is why the drift fixture
recovers correctly.

Fixtures are CSV so they are readable on GitHub. Production reads `.xlsx` through
SheetJS; everything below the reader sees the same `{ headers, rows }`.

## Failure modes

The interesting part. This design trades one class of failure for another
deliberately, and one hole is still open.

**Same headers, different meaning.** ⚠️ Not solved. An operator starts putting
the *booking* date under `Travel Date` instead of the departure date. The header
set is unchanged, so the fingerprint matches; every sampled value is still a
valid date, so sampling passes. The file is served from cache and booking dates
arrive labelled `departureDate`. The pipeline is confidently wrong.

Catching this needs value-*distribution* checks rather than value-*shape* checks
(departure dates cluster in the future, booking dates in the past), recorded at
inference time and compared on later files. That is a different mechanism with
its own false-positive budget, and I haven't built it. There is an executing test
for the gap — `KNOWN BLIND SPOT` in `src/ingest.test.ts` — that asserts the
current, wrong behaviour. I'd rather document the blind spot in a test that runs
than pretend the sampling covers it.

**Cosmetic header drift.** `Phone` → `Phone Number` changes the fingerprint and
forces an unnecessary re-inference. Normalisation absorbs case, accents,
whitespace and punctuation, but not synonyms. Acceptable: it costs one model
call, and the new fingerprint is cached immediately.

**Column reordering.** Handled by sorting the header set before hashing, so a
reordered file still hits the cache. There's a test for it.

**Added or removed columns.** Changes the fingerprint, so it re-infers rather
than silently mis-parsing. This is the safe failure.

**Cache thrash between two files that share a fingerprint.** Fixtures #3 and #4
have identical headers and disagree about contents. Alternating between them
re-infers every time, because each one invalidates the other's mapping. In
production this shows up as a layout with a high re-inference rate, which is why
that rate is worth logging — it is the signal that one fingerprint is covering
two real layouts.

**Sampling only looks at the first N rows.** A column that goes wrong at row 500
is not caught. The sample is a smell test on the hot path, not validation; a
per-row schema check downstream is a separate job.

**An empty optional column never fails validation.** A field with no non-empty
sampled values is skipped rather than failed, because a blank optional column is
not evidence of drift. The cost is that a mapping pointing at a permanently empty
column stays cached and quietly yields nothing.

**Two fields of the same shape can be swapped undetected.** Mobile and landline
columns swapping contents passes every shape check, for the same reason the
booking-date case does.

**Normalisation can collide.** `Tel` and `Tél.` in the same file normalise to one
key. The mapping holds one entry and the second column is dropped. Rare, and I
would rather have the collision than have accents produce two layouts.

## Repo layout

```
src/
  types.ts         canonical fields, Mapping, Row, IngestResult
  fingerprint.ts   normaliseHeader(), fingerprint()
  store.ts         fingerprint -> mapping, JSON-file backed
  providers.ts     MappingProvider interface + offline impl + Anthropic impl
  validate.ts      validateSample(), applyMapping(), the value-shape predicates
  csv.ts           fixture reader -> { headers, rows }
  ingest.ts        the routing — the file worth reading
  demo.ts          runs every fixture, prints path + model calls per file
fixtures/          5 synthetic CSVs
```

## Running the example

```bash
npm install
npm test
```

`npm test` is 14 tests and needs no API key and no network — it covers
normalisation, fingerprint stability under reordering, fingerprint change on
add/rename, zero provider calls on a known layout, drift detection and recovery,
and the blind spot above. `npm run demo` ingests every fixture and prints the
path each one took; `npm run typecheck` runs `tsc --noEmit` under strict mode
with `noUncheckedIndexedAccess`.

Demo output:

```
file                        fingerprint       path   model calls
01-fr-standard.csv          fa99f02611da6cc6  COLD   1
02-fr-reordered.csv         fa99f02611da6cc6  HOT    0
03-en-standard.csv          6cce635261e3b34c  COLD   1
04-en-contents-swapped.csv  6cce635261e3b34c  DRIFT  1
05-abbrev-uppercase.csv     061c0095a1920438  COLD   1
```

Five files, three distinct layouts, one drift recovery: **4 model calls**.

Only `AnthropicProvider` needs `ANTHROPIC_API_KEY`, and nothing in the test or
demo path constructs it.

`fixtures/` contains synthetic spreadsheets in several layouts. No customer data
appears anywhere in this repository — the production system handles personal
information under Quebec's Law 25, and every example here is generated.

## What I'd build next

1. **Value-distribution validation**, to close the "same headers, different
   meaning" gap above. A cheap per-field profile recorded at inference time (date
   range relative to ingest time, digit-length histogram, null rate), compared on
   later files. Needs a false-positive budget before it goes near a hot path.
2. **Fuzzy fingerprint matching**, so a cosmetic rename reuses the existing
   mapping instead of re-inferring — with the re-inference kept as the fallback
   when the fuzzy match is not confident.
3. **A confidence score on the cold path**, routing low-confidence mappings to a
   human review queue rather than straight into the parser. Today a confidently
   wrong mapping and a confidently right one are indistinguishable until sampling
   catches the difference.
4. **Per-layout metrics** — re-inference rate, sample-failure rate by field. A
   fingerprint that re-infers often is one fingerprint covering two real layouts,
   and right now I would only find that by reading logs.
