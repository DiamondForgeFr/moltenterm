// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Small statistics helpers for the performance harness (FR-PERF-006).

export function quantile(values, q) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) {
    return null;
  }
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) {
    return value;
  }
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Split-half spread: the samples are dealt alternately into two halves, as if they came from two interleaved runs,
// and the gap between the halves' medians is returned as a percentage of the overall median. It is how a single run
// predicts whether a second run of the same build would land within the noise threshold (FR-PERF-006-AC3).
export function splitHalfSpreadPct(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 4) {
    return null;
  }
  const a = xs.filter((_, i) => i % 2 === 0);
  const b = xs.filter((_, i) => i % 2 === 1);
  const m = median(xs);
  const gap = Math.abs(median(a) - median(b));
  if (m === 0) {
    return gap === 0 ? 0 : 100;
  }
  return (100 * gap) / Math.abs(m);
}

export function splitHalfGap(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 4) {
    return null;
  }
  return Math.abs(median(xs.filter((_, i) => i % 2 === 0)) - median(xs.filter((_, i) => i % 2 === 1)));
}

// A metric from several samples. `stat` picks the reported value: "median" (default) or "p95".
export function summarize(values, stat = "median") {
  const xs = values.filter((v) => Number.isFinite(v));
  const value = stat === "p95" ? quantile(xs, 0.95) : median(xs);
  return {
    value: round(value, 2),
    stat,
    n: xs.length,
    median: round(median(xs), 2),
    p95: round(quantile(xs, 0.95), 2),
    min: xs.length ? round(Math.min(...xs), 2) : null,
    max: xs.length ? round(Math.max(...xs), 2) : null,
    spreadPct: round(splitHalfSpreadPct(xs), 1),
    spreadAbs: round(splitHalfGap(xs), 2),
    samples: xs.map((x) => round(x, 2)),
  };
}

export function single(value) {
  return { value: round(value, 2), stat: "value", n: value == null ? 0 : 1 };
}
