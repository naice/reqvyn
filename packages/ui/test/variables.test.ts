import { describe, expect, it } from 'vitest';
import type { UiVariable } from '@reqvyn/core';
import {
  classifyVariable,
  describeVariable,
  findVariableTokens,
  isDynamicName,
  lookupVariable,
  openReferenceBefore,
  previewResolved,
  segmentText,
  tokenAt,
  variableCompletions,
} from '../src/lib/variables';

const vars: UiVariable[] = [
  { key: 'host', value: 'global.io', source: 'global', secret: false },
  { key: 'host', value: 'env.io', source: 'environment', secret: false },
  { key: 'token', value: 'MASKED', source: 'environment', secret: true },
];

describe('tokens', () => {
  it('finds trimmed variable names with positions', () => {
    expect(findVariableTokens('a {{ host }}/{{x}}')).toEqual([
      { from: 2, to: 12, name: 'host' },
      { from: 13, to: 18, name: 'x' },
    ]);
    expect(findVariableTokens('no vars {single}')).toEqual([]);
  });
  it('tokenAt finds the token at a position (inclusive)', () => {
    expect(tokenAt('x{{a}}', 1)?.name).toBe('a');
    expect(tokenAt('x{{a}}', 6)?.name).toBe('a');
    expect(tokenAt('x{{a}}', 0)).toBeUndefined();
  });
});

describe('classification', () => {
  it('recognises dynamic names including prefixed forms', () => {
    expect(isDynamicName('$uuid')).toBe(true);
    expect(isDynamicName('$randomInt:1:5')).toBe(true);
    expect(isDynamicName('$env:CI')).toBe(true);
    expect(isDynamicName('$nope')).toBe(false);
    expect(isDynamicName('uuid')).toBe(false);
  });
  it('later scopes win on lookup', () => {
    expect(lookupVariable('host', vars)?.value).toBe('env.io');
  });
  it('classifies resolved / secret / dynamic / unresolved', () => {
    expect(classifyVariable('host', vars)).toBe('resolved');
    expect(classifyVariable('token', vars)).toBe('secret');
    expect(classifyVariable('$secret:key', vars)).toBe('secret');
    expect(classifyVariable('$timestamp', vars)).toBe('dynamic');
    expect(classifyVariable('missing', vars)).toBe('unresolved');
  });
});

describe('segmentText / previewResolved', () => {
  it('segments plain and variable runs covering the whole text', () => {
    const segs = segmentText('https://{{host}}/x?{{missing}}', vars);
    expect(segs.map((s) => s.text).join('')).toBe('https://{{host}}/x?{{missing}}');
    expect(segs.filter((s) => s.variable).map((s) => s.variable!.status)).toEqual(['resolved', 'unresolved']);
  });
  it('previews with masked secrets and leaves unknowns', () => {
    expect(previewResolved('{{host}} {{ token }} {{nope}}', vars)).toBe('env.io •••••• {{nope}}');
  });
});

describe('autocomplete helpers', () => {
  it('detects an open reference before the cursor', () => {
    expect(openReferenceBefore('url {{ ho')).toEqual({ from: 7, prefix: 'ho' });
    expect(openReferenceBefore('url {{host}} x')).toBeNull();
    expect(openReferenceBefore('plain')).toBeNull();
  });
  it('dedupes variables, never exposes secret values, ranks prefix matches first', () => {
    const items = variableCompletions(vars, 'to');
    expect(items[0]!.label).toBe('token');
    expect(items[0]!.kind).toBe('secret');
    expect(items[0]!.info).not.toContain('MASKED');
    const all = variableCompletions(vars, '');
    expect(all.filter((c) => c.label === 'host')).toHaveLength(1);
    expect(all.find((c) => c.label === 'host')!.info).toBe('env.io');
    expect(all.some((c) => c.kind === 'dynamic')).toBe(true);
  });
  it('describes variables for tooltips without revealing secrets', () => {
    expect(describeVariable('token', vars).value).toBe('••••••');
    expect(describeVariable('$uuid', vars)).toMatchObject({ status: 'dynamic', source: 'dynamic' });
    expect(describeVariable('missing', vars).status).toBe('unresolved');
    expect(describeVariable('$secret:k', vars).source).toBe('secret storage');
  });
});
