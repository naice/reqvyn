import { describe, expect, it } from 'vitest';
import type { TestResult } from '@reqvyn/core';
import { countTests, failedTests, timingSegments } from '../src/lib/timings';

describe('timingSegments', () => {
  it('lays out phases sequentially', () => {
    const segs = timingSegments({ startedAt: 0, dnsMs: 5, connectMs: 10, tlsMs: 15, firstByteMs: 50, totalMs: 80 });
    expect(segs.map((s) => [s.key, s.start, s.duration])).toEqual([
      ['dns', 0, 5],
      ['connect', 5, 10],
      ['tls', 15, 15],
      ['wait', 30, 20],
      ['download', 50, 30],
    ]);
  });
  it('skips missing phases (reused connection)', () => {
    const segs = timingSegments({ startedAt: 0, firstByteMs: 20, downloadMs: 4, totalMs: 24 });
    expect(segs.map((s) => s.key)).toEqual(['wait', 'download']);
    expect(timingSegments({ startedAt: 0, totalMs: 10 })).toEqual([]);
  });
});

describe('test result helpers', () => {
  const results: TestResult[] = [
    { id: '1', name: 'status', passed: true, source: 'assertion' },
    {
      id: 'g',
      name: 'group',
      passed: false,
      source: 'assertion',
      children: [
        { id: '2', name: 'a', passed: false, message: 'nope', source: 'assertion' },
        { id: '3', name: 'b', passed: true, source: 'assertion' },
      ],
    },
    { id: '4', name: 'script', passed: false, source: 'script' },
  ];
  it('counts leaves', () => {
    expect(countTests(results)).toEqual({ passed: 2, failed: 2 });
  });
  it('lists failures with group path', () => {
    expect(failedTests(results).map((f) => [f.path, f.result.id])).toEqual([
      [['group'], '2'],
      [[], '4'],
    ]);
  });
});
