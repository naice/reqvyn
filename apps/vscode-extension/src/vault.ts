import type * as vscode from 'vscode';
import type { SecretVault } from '@reqvyn/core';
import { secretKeys } from '@reqvyn/core';
import type { StoredToken, TokenStore } from '@reqvyn/auth-engine';

/** Prefix for every key REQVYN writes to VS Code SecretStorage (keeps it apart from other data). */
export const VAULT_PREFIX = 'reqvyn:';

/**
 * Secret vault backed by VS Code SecretStorage (OS keychain). Secret values never touch
 * collection/environment files, settings or globalState.
 */
export class VsCodeSecretVault implements SecretVault {
  constructor(private readonly storage: vscode.SecretStorage) {}

  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.storage.get(VAULT_PREFIX + name));
  }

  set(name: string, value: string): Promise<void> {
    return Promise.resolve(this.storage.store(VAULT_PREFIX + name, value));
  }

  delete(name: string): Promise<void> {
    return Promise.resolve(this.storage.delete(VAULT_PREFIX + name));
  }
}

/** OAuth 2.0 token cache stored in the vault (`oauth2.<cacheKey>`), serialized as JSON. */
export class VaultTokenStore implements TokenStore {
  constructor(private readonly vault: SecretVault) {}

  async get(key: string): Promise<StoredToken | undefined> {
    const raw = await this.vault.get(secretKeys.oauthToken(key));
    if (!raw) return undefined;
    try {
      const t = JSON.parse(raw) as StoredToken;
      return typeof t?.accessToken === 'string' ? t : undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, token: StoredToken): Promise<void> {
    return this.vault.set(secretKeys.oauthToken(key), JSON.stringify(token));
  }

  delete(key: string): Promise<void> {
    return this.vault.delete(secretKeys.oauthToken(key));
  }
}
