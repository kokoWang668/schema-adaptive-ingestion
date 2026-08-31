import { createHash } from 'node:crypto';

/**
 * Fold away everything that varies between exports of the same layout:
 * case, accents ("Tél." vs "TEL"), punctuation and whitespace.
 *
 *   "Tél."       -> "tel"
 *   "E-MAIL"     -> "email"
 *   "Nom du client" -> "nomduclient"
 */
export function normaliseHeader(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Identifies a LAYOUT, not a file.
 *
 * Sorting before hashing is the whole trick: the same five columns in a
 * different order are the same layout, so a reordered export is a cache hit.
 *
 * The flip side is deliberate — adding, removing or renaming a column produces a
 * different fingerprint and forces one re-inference. That is the safe failure:
 * pay for one model call rather than mis-parse a column we have never seen.
 *
 * TODO(me): production may also fold in sheet name / column count. This hashes
 * the header set only.
 */
export function fingerprint(headers: string[]): string {
  const normalised = headers
    .map(normaliseHeader)
    .filter((h) => h.length > 0)
    .sort();
  return createHash('sha256').update(normalised.join('|')).digest('hex').slice(0, 16);
}
