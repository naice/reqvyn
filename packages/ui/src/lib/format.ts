/**
 * Formatting helpers for request bodies. JSON formatting tolerates `{{variables}}` both inside
 * strings and as bare values (e.g. `{"id": {{userId}}}`).
 */

export function formatJson(text: string, indent = 2): string {
  const vars: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString && ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end > 0) {
        vars.push(text.slice(i, end + 2));
        // Emit JSON escape sequences (not raw control chars, which JSON.parse rejects inside strings).
        out += `"\\u0000RQV${vars.length - 1}\\u0000"`;
        i = end + 1;
        continue;
      }
    }
    if (inString && ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end > 0 && !text.slice(i, end).includes('"')) {
        vars.push(text.slice(i, end + 2));
        out += `\\u0001RQV${vars.length - 1}\\u0001`;
        i = end + 1;
        continue;
      }
    }
    if (ch === '"' && !isEscaped(text, i)) inString = !inString;
    out += ch;
  }
  const parsed: unknown = JSON.parse(out);
  let formatted = JSON.stringify(parsed, null, indent);
  formatted = formatted.replace(/"\\u0000RQV(\d+)\\u0000"/g, (_, n: string) => vars[Number(n)] ?? '');
  formatted = formatted.replace(/\\u0001RQV(\d+)\\u0001/g, (_, n: string) => vars[Number(n)] ?? '');
  return formatted;
}

function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

export function tryFormatJson(text: string): string | null {
  try {
    return formatJson(text);
  } catch {
    return null;
  }
}

/** Minimal, dependency-free XML pretty printer (keeps text nodes, CDATA, comments and PIs intact). */
export function formatXml(xml: string, indent = '  '): string {
  const tokens = xml
    .replace(/>\s+</g, '><')
    .trim()
    .match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[^>]+>|[^<]+/g);
  if (!tokens) return xml;
  let depth = 0;
  const lines: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push(indent.repeat(depth) + t);
    } else if (t.startsWith('<') && !t.startsWith('<?') && !t.startsWith('<!') && !t.endsWith('/>')) {
      // <a>text</a> stays on one line
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      if (next !== undefined && !next.startsWith('<') && after?.startsWith('</')) {
        lines.push(indent.repeat(depth) + t + next.trim() + after);
        i += 2;
        continue;
      }
      lines.push(indent.repeat(depth) + t);
      depth++;
    } else if (t.startsWith('<')) {
      lines.push(indent.repeat(depth) + t);
    } else {
      const s = t.trim();
      if (s) lines.push(indent.repeat(depth) + s);
    }
  }
  return lines.join('\n');
}

export type StatusClass = 'info' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'unknown';

export function statusClass(status: number): StatusClass {
  if (status >= 100 && status < 200) return 'info';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'client-error';
  if (status >= 500 && status < 600) return 'server-error';
  return 'unknown';
}
