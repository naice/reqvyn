/**
 * Dev-only mock of the VS Code webview host. Loaded by dev/index.html before src/main.tsx; never part
 * of the production bundle (vite build only uses src/main.tsx as input).
 *
 * Open `/dev/index.html?view=request|environment|container|runner` (add `&level=folder` for folders).
 */
import {
  createCollection,
  createEnvironment,
  createFolder,
  createRequest,
  type ExecutionResult,
  type HostToWebview,
  type WebviewToHost,
} from '@reqvyn/core';

const params = new URLSearchParams(location.search);
const view = (params.get('view') ?? 'request') as 'request' | 'environment' | 'container' | 'runner';
document.getElementById('root')!.dataset.view = view;

const send = (msg: HostToWebview, delay = 0) => setTimeout(() => window.postMessage(msg, '*'), delay);
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const request = createRequest({
  name: 'Get user',
  method: 'GET',
  url: '{{baseUrl}}/users/{{userId}}?expand=profile',
});
const environments = [
  { id: 'dev', name: 'Development', color: '#00E5FF' },
  { id: 'prod', name: 'Production', color: '#E040FB' },
];
let activeEnvironmentId: string | null = 'dev';

function requestState(dirty: boolean): HostToWebview {
  return {
    type: 'request:state',
    request,
    dirty,
    context: {
      collectionName: 'Demo API',
      path: ['Users'],
      inheritedHeaders: [{ key: 'X-Client', value: 'reqvyn', source: 'collection' }],
      inheritedAuth: { type: 'bearer', source: 'collection' },
      scratch: false,
    },
    environments,
    activeEnvironmentId,
    variables: [
      { key: 'baseUrl', value: 'https://api.example.com', source: 'environment', secret: false },
      { key: 'userId', value: '42', source: 'collection', secret: false },
      { key: 'token', value: '••••••', source: 'environment', secret: true },
    ],
    trusted: true,
  };
}

function fakeResult(req: { name: string; method: string; url: string }): ExecutionResult {
  const body = JSON.stringify({ id: 42, name: 'Ada Lovelace', roles: ['admin', 'dev'], profile: { city: 'London', active: true } });
  const startedAt = Date.now();
  return {
    requestId: request.id,
    requestName: req.name,
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: '1.1',
      headers: [
        ['content-type', 'application/json; charset=utf-8'],
        ['set-cookie', 'session=abc; Path=/; HttpOnly'],
      ],
      contentType: 'application/json; charset=utf-8',
      body: { base64: b64(body), size: body.length, truncated: false },
      timings: { startedAt, dnsMs: 4, connectMs: 12, tlsMs: 20, firstByteMs: 88, downloadMs: 6, totalMs: 94 },
      redirects: [],
      cookies: [{ name: 'session', value: 'abc', path: '/', httpOnly: true } as never],
      headersSize: 120,
      finalUrl: 'https://api.example.com/users/42?expand=profile',
      timeline: [],
      sentRequest: { method: req.method, url: 'https://api.example.com/users/42?expand=profile', headers: [['authorization', 'Bearer ••••••']] },
    },
    tests: [
      { id: 't1', name: 'Status code equals 200', passed: true, source: 'assertion' },
      { id: 't2', name: 'JSON value $.name exists', passed: true, source: 'assertion' },
      { id: 't3', name: 'Response time < 50', passed: false, message: 'Expected 94 < 50', source: 'assertion' },
    ],
    console: [{ level: 'log', args: ['pre-request ran'], timestamp: startedAt } as never],
    variableChanges: [{ scope: 'environment', key: 'lastUserId', value: '42' }],
  };
}

const collection = createCollection({ name: 'Demo API', description: 'Mock collection for the dev preview.' });
const folder = createFolder({ name: 'Users' });
const environment = createEnvironment({
  name: 'Development',
  color: '#00E5FF',
  variables: [
    { id: 'v1', key: 'baseUrl', value: 'https://api.example.com', enabled: true },
    { id: 'v2', key: 'token', value: '••••••', enabled: true, secret: true },
  ],
});

let runTimer: ReturnType<typeof setInterval> | undefined;

function startRun(): void {
  const names = ['List users', 'Get user', 'Create user', 'Delete user'];
  const total = names.length * 3;
  let completed = 0;
  runTimer = setInterval(() => {
    const i = completed % names.length;
    const result = fakeResult({ name: names[i]!, method: 'GET', url: '/' });
    send({
      type: 'runner:progress',
      progress: { iteration: Math.floor(completed / names.length) + 1, totalIterations: 3, completed: completed + 1, total, current: { requestId: `r${i}`, name: names[i]! }, result: { ...result, requestId: `r${i}`, iteration: 1, durationMs: 94 } },
    });
    completed++;
    if (completed >= total) finishRun(false, total);
  }, 250);
}

function finishRun(cancelled: boolean, total: number): void {
  clearInterval(runTimer);
  const now = new Date().toISOString();
  send({ type: 'runner:done', summary: { startedAt: now, finishedAt: now, durationMs: 3000, total, passed: total, failed: 0, skipped: 0, errored: 0, assertions: { passed: total * 2, failed: total }, cancelled } });
}

function handle(msg: WebviewToHost): void {
  console.debug('[mock host] ←', msg);
  switch (msg.type) {
    case 'ready':
      send({ type: 'init', view, brand: { iconUri: '' } });
      if (view === 'request') send(requestState(false));
      if (view === 'environment') send({ type: 'environment:state', environment, isGlobal: false, dirty: false });
      if (view === 'container') {
        if (params.get('level') === 'folder') send({ type: 'container:state', level: 'folder', folder, collectionName: 'Demo API', dirty: false });
        else send({ type: 'container:state', level: 'collection', collection, dirty: false });
      }
      if (view === 'runner')
        send({
          type: 'runner:config',
          config: { storeId: 's', collectionId: collection.id, collectionName: 'Demo API', requests: ['List users', 'Get user', 'Create user', 'Delete user'].map((name, i) => ({ id: `r${i}`, name, method: i === 2 ? 'POST' : i === 3 ? 'DELETE' : 'GET', path: 'Users' })) },
          environments,
          activeEnvironmentId,
          defaults: { iterations: 3, delayMs: 0, concurrency: 1, stopOnFailure: false },
        });
      break;
    case 'request:update':
      Object.assign(request, msg.request);
      break;
    case 'request:send':
      send({ type: 'response:started', startedAt: Date.now() });
      send({ type: 'response:result', result: fakeResult(msg.request) }, 600);
      break;
    case 'request:cancel':
      send({ type: 'response:cancelled' });
      break;
    case 'request:save':
    case 'request:saveAs':
      Object.assign(request, msg.request);
      send({ type: 'request:saved', request });
      send({ type: 'toast', level: 'info', message: `Saved “${msg.request.name}”` });
      break;
    case 'environment:select':
      activeEnvironmentId = msg.environmentId;
      send(requestState(false));
      break;
    case 'codegen':
      send({ type: 'codegen:result', target: msg.target, code: `curl -X ${msg.request.method} '${msg.request.url}'` });
      break;
    case 'file:pick':
      send({ type: 'file:picked', token: msg.token, path: 'C:/data/users.csv' });
      break;
    case 'environment:save':
      send({ type: 'environment:state', environment: msg.environment, isGlobal: false, dirty: false });
      break;
    case 'container:save':
      send({ type: 'toast', level: 'info', message: 'Saved' });
      break;
    case 'runner:start':
      startRun();
      break;
    case 'runner:cancel':
      finishRun(true, 0);
      break;
    default:
      break;
  }
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
  }
}

let state: unknown = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('reqvyn-dev-state') ?? 'null');
  } catch {
    return null;
  }
})();

window.acquireVsCodeApi = () => ({
  postMessage: (m) => handle(m as WebviewToHost),
  getState: () => state,
  setState: (s) => {
    state = s;
    try {
      sessionStorage.setItem('reqvyn-dev-state', JSON.stringify(s));
    } catch {
      /* ignore */
    }
  },
});
