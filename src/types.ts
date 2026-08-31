/**
 * The five fields everything downstream is allowed to see.
 *
 * TODO(me): these are the brief's defaults, not my production names. Swap in the
 * real ones — this list is the allow-list that model output is filtered through,
 * so it is the one place a rename actually matters.
 */
export const CANONICAL_FIELDS = [
  'customerName',
  'phone',
  'email',
  'departureDate',
  'pax',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** One spreadsheet row, keyed by the file's own raw header text. */
export type Row = Record<string, string>;

/**
 * A parsed sheet. Production reads .xlsx through SheetJS and produces this same
 * shape; nothing below this line knows or cares where the table came from.
 */
export interface Table {
  headers: string[];
  rows: Row[];
}

/**
 * normalised header -> canonical field.
 *
 * Keyed by normalised header, never by column index: a customer who reorders
 * their columns must not silently shift every field by one.
 */
export type Mapping = Record<string, CanonicalField>;

/** A row after mapping. Fields absent from the mapping stay undefined. */
export type ParsedRow = Partial<Record<CanonicalField, string>>;

/**
 * Which branch of ingest() the file took.
 *  cold  — layout never seen; inferred and cached
 *  hot   — layout known, sample looked right; zero model calls
 *  drift — layout known but the sample failed; re-inferred and cache overwritten
 */
export type IngestPath = 'cold' | 'hot' | 'drift';

export interface IngestResult {
  fingerprint: string;
  path: IngestPath;
  modelCalls: number;
  mapping: Mapping;
  records: ParsedRow[];
}
