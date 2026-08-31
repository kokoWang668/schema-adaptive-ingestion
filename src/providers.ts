import { normaliseHeader } from './fingerprint.js';
import { CANONICAL_FIELDS } from './types.js';
import { FIELD_SHAPE, SAMPLE_SIZE } from './validate.js';
import type { CanonicalField, Mapping, Table } from './types.js';

/**
 * The cold path, behind an interface.
 *
 * Two implementations ship: an offline one so tests and the demo run with no API
 * key and no network, and a real API one. ingest() routes identically for both —
 * swapping the provider must not change which branch a file takes.
 */
export interface MappingProvider {
  infer(table: Table): Promise<Mapping>;
}

/**
 * Filter model output through the canonical list.
 *
 * A model will happily return "customer_name", "notes", or a header the file
 * does not contain. Anything unrecognised is dropped here rather than allowed to
 * reach the parser — an unmapped field is a visible hole, an invented one is a
 * silent wrong answer.
 */
export function sanitiseMapping(raw: unknown, table: Table): Mapping {
  const known = new Set<string>(CANONICAL_FIELDS);
  const fileHeaders = new Set(table.headers.map(normaliseHeader));
  const out: Mapping = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [header, field] of Object.entries(raw as Record<string, unknown>)) {
    const key = normaliseHeader(header);
    if (!fileHeaders.has(key)) continue;
    if (typeof field !== 'string' || !known.has(field)) continue;
    out[key] = field as CanonicalField;
  }
  return out;
}

/** Wraps a provider and counts calls, so tests and the demo can assert on them. */
export function countingProvider(inner: MappingProvider): {
  provider: MappingProvider;
  calls: () => number;
} {
  let calls = 0;
  return {
    provider: {
      infer: (table) => {
        calls++;
        return inner.infer(table);
      },
    },
    calls: () => calls,
  };
}

/** Header words that hint at a field. Only a tie-breaker — see OfflineProvider. */
const HEADER_HINTS: Record<CanonicalField, string[]> = {
  customerName: ['name', 'nom', 'client', 'customer', 'passenger', 'guest', 'voyageur'],
  phone: ['phone', 'tel', 'mobile', 'cell', 'contact', 'portable'],
  email: ['email', 'mail', 'courriel'],
  departureDate: ['date', 'depart', 'dep', 'dt', 'travel'],
  pax: ['pax', 'qty', 'quantity', 'personne', 'nombre', 'count', 'seats'],
};

function hints(normalisedHeader: string, field: CanonicalField): boolean {
  return HEADER_HINTS[field].some((word) => normalisedHeader.includes(word));
}

/**
 * Deterministic stand-in for the model. No key, no network.
 *
 * Values first, headers second — deliberately. Headers alone cannot tell you
 * whether "Contact" is a phone or an email, or whether "Pax" is a passenger name
 * or a headcount; both readings are common in real files. The shape of the
 * sampled values can. Header keywords only break ties and cover columns whose
 * values were all blank.
 */
export class OfflineProvider implements MappingProvider {
  async infer(table: Table): Promise<Mapping> {
    const sample = table.rows.slice(0, SAMPLE_SIZE);
    const candidates: { header: string; field: CanonicalField; score: number; hint: boolean }[] = [];

    for (const header of table.headers) {
      const values = sample
        .map((r) => r[header]?.trim())
        .filter((v): v is string => v !== undefined && v !== '');
      const key = normaliseHeader(header);
      for (const field of CANONICAL_FIELDS) {
        const score =
          values.length === 0
            ? 0
            : values.filter((v) => FIELD_SHAPE[field](v)).length / values.length;
        candidates.push({ header, field, score, hint: hints(key, field) });
      }
    }

    const mapping: Mapping = {};
    const usedHeaders = new Set<string>();
    const usedFields = new Set<CanonicalField>();
    const claim = (header: string, field: CanonicalField): void => {
      mapping[normaliseHeader(header)] = field;
      usedHeaders.add(header);
      usedFields.add(field);
    };

    // Pass 1: value shape, strongest match first.
    const byValue = candidates
      .filter((c) => c.score >= 0.6)
      .sort((a, b) => b.score - a.score || Number(b.hint) - Number(a.hint));
    for (const c of byValue) {
      if (usedHeaders.has(c.header) || usedFields.has(c.field)) continue;
      claim(c.header, c.field);
    }

    // Pass 2: header keywords, for columns the values could not separate.
    for (const header of table.headers) {
      if (usedHeaders.has(header)) continue;
      const key = normaliseHeader(header);
      const field = CANONICAL_FIELDS.find((f) => !usedFields.has(f) && hints(key, f));
      if (field) claim(header, field);
    }

    return sanitiseMapping(mapping, table);
  }
}

/**
 * The real cold path. Same interface, so the routing in ingest.ts is unchanged.
 *
 * Raw fetch rather than @anthropic-ai/sdk only because this repo deliberately
 * ships with no runtime dependencies; production uses the SDK.
 *
 * TODO(me): confirm this matches the provider and model production actually calls.
 */
export class AnthropicProvider implements MappingProvider {
  constructor(
    private readonly apiKey: string | undefined = process.env['ANTHROPIC_API_KEY'],
    private readonly model: string = 'claude-opus-5',
  ) {}

  async infer(table: Table): Promise<Mapping> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const sample = table.rows.slice(0, SAMPLE_SIZE);
    const prompt = [
      'Map each spreadsheet column to one canonical field, or to null if none fits.',
      `Canonical fields: ${CANONICAL_FIELDS.join(', ')}.`,
      'Judge by the sample values, not only the header text.',
      'Reply with JSON only: an object of header -> field name or null.',
      '',
      `Headers: ${JSON.stringify(table.headers)}`,
      `Sample rows: ${JSON.stringify(sample)}`,
    ].join('\n');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((b) => b.type === 'text')?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // A malformed reply is an empty mapping, not a crash: the file then fails
      // validation loudly downstream instead of half-parsing.
      return {};
    }
    return sanitiseMapping(parsed, table);
  }
}
