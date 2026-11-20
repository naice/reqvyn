import type { Timings, TestResult } from '@reqvyn/core';

export interface TimingSegment {
  key: 'dns' | 'connect' | 'tls' | 'wait' | 'download';
  label: string;
  start: number;
  duration: number;
}

/** Waterfall segments (ms from request start). Missing phases (e.g. reused connections) are skipped. */
export function timingSegments(t: Timings): TimingSegment[] {
  const segs: TimingSegment[] = [];
  let cursor = 0;
  const push = (key: TimingSegment['key'], label: string, d: number | undefined) => {
    if (d === undefined || !Number.isFinite(d) || d < 0) return;
    segs.push({ key, label, start: cursor, duration: d });
    cursor += d;
  };
  push('dns', 'DNS lookup', t.dnsMs);
  push('connect', 'TCP connect', t.connectMs);
  push('tls', 'TLS handshake', t.tlsMs);
  if (t.firstByteMs !== undefined) push('wait', 'Waiting (TTFB)', Math.max(0, t.firstByteMs - cursor));
  const download = t.downloadMs ?? (t.firstByteMs !== undefined ? Math.max(0, t.totalMs - t.firstByteMs) : undefined);
  push('download', 'Content download', download);
  return segs;
}

export interface TestCounts {
  passed: number;
  failed: number;
}

/** Count leaf results (groups count via their children). */
export function countTests(results: readonly TestResult[]): TestCounts {
  let passed = 0;
  let failed = 0;
  const walk = (list: readonly TestResult[]) => {
    for (const r of list) {
      if (r.children && r.children.length) walk(r.children);
      else if (r.passed) passed++;
      else failed++;
    }
  };
  walk(results);
  return { passed, failed };
}

/** Failed leaf results with their group path, for compact display. */
export function failedTests(results: readonly TestResult[], prefix: string[] = []): Array<{ path: string[]; result: TestResult }> {
  const out: Array<{ path: string[]; result: TestResult }> = [];
  for (const r of results) {
    if (r.children && r.children.length) out.push(...failedTests(r.children, [...prefix, r.name]));
    else if (!r.passed) out.push({ path: prefix, result: r });
  }
  return out;
}
