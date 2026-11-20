import { ReqvynError } from '@reqvyn/shared';

export interface OptionSpec {
  /** Long name without dashes, e.g. "env". */
  name: string;
  alias?: string;
  /** Flags take no value. */
  type: 'string' | 'flag';
  /** Repeatable options collect all values (comma-separated values are split). */
  multiple?: boolean;
  description: string;
  valueName?: string;
}

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | string[] | boolean | undefined>;
}

/** Minimal, dependency-free argument parser (`--key value`, `--key=value`, `-k value`, `--no-flag`, `--`). */
export function parseArgs(argv: string[], specs: OptionSpec[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const byAlias = new Map(specs.filter((s) => s.alias).map((s) => [s.alias!, s]));
  const options: ParsedArgs['options'] = {};
  const positionals: string[] = [];
  const set = (spec: OptionSpec, value: string | boolean) => {
    if (spec.multiple && typeof value === 'string') {
      const prev = (options[spec.name] as string[] | undefined) ?? [];
      options[spec.name] = [...prev, ...value.split(',').map((v) => v.trim()).filter(Boolean)];
    } else options[spec.name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2)) {
      let key = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
      let inline: string | undefined;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        inline = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      const spec = arg.startsWith('--') ? byName.get(key) : byAlias.get(key);
      if (!spec && key.startsWith('no-') && byName.get(key.slice(3))?.type === 'flag') {
        options[key.slice(3)] = false;
        continue;
      }
      if (!spec) throw new ReqvynError('VALIDATION', `Unknown option "${arg}".`, { hint: 'Run "reqvyn help" for usage.' });
      if (spec.type === 'flag') {
        set(spec, inline === undefined ? true : !/^(false|0|no)$/i.test(inline));
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) throw new ReqvynError('VALIDATION', `Option "--${spec.name}" requires a value.`);
      set(spec, value);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, options };
}

export const str = (o: ParsedArgs, name: string): string | undefined => {
  const v = o.options[name];
  return typeof v === 'string' ? v : undefined;
};
export const list = (o: ParsedArgs, name: string): string[] => {
  const v = o.options[name];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
};
export const flag = (o: ParsedArgs, name: string): boolean | undefined => {
  const v = o.options[name];
  return typeof v === 'boolean' ? v : undefined;
};
export function int(o: ParsedArgs, name: string, min = 0): number | undefined {
  const v = str(o, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new ReqvynError('VALIDATION', `Option "--${name}" must be an integer ≥ ${min}, got "${v}".`);
  return n;
}

export function formatOptions(specs: OptionSpec[]): string {
  const rows = specs.map((s) => {
    const left = `${s.alias ? `-${s.alias}, ` : '    '}--${s.name}${s.type === 'string' ? ` <${s.valueName ?? 'value'}>` : ''}`;
    return [left, s.description] as const;
  });
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  return rows.map(([l, d]) => `  ${l.padEnd(w)}${d}`).join('\n');
}
