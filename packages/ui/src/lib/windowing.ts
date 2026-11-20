/** Prefix sums of item heights: offsets[i] = top of item i, offsets[n] = total height. */
export function computeOffsets(count: number, heightOf: (index: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i]! + heightOf(i);
  return offsets;
}

/** First index whose bottom is below `y` (binary search). */
export function indexAt(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function visibleRange(offsets: Float64Array, scrollTop: number, viewport: number, overscan = 5): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, indexAt(offsets, scrollTop) - overscan);
  const end = Math.min(count, indexAt(offsets, scrollTop + viewport) + 1 + overscan);
  return { start, end };
}
