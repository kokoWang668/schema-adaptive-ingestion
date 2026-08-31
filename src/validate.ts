import { normaliseHeader } from './fingerprint.js';
import { CANONICAL_FIELDS } from './types.js';
import type { CanonicalField, Mapping, ParsedRow, Table } from './types.js';

/**
 * How many rows the hot path looks at before trusting a cached mapping.
 *
 * TODO(me): production sample size goes here. Small on purpose — this runs on
 * every file, and the point is a cheap smell test, not a full validation pass.
 */
export const SAMPLE_SIZE = 5;

/** Share of sampled values that must look right before a field is accepted. */
const PASS_RATIO = 0.6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const LOOSE_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

function looksLikeDate(v: string): boolean {
  return ISO_DATE.test(v) || LOOSE_DATE.test(v);
}

function digitsOf(v: string): string {
  return v.replace(/\D/g, '');
}

/**
 * What each field's values look like.
 *
 * Used twice, on purpose: the offline provider infers a mapping from these, and
 * the hot path re-checks a cached mapping against them. One definition of "this
 * column holds phone numbers" keeps inference and validation from disagreeing.
 */
export const FIELD_SHAPE: Record<CanonicalField, (v: string) => boolean> = {
  email: (v) => EMAIL.test(v),
  // Dates are excluded explicitly: "2026-04-12" strips to 8 digits and would
  // otherwise read as a plausible phone number.
  phone: (v) =>
    !looksLikeDate(v) &&
    /^[\d\s()+.-]+$/.test(v) &&
    digitsOf(v).length >= 7 &&
    digitsOf(v).length <= 15,
  departureDate: looksLikeDate,
  pax: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 40,
  customerName: (v) => /\p{L}/u.test(v) && !/\d/.test(v) && !EMAIL.test(v),
};

/** Rename the file's columns to canonical fields. No coercion, no cleanup. */
export function applyMapping(table: Table, mapping: Mapping): ParsedRow[] {
  const rawHeaderFor = new Map<CanonicalField, string>();
  for (const raw of table.headers) {
    const field = mapping[normaliseHeader(raw)];
    if (field && !rawHeaderFor.has(field)) rawHeaderFor.set(field, raw);
  }
  return table.rows.map((row) => {
    const out: ParsedRow = {};
    for (const field of CANONICAL_FIELDS) {
      const raw = rawHeaderFor.get(field);
      if (raw !== undefined) out[field] = row[raw];
    }
    return out;
  });
}

export interface SampleReport {
  ok: boolean;
  failed: CanonicalField[];
}

/**
 * Cheap smell test on a cached mapping.
 *
 * This is what catches the case the fingerprint cannot: identical headers whose
 * CONTENTS have moved (an export template that swaps two columns but keeps the
 * header row). A field with no non-empty sampled values is skipped rather than
 * failed — an empty optional column is not evidence of drift.
 */
export function validateSample(
  table: Table,
  mapping: Mapping,
  size: number = SAMPLE_SIZE,
): SampleReport {
  const sample = applyMapping({ headers: table.headers, rows: table.rows.slice(0, size) }, mapping);
  const failed: CanonicalField[] = [];
  for (const field of CANONICAL_FIELDS) {
    const values = sample
      .map((r) => r[field]?.trim())
      .filter((v): v is string => v !== undefined && v !== '');
    if (values.length === 0) continue;
    const passed = values.filter((v) => FIELD_SHAPE[field](v)).length;
    if (passed / values.length < PASS_RATIO) failed.push(field);
  }
  return { ok: failed.length === 0, failed };
}
