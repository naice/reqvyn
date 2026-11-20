import { afterAll, describe, expect, it } from 'vitest';
import { runScript, ScriptSandboxPool, type ResponseContext, type ScriptRunOptions } from '../src/index.js';

const request = { method: 'POST', url: 'https://api.example.com/users', headers: [['Content-Type', 'application/json']] as Array<[string, string]>, body: '{"a":1}' };

const response: ResponseContext = {
  status: 200,
  statusText: 'OK',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Trace', 't-1'],
  ],
  bodyText: JSON.stringify({ id: 7, name: 'Ada', tags: ['x', 'y'], nested: { deep: { v: 1 } } }),
  timeMs: 150,
  size: 64,
  cookies: [{ name: 'sid', value: 'abc' }],
  contentType: 'application/json',
};

function pre(code: string, extra: Partial<ScriptRunOptions> = {}) {
  return runScript({ code, phase: 'pre', request, variables: { baseUrl: 'https://api.example.com', shared: 'snap' }, ...extra });
}
function post(code: string, extra: Partial<ScriptRunOptions> = {}) {
  return runScript({ code, phase: 'post', request, response, variables: {}, ...extra });
}

describe('runScript – variables', () => {
  it('records environment, runtime, collection and global changes', async () => {
    const r = await pre(`
      reqvyn.env.set('token', 'abc');
      reqvyn.env.set('num', 5);
      reqvyn.env.set('obj', { a: 1 });
      reqvyn.variables.set('rt', 'r1');
      reqvyn.collectionVariables.set('c', 'cv');
      reqvyn.globals.set('g', 'gv');
      reqvyn.globals.unset('old');
      reqvyn.env.set('token', 'final');
    `);
    expect(r.error).toBeUndefined();
    expect(r.variableChanges).toEqual([
      { scope: 'environment', key: 'token', value: 'final' },
      { scope: 'environment', key: 'num', value: '5' },
      { scope: 'environment', key: 'obj', value: '{"a":1}' },
      { scope: 'runtime', key: 'rt', value: 'r1' },
      { scope: 'collection', key: 'c', value: 'cv' },
      { scope: 'global', key: 'g', value: 'gv' },
      { scope: 'global', key: 'old', value: null },
    ]);
  });

  it('reads from scopes and the visible snapshot with changes applied', async () => {
    const r = await pre(
      `
      const out = {
        env: reqvyn.env.get('host'),
        envHas: reqvyn.env.has('host'),
        missing: reqvyn.env.get('nope'),
        snap: reqvyn.variables.get('shared'),
        coll: reqvyn.collectionVariables.get('c'),
      };
      reqvyn.variables.set('shared', 'changed');
      out.afterSet = reqvyn.variables.get('shared');
      reqvyn.env.set('host', 'h2');
      out.envAfter = reqvyn.env.get('host');
      reqvyn.env.unset('host');
      out.envUnset = reqvyn.env.get('host');
      out.replaced = reqvyn.variables.replaceIn('{{baseUrl}}/x/{{shared}}/{{unknown}}');
      console.log(JSON.stringify(out));
    `,
      { scopes: { environment: { host: 'h1' }, collection: { c: 'cv' } } },
    );
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.console[0]!.message)).toEqual({
      env: 'h1',
      envHas: true,
      snap: 'snap',
      coll: 'cv',
      afterSet: 'changed',
      envAfter: 'h2',
      replaced: 'https://api.example.com/x/changed/{{unknown}}',
    });
  });

  it('rejects invalid variable names', async () => {
    const r = await pre(`reqvyn.env.set('', 'x')`);
    expect(r.error?.message).toMatch(/non-empty string/);
  });
});

describe('runScript – request modification', () => {
  it('modifies method, url, headers and body in the pre phase', async () => {
    const r = await pre(`
      reqvyn.request.method = 'put';
      reqvyn.request.url = reqvyn.request.url + '?x=1';
      reqvyn.request.headers.set('Authorization', 'Bearer ' + reqvyn.variables.get('shared'));
      reqvyn.request.headers.set('content-type', 'text/plain');
      reqvyn.request.headers.remove('X-None');
      reqvyn.request.body = JSON.stringify({ changed: true });
      console.log(reqvyn.request.headers.get('CONTENT-TYPE'), JSON.stringify(reqvyn.request.headers.toObject()));
    `);
    expect(r.error).toBeUndefined();
    expect(r.request).toEqual({
      method: 'PUT',
      url: 'https://api.example.com/users?x=1',
      headers: [
        ['content-type', 'text/plain'],
        ['Authorization', 'Bearer snap'],
      ],
      body: '{"changed":true}',
    });
    expect(r.console[0]!.message).toBe('text/plain {"content-type":"text/plain","Authorization":"Bearer snap"}');
    // original request object untouched
    expect(request.method).toBe('POST');
  });

  it('rejects header injection and invalid names', async () => {
    expect((await pre(`reqvyn.request.headers.set('X-A', 'a\\r\\nX-B: b')`)).error?.message).toMatch(/line breaks/);
    expect((await pre(`reqvyn.request.headers.set('Bad Header', 'v')`)).error?.message).toMatch(/Invalid header name/);
  });

  it('makes the request read-only in the post phase', async () => {
    const r = await post(`reqvyn.request.url = 'https://evil';`);
    expect(r.error?.message).toMatch(/only be modified in pre-request scripts/);
    expect(r.request.url).toBe(request.url);
  });

  it('supports skipRequest in pre phase only', async () => {
    expect((await pre(`reqvyn.skipRequest()`)).skipRequest).toBe(true);
    expect((await pre(`1`)).skipRequest).toBeUndefined();
    expect((await post(`reqvyn.skipRequest()`)).error?.message).toMatch(/pre-request/);
  });
});

describe('runScript – response tests', () => {
  it('captures passing, failing and async tests in order', async () => {
    const r = await post(`
      reqvyn.test('status is 200', () => { reqvyn.expect(reqvyn.response.status).toBe(200); });
      reqvyn.test('status is 404', () => { reqvyn.expect(reqvyn.response.status).toBe(404); });
      reqvyn.test('async pass', async () => { await reqvyn.sleep(20); reqvyn.expect(reqvyn.response.json().name).toEqual('Ada'); });
      reqvyn.test('async fail', async () => { await reqvyn.sleep(5); throw new Error('boom'); });
      reqvyn.test('promise', () => new Promise((res) => setTimeout(res, 10)));
      reqvyn.test('header', () => reqvyn.expect(reqvyn.response.headers.get('x-trace')).toBe('t-1'));
      reqvyn.test('cookie', () => reqvyn.expect(reqvyn.response.cookies.get('sid')).toBe('abc'));
      reqvyn.test('meta', () => {
        reqvyn.expect(reqvyn.response.time).toBeLessThan(1000);
        reqvyn.expect(reqvyn.response.size).toBe(64);
        reqvyn.expect(reqvyn.response.statusText).toBe('OK');
        reqvyn.expect(reqvyn.response.text()).toContain('Ada');
        reqvyn.expect(reqvyn.info.phase).toBe('post');
      });
    `);
    expect(r.error).toBeUndefined();
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['status is 200', true],
      ['status is 404', false],
      ['async pass', true],
      ['async fail', false],
      ['promise', true],
      ['header', true],
      ['cookie', true],
      ['meta', true],
    ]);
    expect(r.tests[1]!.message).toBe('Expected 200 to be 404');
    expect(r.tests[3]!.message).toBe('boom');
    expect(r.tests.every((t) => t.source === 'script')).toBe(true);
  });

  it('supports the full expect matcher set with .not', async () => {
    const r = await post(`
      const d = reqvyn.response.json();
      const e = reqvyn.expect;
      reqvyn.test('matchers', () => {
        e(1).toBe(1); e({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
        e('hello').toContain('ell'); e([1, 2, { x: 1 }]).toContain({ x: 1 });
        e('abc').toMatch(/b/); e('abc').toMatch('bc');
        e(5).toBeGreaterThan(4); e(5).toBeGreaterThanOrEqual(5); e(5).toBeLessThan(6); e(5).toBeLessThanOrEqual(5);
        e(0).toBeDefined(); e(undefined).toBeUndefined(); e(null).toBeNull();
        e(1).toBeTruthy(); e('').toBeFalsy();
        e(d).toHaveProperty('nested.deep.v'); e(d).toHaveProperty('nested.deep.v', 1); e(d).toHaveProperty(['tags', '1'], 'y');
        e(d.tags).toHaveLength(2); e('abc').toHaveLength(3);
        e(d.status).toBeUndefined(); e(200).toBeOneOf([200, 201]);
        e(1).not.toBe(2); e({ a: 1 }).not.toEqual({ a: 2 }); e('x').not.toContain('y'); e(null).not.toBeDefined === undefined;
        e(d).not.toHaveProperty('missing'); e(3).not.toBeOneOf([1, 2]);
      });
      reqvyn.test('fail eq', () => e({ a: 1 }).toEqual({ a: 2 }));
      reqvyn.test('fail not', () => e(1).not.toBe(1));
      reqvyn.test('fail prop', () => e(d).toHaveProperty('nested.deep.v', 2));
      reqvyn.test('fail len', () => e([1]).toHaveLength(2));
      reqvyn.test('fail type', () => e('5').toBeGreaterThan(1));
      reqvyn.test('json invalid', () => { throw new Error('x'); });
    `);
    expect(r.error).toBeUndefined();
    expect(r.tests[0]).toMatchObject({ name: 'matchers', passed: true });
    expect(r.tests[1]!.message).toBe('Expected {"a":1} to equal {"a":2}');
    expect(r.tests[2]!.message).toBe('Expected 1 not to be 1');
    expect(r.tests[3]!.message).toContain('found 1');
    expect(r.tests[4]!.message).toContain('length is 1');
    expect(r.tests[5]!.message).toMatch(/to be a number/);
  });

  it('reports invalid response JSON clearly', async () => {
    const r = await runScript({
      code: `reqvyn.test('json', () => reqvyn.response.json());`,
      phase: 'post',
      request,
      response: { ...response, bodyText: '<html>' },
      variables: {},
    });
    expect(r.tests[0]!.passed).toBe(false);
    expect(r.tests[0]!.message).toMatch(/Response body is not valid JSON/);
  });

  it('awaits top-level await and pending tests', async () => {
    const r = await post(`
      await reqvyn.sleep(10);
      reqvyn.env.set('after', 'sleep');
      reqvyn.test('later', async () => { await reqvyn.sleep(30); reqvyn.test('nested', () => {}); });
    `);
    expect(r.variableChanges).toEqual([{ scope: 'environment', key: 'after', value: 'sleep' }]);
    expect(r.tests.map((t) => t.name)).toEqual(['later', 'nested']);
    expect(r.tests.every((t) => t.passed)).toBe(true);
  });

  it('caps sleep at 2000ms', async () => {
    const started = Date.now();
    const r = await post(`await reqvyn.sleep(60000);`, { timeoutMs: 4000 });
    expect(r.error).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3800);
  });
});

describe('runScript – pm compatibility alias', () => {
  it('supports pm variables, tests and chai-style expect', async () => {
    const r = await post(
      `
      pm.environment.set('pmEnv', 'e');
      pm.variables.set('pmVar', 'v');
      pm.collectionVariables.set('pmColl', 'c');
      pm.globals.set('pmGlob', 'g');
      pm.environment.unset('gone');
      const json = pm.response.json();
      pm.test('Status code is 200', function () { pm.response.to.have.status(200); });
      pm.test('chai subset', function () {
        pm.expect(pm.response.code).to.equal(200);
        pm.expect(pm.response.status).to.equal('OK');
        pm.expect(json).to.eql({ id: 7, name: 'Ada', tags: ['x', 'y'], nested: { deep: { v: 1 } } });
        pm.expect(json.tags).to.include('x');
        pm.expect(json.name).to.be.a('string');
        pm.expect(json).to.have.property('id', 7);
        pm.expect(json).to.have.property('nested').that.has.property('deep');
        pm.expect(true).to.be.true;
        pm.expect(false).to.be.false;
        pm.expect(json.id).to.exist;
        pm.expect(json.id).to.be.above(1).and.to.be.below(10);
        pm.expect(json.name).to.not.equal('Bob');
        pm.expect(pm.response.responseTime).to.be.below(1000);
        pm.expect(pm.response.headers.get('Content-Type')).to.include('json');
        pm.expect(pm.response).to.have.status(200);
        pm.expect(json.tags).to.have.lengthOf(2);
        pm.expect(json.missing).to.not.exist;
        pm.response.to.be.ok;
        pm.expect(pm.environment.get('pmEnv')).to.equal('e');
      });
      pm.test('fails', () => pm.expect(json.id).to.equal(8));
      pm.test('status fails', () => pm.response.to.have.status(404));
      pm.test('unsupported', () => pm.expect(1).to.be.frobnicated);
    `,
      { scopes: { environment: {} } },
    );
    expect(r.error).toBeUndefined();
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['Status code is 200', true],
      ['chai subset', true],
      ['fails', false],
      ['status fails', false],
      ['unsupported', false],
    ]);
    expect(r.tests[2]!.message).toBe('expected 7 to equal 8');
    expect(r.tests[3]!.message).toBe('expected response to have status code 404 but got 200');
    expect(r.tests[4]!.message).toMatch(/unsupported assertion "\.frobnicated"/);
    expect(r.variableChanges).toEqual([
      { scope: 'environment', key: 'pmEnv', value: 'e' },
      { scope: 'runtime', key: 'pmVar', value: 'v' },
      { scope: 'collection', key: 'pmColl', value: 'c' },
      { scope: 'global', key: 'pmGlob', value: 'g' },
      { scope: 'environment', key: 'gone', value: null },
    ]);
  });

  it('supports pm.request in the pre phase and btoa/atob', async () => {
    const r = await pre(`
      pm.request.headers.add({ key: 'Authorization', value: 'Basic ' + btoa('user:pass') });
      pm.request.headers.upsert({ key: 'X-Up', value: '1' });
      console.log(atob(btoa('héllo')), pm.info.eventName, pm.request.method);
    `);
    expect(r.error).toBeUndefined();
    expect(r.request.headers).toContainEqual(['Authorization', 'Basic dXNlcjpwYXNz']);
    expect(r.request.headers).toContainEqual(['X-Up', '1']);
    expect(r.console[0]!.message).toBe('héllo prerequest POST');
  });
});

describe('runScript – console', () => {
  it('captures levels, formats values and redacts secrets', async () => {
    const r = await pre(
      `
      console.log('token is', reqvyn.variables.get('secretToken'));
      console.info({ a: 1, self: undefined });
      console.warn([1, 'two']);
      console.error(new Error('bad'));
      const cyc = { n: 1 }; cyc.me = cyc; console.log(cyc);
      reqvyn.test('uses ' + reqvyn.variables.get('secretToken'), () => { throw new Error('leak ' + reqvyn.variables.get('secretToken')); });
      throw new Error('fatal ' + reqvyn.variables.get('secretToken'));
    `,
      { variables: { secretToken: 'sup3r-s3cret' }, secrets: ['sup3r-s3cret'] },
    );
    expect(r.console.map((c) => [c.level, c.message])).toEqual([
      ['log', 'token is ••••••'],
      ['info', '{"a":1,"self":"[undefined]"}'],
      ['warn', '[1,"two"]'],
      ['error', 'Error: bad'],
      ['log', '{"n":1,"me":"[Circular]"}'],
    ]);
    expect(JSON.stringify(r)).not.toContain('sup3r-s3cret');
    expect(r.tests[0]!.name).toBe('uses ••••••');
    expect(r.error!.message).toBe('fatal ••••••');
  });

  it('caps total console output', async () => {
    const r = await pre(`for (let i = 0; i < 5000; i++) console.log('x'.repeat(100));`, { maxConsoleBytes: 10_000 });
    expect(r.console.length).toBeLessThan(110);
    expect(r.console.at(-1)!.message).toMatch(/truncated/);
    const total = r.console.reduce((n, c) => n + c.message.length, 0);
    expect(total).toBeLessThan(11_000);
  });
});

describe('runScript – errors and limits', () => {
  it('reports syntax errors with line numbers', async () => {
    const r = await pre(`const a = 1;\nconst b = 2;\nconst c = ;\n`);
    expect(r.error?.message).toMatch(/SyntaxError/);
    expect(r.error?.line).toBe(3);
  });

  it('reports runtime errors with line numbers and keeps prior changes', async () => {
    const r = await pre(`reqvyn.env.set('a', '1');\n\nundefinedFunction();`);
    expect(r.error?.message).toMatch(/ReferenceError: undefinedFunction is not defined/);
    expect(r.error?.line).toBe(3);
    expect(r.variableChanges).toHaveLength(1);
  });

  it('reports the line of a failed test assertion error thrown at top level', async () => {
    const r = await post(`\n\nreqvyn.expect(1).toBe(2);`);
    expect(r.error).toEqual({ message: 'Expected 1 to be 2', line: 3 });
  });

  it('terminates infinite loops on timeout', async () => {
    const started = Date.now();
    const r = await pre(`console.log('before'); while (true) {}`, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.error?.message).toMatch(/timed out after 300 ms/);
    expect(r.console.map((c) => c.message)).toEqual(['before']);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('terminates runaway async work on timeout', async () => {
    const r = await pre(`for (;;) { await reqvyn.sleep(5); }`, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    const r2 = await pre(`for (;;) { await null; }`, { timeoutMs: 300 });
    expect(r2.timedOut).toBe(true);
  });

  it('honours AbortSignal cancellation', async () => {
    const ac = new AbortController();
    const p = pre(`while (true) {}`, { signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 150);
    const started = Date.now();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.error?.message).toMatch(/cancelled/);
    expect(Date.now() - started).toBeLessThan(3000);

    const pre2 = new AbortController();
    pre2.abort();
    const r2 = await pre(`reqvyn.env.set('x', '1')`, { signal: pre2.signal });
    expect(r2.cancelled).toBe(true);
    expect(r2.variableChanges).toEqual([]);
  });

  it('enforces the memory limit', async () => {
    const r = await pre(`const keep = []; while (true) { keep.push(new Array(1e6).fill(Math.random())); }`, {
      memoryLimitMb: 16,
      timeoutMs: 15_000,
    });
    expect(r.timedOut).toBeUndefined();
    expect(r.error?.message).toMatch(/memory limit of 16 MB/);
  }, 20_000);

  it('handles empty scripts without starting a worker', async () => {
    const r = await pre('   ');
    expect(r.error).toBeUndefined();
    expect(r.request).toEqual(request);
  });
});

describe('runScript – isolation', () => {
  async function probe(expr: string): Promise<string> {
    const r = await pre(`
      let out;
      try { out = (function () { return ${expr}; })(); out = typeof out === 'object' && out !== null ? 'object' : String(out); }
      catch (e) { out = 'threw:' + (e && e.message); }
      console.log(out);
    `);
    expect(r.error).toBeUndefined();
    return r.console[0]!.message;
  }

  it('exposes no require, process, module, Buffer or network globals', async () => {
    expect(await probe('typeof require')).toBe('undefined');
    expect(await probe('typeof process')).toBe('undefined');
    expect(await probe('typeof globalThis.process')).toBe('undefined');
    expect(await probe('typeof module')).toBe('undefined');
    expect(await probe('typeof Buffer')).toBe('undefined');
    expect(await probe('typeof fetch')).toBe('undefined');
    expect(await probe('typeof WebAssembly === "object" ? "wasm" : "none"')).toMatch(/wasm|none/);
    expect(await probe('Object.keys(globalThis).join(",")')).toBe('');
  });

  it('blocks string code generation (eval, Function, constructor escapes)', async () => {
    expect(await probe('eval("1 + 1")')).toMatch(/threw:.*Code generation from strings disallowed/);
    expect(await probe('Function("return 1")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('new Function("return process")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('this.constructor.constructor("return process")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('reqvyn.constructor.constructor("return process")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('reqvyn.env.get.constructor("return process")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('console.log.constructor("return process")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('(async () => {}).constructor("return process")()')).toMatch(/threw:.*disallowed/);
    expect(await probe('(function*(){}).constructor("yield 1")')).toMatch(/threw:.*disallowed/);
    expect(await probe('setTimeout("1", 1)')).toMatch(/threw:.*string code is not allowed/);
  });

  it('blocks wasm compilation and dynamic import', async () => {
    const wasm = await probe(
      'typeof WebAssembly === "undefined" ? "no-wasm" : new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))',
    );
    expect(wasm).toMatch(/no-wasm|threw:.*(disallowed|Wasm code generation)/i);
    const r = await pre(`try { await import('fs'); console.log('imported'); } catch (e) { console.log('threw'); }`);
    expect(r.console[0]?.message ?? r.error?.message).not.toBe('imported');
  });

  it('cannot reach host functions through stack trace inspection', async () => {
    const r = await pre(`
      const found = [];
      Error.prepareStackTrace = (e, frames) => {
        for (const f of frames) {
          try { const fn = f.getFunction(); if (fn) found.push(fn); } catch (x) {}
          try { const t = f.getThis(); if (t) found.push(t); } catch (x) {}
        }
        return 'x';
      };
      void new Error('probe').stack;
      let escaped = false;
      for (const f of found) {
        try { const p = f.constructor.constructor('return process')(); if (p) escaped = true; } catch (x) {}
      }
      console.log(String(escaped));
    `);
    expect(r.console.map((c) => c.message)).toEqual(['false']);
  });

  it('API objects are frozen and globals cannot be replaced', async () => {
    const r = await post(`
      'use strict';
      const errors = [];
      try { reqvyn.env = null; } catch (e) { errors.push('env'); }
      try { reqvyn.response.status = 500; } catch (e) { errors.push('status'); }
      try { globalThis.reqvyn = {}; } catch (e) { errors.push('global'); }
      console.log(errors.join(','), reqvyn.response.status);
    `);
    expect(r.console[0]!.message).toBe('env,status,global 200');
  });

  it('only returns plain JSON data', async () => {
    const r = await pre(`reqvyn.env.set('fn', function () {}); reqvyn.request.body = { a: 1 };`);
    expect(r.variableChanges[0]!.value).toBe('[Function]');
    expect(r.request.body).toBe('{"a":1}');
    expect(() => structuredClone(r)).not.toThrow();
  });
});

describe('ScriptSandboxPool', () => {
  const pool = new ScriptSandboxPool({ size: 2 });
  afterAll(() => pool.dispose());

  it('reuses workers with fresh contexts per run', async () => {
    await pool.warmup();
    expect(pool.idleCount).toBe(2);
    const r1 = await pool.run({ code: `globalThis.leak = 1; reqvyn.env.set('a', '1');`, phase: 'pre', request, variables: {} });
    expect(r1.error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await pool.run({ code: `console.log(typeof globalThis.leak)`, phase: 'pre', request, variables: {} });
    expect(r2.console[0]!.message).toBe('undefined');
    const many = await Promise.all(
      Array.from({ length: 6 }, (_, i) => pool.run({ code: `reqvyn.env.set('i', '${i}')`, phase: 'pre', request, variables: {} })),
    );
    expect(many.map((m) => m.variableChanges[0]!.value)).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('replaces workers that timed out', async () => {
    const r = await pool.run({ code: `while (true) {}`, phase: 'pre', request, variables: {}, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    const ok = await pool.run({ code: `reqvyn.env.set('x', 'y')`, phase: 'pre', request, variables: {} });
    expect(ok.variableChanges).toEqual([{ scope: 'environment', key: 'x', value: 'y' }]);
  });

  it('refuses runs after dispose', async () => {
    const p = new ScriptSandboxPool({ size: 1 });
    await p.warmup();
    await p.dispose();
    const r = await p.run({ code: `1`, phase: 'pre', request, variables: {} });
    expect(r.error?.message).toMatch(/disposed/);
  });
});
