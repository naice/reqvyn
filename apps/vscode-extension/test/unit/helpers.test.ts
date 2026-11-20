import { describe, expect, it } from 'vitest';
import { MemorySecretVault, createCollection, createEnvironment, createFolder, createRequest, kv, secretKeys, type HttpResponseData } from '@reqvyn/core';
import { relativeTime, methodIcon } from '../../src/trees.js';
import { extensionFor, responseDocument, responseText } from '../../src/responses.js';
import { folderPaths } from '../../src/pickers.js';
import { vaultCollectionSecrets, vaultEnvironmentSecrets } from '../../src/commands.js';
import { VAULT_PREFIX, VaultTokenStore, VsCodeSecretVault } from '../../src/vault.js';
import { webviewHtml } from '../../src/webview.js';
import { Uri } from './vscode.mock.js';

function response(contentType: string, body: string): HttpResponseData {
  return {
    status: 200,
    statusText: 'OK',
    httpVersion: '1.1',
    headers: [['content-type', contentType]],
    contentType,
    body: { base64: Buffer.from(body).toString('base64'), size: body.length, truncated: false },
  } as unknown as HttpResponseData;
}

describe('trees helpers', () => {
  it('formats relative times', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(relativeTime(new Date(now - 10_000), now)).toBe('just now');
    expect(relativeTime(new Date(now - 5 * 60_000), now)).toBe('5 min ago');
    expect(relativeTime(new Date(now - 3 * 3_600_000), now)).toBe('3 h ago');
    expect(relativeTime(new Date(now - 3 * 86_400_000), now)).toBe(new Date(now - 3 * 86_400_000).toLocaleDateString());
  });

  it('colours known HTTP methods and leaves unknown ones neutral', () => {
    expect(methodIcon('get').color).toBeDefined();
    expect(methodIcon('BREW').color).toBeUndefined();
  });
});

describe('response documents', () => {
  it('maps content types to languages', () => {
    expect(extensionFor('application/problem+json; charset=utf-8')).toEqual({ ext: 'json', language: 'json' });
    expect(extensionFor('text/html')).toEqual({ ext: 'html', language: 'html' });
    expect(extensionFor('application/octet-stream')).toEqual({ ext: 'txt', language: 'plaintext' });
  });

  it('pretty-prints JSON and keeps invalid JSON verbatim', () => {
    expect(responseText(response('application/json', '{"a":1}'))).toBe('{\n  "a": 1\n}\n');
    expect(responseText(response('application/json', '{oops'))).toBe('{oops');
  });

  it('renders status line and headers for comparisons', () => {
    expect(responseDocument(response('text/plain', 'hi'))).toBe('HTTP/1.1 200 OK\ncontent-type: text/plain\n\nhi');
  });
});

describe('folderPaths', () => {
  it('builds sorted breadcrumb paths and survives parent cycles', () => {
    const a = createFolder({ name: 'A' });
    const b = createFolder({ name: 'B', parentId: a.id });
    const x = createFolder({ name: 'X' });
    const y = createFolder({ name: 'Y', parentId: x.id });
    x.parentId = y.id; // corrupt cycle
    const paths = folderPaths(createCollection({ folders: [b, a, x, y] }));
    expect(paths.find((p) => p.id === b.id)?.path).toBe('A / B');
    expect(paths.map((p) => p.path)).toEqual([...paths.map((p) => p.path)].sort((l, r) => l.localeCompare(r)));
    expect(paths.find((p) => p.id === y.id)?.path).toBe('X / Y');
  });
});

describe('vaulting secrets on import', () => {
  it('moves inline auth secrets of collection, folders and requests into the vault', async () => {
    const vault = new MemorySecretVault();
    const folder = createFolder({ auth: { type: 'bearer', token: 'folder-token', prefix: 'Bearer' } });
    const request = createRequest({ auth: { type: 'basic', username: 'u', password: 'p4ss' } });
    const templated = createRequest({ auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' } });
    const c = createCollection({ auth: { type: 'bearer', token: 'col-token', prefix: 'Bearer' }, folders: [folder], requests: [request, templated] });

    const { collection, moved } = await vaultCollectionSecrets(c, vault);

    expect(moved).toBe(3);
    expect(JSON.stringify(collection)).not.toMatch(/folder-token|col-token|p4ss/);
    const reqAuth = collection.requests[0]!.auth as { password: string };
    const name = /\{\{\$secret:(.+)\}\}/.exec(reqAuth.password)![1]!;
    expect(await vault.get(secretKeys.named(name))).toBe('p4ss');
    expect((collection.requests[1]!.auth as { token: string }).token).toBe('{{token}}');
    // input is not mutated
    expect((c.requests[0]!.auth as { password: string }).password).toBe('p4ss');
  });

  it('stores secret environment rows under the environment key', async () => {
    const vault = new MemorySecretVault();
    const env = createEnvironment({ variables: [kv('apiKey', 'k-123', { secret: true }), kv('host', 'example.com'), kv('empty', '', { secret: true })] });
    expect(await vaultEnvironmentSecrets(env, vault)).toBe(1);
    expect(await vault.get(secretKeys.environmentVariable(env.id, 'apiKey'))).toBe('k-123');
    expect(await vault.get(secretKeys.environmentVariable(env.id, 'host'))).toBeUndefined();
  });
});

describe('SecretStorage vault', () => {
  const storage = () => {
    const m = new Map<string, string>();
    return {
      m,
      get: async (k: string) => m.get(k),
      store: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
      keys: async () => [...m.keys()],
      onDidChange: () => ({ dispose() {} }),
    };
  };

  it('namespaces every key', async () => {
    const s = storage();
    const vault = new VsCodeSecretVault(s as never);
    await vault.set('named.x', 'v');
    expect([...s.m.keys()]).toEqual([`${VAULT_PREFIX}named.x`]);
    expect(await vault.get('named.x')).toBe('v');
    await vault.delete('named.x');
    expect(s.m.size).toBe(0);
  });

  it('ignores corrupt OAuth token entries', async () => {
    const vault = new MemorySecretVault();
    const tokens = new VaultTokenStore(vault);
    await vault.set(secretKeys.oauthToken('k'), '{not json');
    expect(await tokens.get('k')).toBeUndefined();
    await vault.set(secretKeys.oauthToken('k'), JSON.stringify({ nope: 1 }));
    expect(await tokens.get('k')).toBeUndefined();
  });
});

describe('webview shell', () => {
  it('uses a strict nonce-based CSP and escapes the title', () => {
    const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u: { path: string }) => `res:${u.path}` };
    const html = webviewHtml(webview as never, Uri.file('/ext') as never, 'request', '<script>x</script>');
    const csp = /content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<script type="module" nonce="${nonce}" src="res:/ext/dist/webview/webview.js">`);
    expect(html).toContain('<title>&lt;script&gt;x&lt;/script&gt;</title>');
    expect(webviewHtml(webview as never, Uri.file('/ext') as never, 'request', 't')).not.toContain(nonce);
  });
});
