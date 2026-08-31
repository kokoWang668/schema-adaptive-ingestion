import { readFileSync } from 'node:fs';
import type { Row, Table } from './types.js';

/**
 * Minimal CSV reader for the fixtures.
 *
 * Production reads .xlsx via SheetJS. This exists only so the fixtures are
 * readable on GitHub; everything downstream sees the same { headers, rows }.
 */
export function readCsv(path: string): Table {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const [headerLine, ...rest] = lines;
  if (headerLine === undefined) return { headers: [], rows: [] };

  const headers = splitLine(headerLine);
  const rows: Row[] = rest.map((line) => {
    const cells = splitLine(line);
    const row: Row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === undefined) continue;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}
