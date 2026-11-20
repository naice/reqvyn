import { describe, expect, it } from 'vitest';
import { computeOffsets, indexAt, visibleRange } from '../src/lib/windowing';

describe('windowing', () => {
  const offsets = computeOffsets(5, (i) => (i === 2 ? 50 : 10)); // 0,10,20,70,80,90
  it('computes prefix sums', () => {
    expect(Array.from(offsets)).toEqual([0, 10, 20, 70, 80, 90]);
  });
  it('finds the item at a y position', () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 9.9)).toBe(0);
    expect(indexAt(offsets, 10)).toBe(1);
    expect(indexAt(offsets, 69)).toBe(2);
    expect(indexAt(offsets, 1000)).toBe(4);
    expect(indexAt(computeOffsets(0, () => 1), 5)).toBe(0);
  });
  it('computes the visible range with overscan', () => {
    expect(visibleRange(offsets, 15, 10, 0)).toEqual({ start: 1, end: 3 });
    expect(visibleRange(offsets, 15, 10, 1)).toEqual({ start: 0, end: 4 });
    expect(visibleRange(computeOffsets(0, () => 1), 0, 100)).toEqual({ start: 0, end: 0 });
  });
  it('scales to large lists', () => {
    const big = computeOffsets(100_000, () => 24);
    expect(visibleRange(big, 24 * 50_000, 240, 2)).toEqual({ start: 49_998, end: 50_013 });
  });
});
