import type { SecretVault } from '@reqvyn/core';

export const SECRET_ENV_PREFIX = 'REQVYN_SECRET_';

/** `my-api.Token` → `MY_API_TOKEN`. */
export const toEnvName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Secret vault for headless runs. Values come from CI environment variables (`REQVYN_SECRET_<NAME>`) and,
 * optionally, a JSON secrets file. Nothing is ever written to disk; tokens obtained during a run (OAuth 2.0)
 * live in memory only.
 *
 * Lookup order for a vault key:
 * - `env.<envId>.<key>`  → REQVYN_SECRET_<ENVNAME>_<KEY>, then REQVYN_SECRET_<KEY>
 * - `global.<key>`       → REQVYN_SECRET_<KEY>
 * - `named.<name>`       → REQVYN_SECRET_<NAME>   (used by {{$secret:name}})
 * - anything else        → REQVYN_SECRET_<FULL_KEY>
 * The secrets file may contain either full vault keys or the short names above.
 */
export class EnvSecretVault implements SecretVault {
  private readonly memory = new Map<string, string>();
  private readonly deleted = new Set<string>();

  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly file: Record<string, string> = {},
    private readonly environmentNames: Map<string, string> = new Map(),
  ) {}

  /** Candidate short names for a vault key, most specific first. */
  candidates(key: string): string[] {
    const parts = key.split('.');
    if (parts[0] === 'env' && parts.length >= 3) {
      const envName = this.environmentNames.get(parts[1]!);
      const k = parts.slice(2).join('.');
      return envName ? [`${envName}_${k}`, k] : [k];
    }
    if ((parts[0] === 'global' || parts[0] === 'named') && parts.length >= 2) return [parts.slice(1).join('.')];
    return [key];
  }

  async get(key: string): Promise<string | undefined> {
    if (this.deleted.has(key)) return undefined;
    if (this.memory.has(key)) return this.memory.get(key);
    if (key in this.file) return this.file[key];
    for (const c of this.candidates(key)) {
      if (c in this.file) return this.file[c];
      const v = this.env[SECRET_ENV_PREFIX + toEnvName(c)];
      if (v !== undefined) return v;
    }
    return undefined;
  }
  async set(key: string, value: string): Promise<void> {
    this.deleted.delete(key);
    this.memory.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    this.deleted.add(key);
  }
}
