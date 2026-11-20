import { newId, isSensitiveKey } from '@reqvyn/shared';
import type { KeyValue } from '@reqvyn/core';

/** Parse a `.env` file (KEY=value, optional `export`, quotes, escapes in double quotes, comments). */
export function parseDotEnv(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) {
      // support multi-line double-quoted values
      let full = value.slice(1);
      while (!/(^|[^\\])"\s*(#.*)?$/.test(full) && i + 1 < lines.length) full += '\n' + lines[++i];
      full = full.replace(/"\s*(#.*)?$/, '');
      value = full.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'")) {
      value = value.slice(1).replace(/'\s*(#.*)?$/, '');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out.push({ key, value });
  }
  return out;
}

export function dotEnvToVariables(text: string, opts: { markSensitiveAsSecret?: boolean } = {}): KeyValue[] {
  return parseDotEnv(text).map(({ key, value }) => ({
    id: newId(),
    key,
    value,
    enabled: true,
    secret: opts.markSensitiveAsSecret && isSensitiveKey(key) ? true : undefined,
  }));
}

/** Serialize variables to `.env`. Secret values are omitted unless `includeSecrets` is set. */
export function variablesToDotEnv(vars: KeyValue[], opts: { includeSecrets?: boolean; secretValues?: Map<string, string> } = {}): string {
  const lines: string[] = [];
  for (const v of vars) {
    if (!v.key) continue;
    let value = v.value;
    if (v.secret) {
      if (!opts.includeSecrets) {
        lines.push(`# ${v.key} is a secret – value not exported`);
        lines.push(`${v.key}=`);
        continue;
      }
      value = opts.secretValues?.get(v.key) ?? '';
    }
    const needsQuotes = /[\s#"'\\]/.test(value) || value.includes('\n');
    const encoded = needsQuotes ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : value;
    lines.push(`${v.enabled ? '' : '# '}${v.key}=${encoded}`);
  }
  return lines.join('\n') + '\n';
}
