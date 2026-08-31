# Schema-Adaptive Spreadsheet Ingestion

Every customer sends the same data in a different spreadsheet. This is a small
reference implementation of the pattern I use in production to ingest them
without calling an LLM on every file.

**Core idea:** the LLM runs on the cold path, deterministic code runs on the hot
path. A new layout costs one model call; every file after that costs zero.

---

## The problem

I run a tour-operator scheduling product. Each operator exports their passenger
manifest from a different system, so no two files agree on anything:

| Operator A | Operator B | Operator C |
|---|---|---|
| `Nom du client` | `Customer` | `PAX NAME` |
| `Tél.` | `Phone Number` | `Contact` |
| `Départ` | `Travel Date` | `DEP_DT` |

Three naive options, all bad:

- **Ask customers to use my template.** They won't. Their export comes out of
  software they don't control.
- **Hand-write a parser per customer.** Doesn't scale, and breaks silently the
  first time someone adds a column.
- **Send every file to an LLM.** Works, but you pay per file forever, latency is
  unpredictable, and the same file can parse differently on two different runs.

## The approach

```
        upload
          │
          ▼
   ┌──────────────┐
   │  fingerprint │  normalised header set + column count
   └──────┬───────┘
          │
     ┌────┴────┐
   hit        miss
     │           │
     ▼           ▼
┌─────────┐  ┌──────────────┐
│ cached  │  │  LLM infers  │
│ mapping │  │ column → field│
└────┬────┘  └──────┬───────┘
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

1. **Fingerprint the layout.** Normalise the header row (lowercase, strip
   whitespace and punctuation, sort), hash it together with the column count.
2. **Cache hit → deterministic parse.** No model call, no variance, single-digit
   milliseconds.
3. **Cache miss → LLM maps columns to canonical fields.** The mapping is stored
   against the fingerprint, so this cost is paid once per layout, not once per
   file.
4. **Validate by sampling.** After a cache hit, check a few rows against the
   expected type for each mapped field. If validation fails, fall back to the
   LLM path and overwrite the stored mapping.

Step 4 is what makes the system self-healing. When a customer renames a column
or their export tool changes, the pipeline notices, re-learns the layout once,
and goes back to the fast path — no ticket, no manual fix.

## Failure modes

These are the ones worth knowing about. The first three are handled; the last
one is a real limitation.

**Cosmetic header drift.** `Phone` → `Phone Number` changes the fingerprint and
forces an unnecessary re-inference. Normalisation absorbs case, whitespace and
punctuation, but not synonyms. Acceptable: it costs one model call, and the new
fingerprint is cached immediately.

**Column reordering.** Handled by sorting the header set before hashing, so a
reordered file still hits the cache. There's a test for this.

**Added or removed columns.** Changes the fingerprint, so it re-infers rather
than silently mis-parsing. This is the safe failure.

**Same headers, different meaning.** ⚠️ Not solved. If `Date` means departure
date for one export and booking date for another, the fingerprint matches and
type validation passes — both are dates — so the pipeline is confidently wrong.
Catching this needs value-distribution checks (e.g. departure dates should be in
the future), which I haven't built. I'd rather document the blind spot than
pretend the sampling covers it.

## Results

<!-- TODO: replace with your own logged numbers before publishing -->

Measured over `<PERIOD>` of production traffic, `<N>` files from `<M>` operators:

| Path | Share | Model calls |
|---|---|---|
| Cache hit, validation passed | `<X>%` | 0 |
| New layout, first ingest | `<Y>%` | 1 |
| Drift detected, auto re-learned | `<Z>%` | 1 |

Field-level accuracy on the cold path, measured against `<N>` hand-labelled
files: `<A>%`. Remaining errors fall into `<describe the categories>`.

## Running the example

```bash
npm install
npm run demo        # ingests the sample files in fixtures/
npm test            # includes the reordering and drift cases
```

`fixtures/` contains synthetic spreadsheets in several layouts. No customer data
appears anywhere in this repository — the production system handles personal
information under Quebec's Law 25, and all examples here are generated.

## What I'd build next

- Value-distribution validation, to close the "same headers, different meaning"
  gap above.
- Fuzzy fingerprint matching, so cosmetic renames reuse the existing mapping
  instead of re-inferring.
- A confidence score on the cold path, routing low-confidence mappings to a
  human review queue rather than straight into the parser.
