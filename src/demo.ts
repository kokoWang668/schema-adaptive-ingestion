import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readCsv } from './csv.js';
import { ingest } from './ingest.js';
import { countingProvider, OfflineProvider } from './providers.js';
import { createStore } from './store.js';

const CACHE_FILE = '.cache/mappings.json';
const FIXTURES = 'fixtures';

// Start from an empty cache so the printed path per file is reproducible.
rmSync('.cache', { recursive: true, force: true });

const store = createStore(CACHE_FILE);
const { provider, calls } = countingProvider(new OfflineProvider());

const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.csv'))
  .sort();

console.log('file                        fingerprint       path   model calls');
console.log('-'.repeat(72));

for (const file of files) {
  const before = calls();
  const result = await ingest(readCsv(join(FIXTURES, file)), { store, provider });
  const label = { cold: 'COLD ', hot: 'HOT  ', drift: 'DRIFT' }[result.path];
  console.log(
    `${file.padEnd(28)}${result.fingerprint}  ${label}  ${calls() - before}   ` +
      `${JSON.stringify(result.records[0])}`,
  );
}

console.log('-'.repeat(72));
console.log(`${files.length} files, ${calls()} model call(s) total.`);
