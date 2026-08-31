import { fingerprint } from './fingerprint.js';
import { sanitiseMapping } from './providers.js';
import { applyMapping, validateSample } from './validate.js';
import type { MappingProvider } from './providers.js';
import type { MappingStore } from './store.js';
import type { IngestResult, Table } from './types.js';

export interface IngestDeps {
  store: MappingStore;
  provider: MappingProvider;
}

/**
 * One function, two paths. The hot path costs nothing; the cold path costs one
 * model call and then makes itself hot.
 */
export async function ingest(table: Table, deps: IngestDeps): Promise<IngestResult> {
  const fp = fingerprint(table.headers);
  const cached = deps.store.get(fp);

  // A fingerprint match means the header set is identical — not that the data
  // behind those headers still means the same thing. Sampling a few rows is what
  // separates "we have seen this layout" from "this layout is still correct".
  if (cached !== undefined && validateSample(table, cached).ok) {
    return {
      fingerprint: fp,
      path: 'hot',
      modelCalls: 0,
      mapping: cached,
      records: applyMapping(table, cached),
    };
  }

  // Cold (never seen) and drift (seen, but the sample disagrees) converge here:
  // both are answered by inferring once. sanitiseMapping is the choke point —
  // nothing reaches the parser without passing through the canonical allow-list.
  const mapping = sanitiseMapping(await deps.provider.infer(table), table);

  // Overwrite, don't merge. The stale mapping is what just failed; keeping any
  // of it would leave the layout failing validation on every future file.
  deps.store.set(fp, mapping);

  return {
    fingerprint: fp,
    path: cached === undefined ? 'cold' : 'drift',
    modelCalls: 1,
    mapping,
    records: applyMapping(table, mapping),
  };
}
