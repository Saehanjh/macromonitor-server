// Small numeric helpers used by the markets route (z-score, volatility series).

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). */
export function std(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Z-score of `value` against a reference `sample` window. */
export function zscore(value: number, sample: number[]): number {
  const s = std(sample);
  if (!Number.isFinite(s) || s === 0) return 0;
  return (value - mean(sample)) / s;
}

export function pctChange(latest: number, prev: number): number {
  if (!Number.isFinite(prev) || prev === 0) return 0;
  return ((latest - prev) / prev) * 100;
}
