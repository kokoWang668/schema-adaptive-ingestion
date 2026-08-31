import { describe, expect, it } from 'vitest';
import { fingerprint, normaliseHeader } from './fingerprint.js';

describe('normaliseHeader', () => {
  it('absorbs case, accents, punctuation and whitespace', () => {
    expect(normaliseHeader('Tél.')).toBe('tel');
    expect(normaliseHeader('TEL')).toBe('tel');
    expect(normaliseHeader('E-MAIL')).toBe('email');
    expect(normaliseHeader('  e mail  ')).toBe('email');
    expect(normaliseHeader('Départ')).toBe('depart');
    expect(normaliseHeader('DEPART')).toBe('depart');
  });
});

describe('fingerprint', () => {
  const base = ['Customer', 'Phone Number', 'Email', 'Travel Date', 'Pax'];

  it('is stable under column reordering', () => {
    const reordered = ['Email', 'Pax', 'Customer', 'Travel Date', 'Phone Number'];
    expect(fingerprint(reordered)).toBe(fingerprint(base));
  });

  it('is stable under cosmetic header differences', () => {
    const cosmetic = ['CUSTOMER', 'phone_number', 'E-Mail', 'Travel  Date', 'Pax.'];
    expect(fingerprint(cosmetic)).toBe(fingerprint(base));
  });

  it('changes when a column is added', () => {
    expect(fingerprint([...base, 'Notes'])).not.toBe(fingerprint(base));
  });

  it('changes when a column is removed', () => {
    expect(fingerprint(base.slice(1))).not.toBe(fingerprint(base));
  });

  it('changes when a column is renamed', () => {
    const renamed = ['Customer', 'Mobile', 'Email', 'Travel Date', 'Pax'];
    expect(fingerprint(renamed)).not.toBe(fingerprint(base));
  });
});
