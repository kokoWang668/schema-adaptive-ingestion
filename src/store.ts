import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Mapping } from './types.js';

export interface MappingStore {
  get(fingerprint: string): Mapping | undefined;
  set(fingerprint: string, mapping: Mapping): void;
}

/**
 * fingerprint -> mapping, backed by a JSON file (or memory, if no path given).
 *
 * A real deployment puts this in Postgres or Redis; the interface is the same
 * two methods either way. What matters is that set() OVERWRITES: re-inference
 * after drift replaces the bad mapping, so the layout goes back on the hot path
 * instead of paying for a model call on every subsequent file.
 */
export function createStore(file?: string): MappingStore {
  const cache: Record<string, Mapping> =
    file !== undefined && existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Mapping>)
      : {};

  return {
    get: (fp) => cache[fp],
    set: (fp, mapping) => {
      cache[fp] = mapping;
      if (file !== undefined) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
      }
    },
  };
}
