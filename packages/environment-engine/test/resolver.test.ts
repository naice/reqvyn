import { describe, expect, it } from 'vitest';
import { kv } from '@reqvyn/core';
import { VariableContext, layerFromKeyValues, layerFromRecord, collectSecretReferences, parseDotEnv, dotEnvToVariables, variablesToDotEnv, evaluateDynamic } from '../src/index.js';

describe('VariableContext', () => {
  it('applies precedence global < collection < environment < runtime', () => {
    const ctx = new VariableContext([
      layerFromRecord('global', { a: 'g', b: 'g', c: 'g', d: 'g' }),
      layerFromRecord('collection', { b: 'c', c: 'c', d: 'c' }),
      layerFromRecord('environment', { c: 'e', d: 'e' }),
    ]);
    ctx.setRuntime('d', 'r');
    expect(ctx.resolve('{{a}}{{b}}{{c}}{{d}}')).toBe('gcer');
    expect(ctx.lookup('c')?.source).toBe('environment');
  });

  it('resolves nested references and reports unresolved', () => {
    const ctx = new VariableContext([layerFromRecord('environment', { host: 'api.test', base: 'https://{{host}}/v1' })]);
    const r = ctx.resolveDetailed('{{base}}/users/{{ id }}?q={{missing}}');
    expect(r.value).toBe('https://api.test/v1/users/{{ id }}?q={{missing}}');
    expect(r.unresolved.sort()).toEqual(['id', 'missing']);
  });

  it('detects cycles', () => {
    const ctx = new VariableContext([layerFromRecord('environment', { a: '{{b}}', b: '{{c}}', c: '{{a}}' })]);
    expect(() => ctx.resolve('{{a}}')).toThrowError(/Circular/);
    const self = new VariableContext([layerFromRecord('environment', { a: 'x{{a}}' })]);
    expect(() => self.resolve('{{a}}')).toThrowError(/Circular/);
  });

  it('ignores disabled rows and uses vault values for secret rows', () => {
    const rows = [kv('user', 'bob'), { ...kv('token', ''), secret: true }, { ...kv('off', 'x'), enabled: false }];
    const ctx = new VariableContext([layerFromKeyValues('environment', rows, { label: 'Dev', secretValues: new Map([['token', 's3cr3t-value']]) })]);
    expect(ctx.resolve('{{user}}:{{token}}:{{off}}')).toBe('bob:s3cr3t-value:{{off}}');
    expect(ctx.preview('Bearer {{token}}')).toBe('Bearer ••••••');
    expect(ctx.toUiVariables().find((v) => v.key === 'token')?.value).toBe('••••••');
    expect(ctx.secretValues()).toContain('s3cr3t-value');
    expect(ctx.resolveDetailed('{{token}}').usedSecrets).toEqual(['token']);
  });

  it('resolves $secret, $env and dynamic variables', () => {
    const ctx = new VariableContext([], { namedSecrets: new Map([['api', 'k3y-abc']]), processEnv: { HOME_X: '/home/x' } });
    expect(ctx.resolve('{{$secret:api}}')).toBe('k3y-abc');
    expect(ctx.resolve('{{$env:HOME_X}}')).toBe('/home/x');
    expect(ctx.resolve('{{$uuid}}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.preview('{{$secret:api}}')).toBe('••••••');
    const noEnv = new VariableContext([]);
    expect(noEnv.resolve('{{$env:HOME_X}}')).toBe('{{$env:HOME_X}}');
  });

  it('setInLayer keeps precedence below runtime', () => {
    const ctx = new VariableContext([layerFromRecord('global', { a: '1' })]);
    ctx.setRuntime('a', 'runtime');
    ctx.setInLayer('environment', 'a', 'env');
    expect(ctx.resolve('{{a}}')).toBe('runtime');
    ctx.unsetRuntime('a');
    expect(ctx.resolve('{{a}}')).toBe('env');
    expect(ctx.snapshot().a).toBe('env');
  });

  it('collects secret references', () => {
    expect(collectSecretReferences({ a: '{{$secret:one}}', b: ['{{ $secret:two }}', '{{x}}'] }).sort()).toEqual(['one', 'two']);
  });
});

describe('dynamic variables', () => {
  it('generates values', () => {
    expect(Number(evaluateDynamic('$timestamp'))).toBeGreaterThan(1_600_000_000);
    const n = Number(evaluateDynamic('$randomInt:5:7'));
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(7);
    expect(evaluateDynamic('$randomString:12')).toHaveLength(12);
    expect(evaluateDynamic('$randomEmail')).toMatch(/@example\.com$/);
    expect(evaluateDynamic('$isoTimestamp')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(evaluateDynamic('$nope')).toBeUndefined();
    expect(evaluateDynamic('$randomInt:9:1')).toBeUndefined();
  });
});

describe('.env', () => {
  it('parses common syntax', () => {
    const parsed = parseDotEnv(['# comment', 'export A=1', 'B="multi\\nline"', "C='raw $x'", 'D=value # trailing', 'E=', 'bad line', 'F="two', 'lines"'].join('\n'));
    expect(parsed).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'multi\nline' },
      { key: 'C', value: 'raw $x' },
      { key: 'D', value: 'value' },
      { key: 'E', value: '' },
      { key: 'F', value: 'two\nlines' },
    ]);
  });

  it('marks sensitive keys as secrets on import and omits secrets on export', () => {
    const vars = dotEnvToVariables('API_TOKEN=abc\nHOST=x', { markSensitiveAsSecret: true });
    expect(vars.find((v) => v.key === 'API_TOKEN')?.secret).toBe(true);
    expect(vars.find((v) => v.key === 'HOST')?.secret).toBeUndefined();
    const out = variablesToDotEnv(vars);
    expect(out).not.toContain('abc');
    expect(out).toContain('HOST=x');
    const roundTrip = parseDotEnv(variablesToDotEnv([kv('Q', 'has "quotes" and spaces\nnewline')]));
    expect(roundTrip[0]?.value).toBe('has "quotes" and spaces\nnewline');
  });
});
