import { beforeEach, describe, expect, it } from 'vitest';
import { readCsv } from './csv.js';
import { fingerprint } from './fingerprint.js';
import { ingest } from './ingest.js';
import { countingProvider, OfflineProvider } from './providers.js';
import { createStore } from './store.js';
import type { IngestDeps } from './ingest.js';
import type { Table } from './types.js';

const fixture = (name: string): Table => readCsv(`fixtures/${name}`);

let deps: IngestDeps;
let calls: () => number;

beforeEach(() => {
  const counted = countingProvider(new OfflineProvider());
  calls = counted.calls;
  deps = { store: createStore(), provider: counted.provider };
});

describe('cold path', () => {
  it('infers a mapping for an unseen layout', async () => {
    const result = await ingest(fixture('01-fr-standard.csv'), deps);
    expect(result.path).toBe('cold');
    expect(result.modelCalls).toBe(1);
    expect(calls()).toBe(1);
    expect(result.records[0]).toEqual({
      customerName: 'Amélie Rousseau',
      phone: '514-555-0142',
      email: 'amelie.rousseau@example.com',
      departureDate: '2026-04-12',
      pax: '2',
    });
  });

  it('reads uppercase abbreviations from value shape, not header text', async () => {
    // "CONTACT" and "QTY" say nothing on their own; the values decide.
    const result = await ingest(fixture('05-abbrev-uppercase.csv'), deps);
    expect(result.records[0]).toEqual({
      customerName: 'Adaeze Nwosu',
      phone: '+1 604 555 0102',
      email: 'adaeze.nwosu@example.com',
      departureDate: '03/08/2026',
      pax: '2',
    });
  });
});

describe('hot path', () => {
  it('serves a known layout with zero provider calls', async () => {
    await ingest(fixture('01-fr-standard.csv'), deps);
    expect(calls()).toBe(1);

    const again = await ingest(fixture('01-fr-standard.csv'), deps);
    expect(again.path).toBe('hot');
    expect(again.modelCalls).toBe(0);
    expect(calls()).toBe(1); // the counter, not just the result, must not move
  });

  it('treats a reordered file as the same layout and still maps the right values', async () => {
    const original = fixture('01-fr-standard.csv');
    const reordered = fixture('02-fr-reordered.csv');
    expect(fingerprint(reordered.headers)).toBe(fingerprint(original.headers));

    await ingest(original, deps);
    const result = await ingest(reordered, deps);

    expect(result.path).toBe('hot');
    expect(calls()).toBe(1);
    // Columns moved; the mapping is keyed by header, so the values follow.
    expect(result.records[0]).toEqual({
      customerName: 'Gabrielle Dubé',
      phone: '514-555-0111',
      email: 'gabrielle.dube@example.com',
      departureDate: '2026-05-03',
      pax: '2',
    });
  });
});

describe('drift recovery', () => {
  it('catches swapped column contents by sampling and re-infers', async () => {
    const clean = fixture('03-en-standard.csv');
    const swapped = fixture('04-en-contents-swapped.csv');
    // Identical headers: the fingerprint cannot tell these apart. Sampling can.
    expect(fingerprint(swapped.headers)).toBe(fingerprint(clean.headers));

    await ingest(clean, deps);
    const result = await ingest(swapped, deps);

    expect(result.path).toBe('drift');
    expect(result.modelCalls).toBe(1);
    expect(calls()).toBe(2);
    expect(result.records[0]).toEqual({
      customerName: 'Samir Haddad',
      phone: '604-555-0121',
      email: 'samir.haddad@example.com',
      departureDate: '2026-07-06',
      pax: '2',
    });
  });

  it('overwrites the cache so the corrected layout is hot again', async () => {
    await ingest(fixture('03-en-standard.csv'), deps);
    await ingest(fixture('04-en-contents-swapped.csv'), deps);
    expect(calls()).toBe(2);

    const third = await ingest(fixture('04-en-contents-swapped.csv'), deps);
    expect(third.path).toBe('hot');
    expect(calls()).toBe(2); // self-healed: one call after the drift, then free
  });
});

describe('untrusted model output', () => {
  it('drops field names that are not canonical', async () => {
    const rogue = {
      infer: async () => ({
        customer: 'customerName',
        phonenumber: 'phone',
        email: 'email',
        traveldate: 'internal_notes', // invented field
        pax: 'pax',
      }),
    };
    // @ts-expect-error deliberately returning a non-canonical field name
    const result = await ingest(fixture('03-en-standard.csv'), { ...deps, provider: rogue });

    expect(Object.values(result.mapping)).not.toContain('internal_notes');
    expect(result.records[0]?.departureDate).toBeUndefined();
    expect(result.records[0]?.customerName).toBe('Marina Alvarez');
  });
});

describe('KNOWN BLIND SPOT: same headers, same types, different meaning', () => {
  // Headers identical, value shapes identical, meaning changed: the operator
  // started putting the BOOKING date under "Travel Date" instead of the
  // departure date. The fingerprint matches and every sampled value is still a
  // valid date, so this sails through as a cache hit and we serve booking dates
  // labelled departureDate. Nothing in the current design can see it.
  //
  // Closing it needs value-DISTRIBUTION checks rather than value-shape checks —
  // e.g. departure dates cluster in the future and booking dates in the past, so
  // a per-field distribution recorded at inference time and compared on later
  // files would catch the shift. That is a different mechanism with its own
  // false-positive budget, so it is not built here.
  //
  // This test asserts the WRONG behaviour on purpose. If it ever fails, the gap
  // was closed and the test should be rewritten, not deleted.
  const headers = ['Customer', 'Phone Number', 'Email', 'Travel Date', 'Pax'];
  const table = (dates: string[]): Table => ({
    headers,
    rows: dates.map((d, i) => ({
      Customer: `Person ${'ABCDEF'[i] ?? 'X'}`,
      'Phone Number': `604-555-01${10 + i}`,
      Email: `person${i}@example.com`,
      'Travel Date': d,
      Pax: '2',
    })),
  });

  it('serves booking dates as departureDate, from cache, with no model call', async () => {
    const departures = table(['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29']);
    const bookings = table(['2025-11-03', '2025-11-10', '2025-11-17', '2025-11-24', '2025-12-01']);

    await ingest(departures, deps);
    const result = await ingest(bookings, deps);

    expect(result.path).toBe('hot');
    expect(calls()).toBe(1);
    expect(result.records[0]?.departureDate).toBe('2025-11-03'); // a booking date
  });
});
