import type { Auth, OAuth2Config } from '@reqvyn/core';
import type { SendOptions } from '@reqvyn/http-engine';

/** Concrete (non-inherited) authentication configuration. */
export type ConcreteAuth = Exclude<Auth, { type: 'inherit' }>;

export interface StoredToken {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  obtainedAt: number;
}

/** Persistent token cache. The extension backs this with VS Code SecretStorage. */
export interface TokenStore {
  get(key: string): Promise<StoredToken | undefined>;
  set(key: string, token: StoredToken): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, StoredToken>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, token: StoredToken) {
    this.map.set(key, token);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

/** UI hooks for interactive flows. Absent in non-interactive environments (CLI, CI). */
export interface InteractiveHooks {
  /** Open the authorization URL in the user's browser. */
  openBrowser(url: string): Promise<void>;
  /** Show the device code to the user. */
  showDeviceCode?(prompt: DeviceCodePrompt): void;
}

export interface AuthContext {
  /** Interpolates variables in auth fields. */
  resolve: (text: string) => string;
  tokenStore?: TokenStore;
  interactive?: InteractiveHooks;
  /** Options (proxy, TLS) used for token endpoint requests. */
  sendOptions?: SendOptions;
  signal?: AbortSignal;
  /** Base directory to resolve relative certificate paths. */
  baseDir?: string;
  /** Diagnostic log. Never receives secret values. */
  log?: (message: string) => void;
  /** Time source (tests). */
  now?: () => number;
}

export interface AuthRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** Full body bytes if available (needed for AWS SigV4 payload hashing). */
  bodyBytes?: Buffer;
  /** Opens the body stream when bytes are not in memory. */
  openBody?: () => NodeJS.ReadableStream;
}

export interface AuthResult {
  url: string;
  headers: Array<[string, string]>;
  /** TLS client certificate material (clientcert auth). */
  tls?: { cert?: Buffer; key?: Buffer; pfx?: Buffer; passphrase?: string };
  /** Human-readable description for the timeline (never contains secrets). */
  description: string;
}

export type { OAuth2Config };
