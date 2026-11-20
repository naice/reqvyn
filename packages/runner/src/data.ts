import { ReqvynError } from '@reqvyn/shared';

export type DataRow = Record<string, string>;

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM). First row is the header. */
export function parseCsv(text: string, delimiter = ','): DataRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new ReqvynError('VALIDATION', 'CSV data file has an unterminated quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0]!.map((h) => h.trim());
  if (header.some((h) => !h)) throw new ReqvynError('VALIDATION', 'CSV data file has an empty column name in the header row.');
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

/** JSON data file: an array of flat objects. Non-string values are stringified (objects as JSON). */
export function parseJsonData(text: string): DataRow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ReqvynError('VALIDATION', 'JSON data file is not valid JSON.', { cause: e });
  }
  if (!Array.isArray(data)) throw new ReqvynError('VALIDATION', 'JSON data file must contain an array of objects.');
  return data.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ReqvynError('VALIDATION', `JSON data row ${i + 1} is not an object.`);
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  });
}

export function parseDataFile(fileName: string, text: string): DataRow[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return parseJsonData(text);
  if (lower.endsWith('.csv')) return parseCsv(text);
  if (lower.endsWith('.tsv')) return parseCsv(text, '\t');
  throw new ReqvynError('VALIDATION', `Unsupported data file "${fileName}". Use .csv, .tsv or .json.`);
}
