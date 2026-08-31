# schema-adaptive-ingestion

Ingesting customer spreadsheets whose column layouts all differ, without calling
an LLM on every file.

This is a stripped-down version of a pattern I run in production, with toy data.
It is one idea, not a library: `src/ingest.ts` is 50 lines and everything else
exists to keep it that short.

## The problem

Three tour operators send passenger manifests. Same five facts, three layouts,
and none of them will change their export for me:

| What I need     | Operator A (FR) | Operator B (EN) | Operator C |
| --------------- | --------------- | --------------- | ---------- |
| `customerName`  | `Nom du client` | `Customer`      | `PAX NAME` |
| `phone`         | `Tél.`          | `Phone Number`  | `CONTACT`  |
| `email`         | `Courriel`      | `Email`         | `E-MAIL`   |
| `departureDate` | `Départ`        | `Travel Date`   | `DEP_DT`   |
| `pax`           | `Personnes`     | `Pax`           | `QTY`      |

Column order varies between exports from the same operator, and a layout changes
without warning when someone edits the template.

## Why the three obvious options don't work

**A parser per customer.** Correct on day one. It is also a code change every
time an operator is onboarded or edits their template, which means ingestion is
blocked on a deploy. This scales with headcount, not with customers.

**An alias table — `tél`, `tel`, `phone`, `contact` → `phone`.** Fine until two
readings are both common. `Contact` is a phone number for one operator and an
email address for another; `Pax` is a passenger name in one file and a headcount
in the next. The alias table cannot see the values, so it guesses, and it guesses
silently. The failure looks like clean data.

**Send every file to a model.** It works, and it is the version I keep meeting.
The cost and latency are per file rather than per layout, even though the answer
is identical for the ten thousand files sharing one layout. It also makes every
ingest non-deterministic and dependent on an external service being up — a bad
property for a step that runs before anything else in the pipeline.

The layouts are few. The files are many. The mapping only needs to be computed
per layout.

## The approach

```
fingerprint(headers)
  │
  ├── cache hit  → validate a sample of rows
  │                 ├── pass → deterministic parse        (0 model calls)
  │                 └── fail → re-infer, overwrite cache   (1 model call)
  │
  └── cache miss → infer mapping, write to cache           (1 model call)
```

Four things make it work:

**The fingerprint identifies a layout, not a file.** Headers are normalised
(lowercase, accents stripped via NFD, punctuation and whitespace removed), then
**sorted**, then hashed. Sorting is what makes a reordered export a cache hit
rather than a new layout. `Tél.` and `TEL` land on the same key.

**The mapping is keyed by normalised header, never by column index.** If it were
keyed by index, a customer inserting a column would shift every field by one and
the parse would still "succeed".

**Re-inference overwrites.** After drift, the stale mapping is exactly the thing
that just failed, so it is replaced rather than merged. One model call, then the
layout is back on the hot path.

**Nothing reaches the parser without passing the canonical allow-list.** Models
return `customer_name`, or `notes`, or a header the file does not have.
`sanitiseMapping` drops all of it. An unmapped field is a visible hole; an
invented one is a silent wrong answer.

The cold path is behind a one-method interface with two implementations: an
offline one (no key, no network — this is what `npm test` and `npm run demo` use)
and an Anthropic one. Which provider is installed does not change which branch a
file takes.

The offline provider infers from **value shape first** (email regex, digit count,
date parse, small integer) and falls back to header keywords only for ties and
all-blank columns. That ordering is not a shortcut around the model — it is the
same judgement the model is asked to make, and it is why fixture #4 recovers.

Fixtures are CSV so they are readable on GitHub. Production reads `.xlsx` through
SheetJS; everything below the reader sees the same `{ headers, rows }`.

## Failure modes

The interesting part. This design trades one class of failure for another
deliberately, and one hole is still open.

**Unsolved: same headers, same value types, different meaning.** An operator
starts putting the *booking* date under `Travel Date` instead of the departure
date. The header set is unchanged, so the fingerprint matches; every sampled
value is still a valid date, so sampling passes. The file is served from cache
and booking dates arrive labelled `departureDate`. Nothing in this design can see
it.

There is an executing test for this — `KNOWN BLIND SPOT` in `src/ingest.test.ts`
— that asserts the current, wrong behaviour. Closing it needs value
*distribution* checks rather than value *shape* checks (departure dates cluster
in the future, booking dates in the past), recorded at inference time and
compared on later files. That is a different mechanism with its own
false-positive budget, so I have not built it. The test is there so the gap stays
visible instead of becoming folklore.

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

**Adding, removing or renaming a column always costs one model call.** That is
the intended failure, not a regression: a changed header set means a column I
have never reasoned about, and re-inferring once is cheaper than mis-parsing
silently.

## Results

<!-- TODO(me): fill from production logs, or delete this section before sending. The values below are placeholders, not measurements. -->

| Metric                   | Value |
| ------------------------ | ----- |
| Files ingested           | TBD   |
| Distinct layouts         | TBD   |
| Model calls / 1000 files | TBD   |
| Median hot-path latency  | TBD   |
| Re-inferences from drift | TBD   |

The demo, on the five fixtures in this repo: **4 model calls for 5 files** — one
per distinct layout, plus one drift recovery.

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
fixtures/          5 synthetic CSVs (no real customer data)
```

## Running it

```bash
npm install
npm test
```

`npm test` is 14 tests and needs no API key and no network. `npm run demo` prints
the path each fixture takes; `npm run typecheck` runs `tsc --noEmit` under strict
mode with `noUncheckedIndexedAccess`.

Demo output:

```
file                        fingerprint       path   model calls
01-fr-standard.csv          fa99f02611da6cc6  COLD   1
02-fr-reordered.csv         fa99f02611da6cc6  HOT    0
03-en-standard.csv          6cce635261e3b34c  COLD   1
04-en-contents-swapped.csv  6cce635261e3b34c  DRIFT  1
05-abbrev-uppercase.csv     061c0095a1920438  COLD   1
```

Only `AnthropicProvider` needs `ANTHROPIC_API_KEY`, and nothing in the test or
demo path constructs it.

## What I'd build next

1. **Value-distribution checks**, to close the blind spot above. Record a cheap
   per-field profile at inference time (date range relative to ingest time, digit
   length histogram, null rate) and compare it on later files. Needs a
   false-positive budget before it goes anywhere near a hot path.
2. **Per-layout metrics** — re-inference rate, sample-failure rate by field. A
   fingerprint that re-infers often is one fingerprint covering two layouts, and
   right now I would only find that by reading logs.
3. **A confidence signal on the cold path**, so a mapping the model was unsure
   about lands in a review queue instead of straight into the cache. Today a
   confidently wrong mapping and a confidently right one are indistinguishable
   until sampling catches the difference.
4. **Store the sample a mapping was inferred from.** When a mapping turns out to
   be wrong, the first question is always "what did it look at", and right now
   that is unanswerable.
