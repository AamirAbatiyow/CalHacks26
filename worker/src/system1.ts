/**
 * System 1: L2-regularised logistic regression over structured features,
 * refit with warm-started Newton steps so a refit on thousands of labels takes milliseconds.
 */

export const AUTO_DECIDE_P = 0.95;

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predict(weights: number[], x: number[]): number {
  let z = 0;
  for (let i = 0; i < weights.length; i++) z += weights[i] * x[i];
  return sigmoid(z);
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const d = m[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / (row[i] || 1e-12));
}

export interface FitOptions {
  l2?: number;
  maxIter?: number;
  init?: number[];
}

/** Weighted Newton-Raphson (IRLS). The bias (index 0) is not regularised. */
export function fit(X: number[][], y: number[], w: number[], opts: FitOptions = {}): { weights: number[]; iterations: number } {
  const d = X[0]?.length ?? 0;
  const l2 = opts.l2 ?? 1;
  let beta = opts.init && opts.init.length === d ? [...opts.init] : new Array(d).fill(0);
  let iterations = 0;
  for (; iterations < (opts.maxIter ?? 30); iterations++) {
    const grad = new Array(d).fill(0);
    const hess = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i];
      const p = predict(beta, xi);
      const g = w[i] * (p - y[i]);
      const h = w[i] * Math.max(p * (1 - p), 1e-9);
      for (let a = 0; a < d; a++) {
        if (xi[a] === 0) continue;
        grad[a] += g * xi[a];
        const hx = h * xi[a];
        for (let b = a; b < d; b++) hess[a][b] += hx * xi[b];
      }
    }
    for (let a = 0; a < d; a++) {
      for (let b = 0; b < a; b++) hess[a][b] = hess[b][a];
      if (a > 0) {
        grad[a] += l2 * beta[a];
        hess[a][a] += l2;
      } else {
        hess[a][a] += 1e-6;
      }
    }
    const step = solve(hess, grad);
    let maxStep = 0;
    for (let a = 0; a < d; a++) {
      beta[a] -= step[a];
      maxStep = Math.max(maxStep, Math.abs(step[a]));
    }
    if (maxStep < 1e-6) {
      iterations++;
      break;
    }
  }
  beta = beta.map(v => Math.round(v * 1e6) / 1e6);
  return { weights: beta, iterations };
}

export interface Metrics {
  /** Share of history the model would auto-approve (p >= 0.95) that humans approved. */
  precisionPct: number;
  /** Share of history the model is confident enough to auto-approve. */
  coveragePct: number;
  accuracyPct: number;
  brier: number;
  /** Expected calibration error over 10 confidence bins. */
  ece: number;
}

export function evaluate(weights: number[], X: number[][], y: number[]): Metrics {
  let autoApproved = 0;
  let autoCorrect = 0;
  let correct = 0;
  let brier = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));
  for (let i = 0; i < X.length; i++) {
    const p = predict(weights, X[i]);
    const approve = p >= 0.5;
    if (approve === (y[i] === 1)) correct++;
    if (p >= AUTO_DECIDE_P) {
      autoApproved++;
      if (y[i] === 1) autoCorrect++;
    }
    brier += (p - y[i]) ** 2;
    const conf = approve ? p : 1 - p;
    const bin = bins[Math.min(9, Math.floor(conf * 10))];
    bin.n++;
    bin.conf += conf;
    bin.hit += approve === (y[i] === 1) ? 1 : 0;
  }
  const n = Math.max(X.length, 1);
  const ece = bins.reduce((acc, b) => acc + (b.n ? (b.n / n) * Math.abs(b.hit / b.n - b.conf / b.n) : 0), 0);
  const r = (v: number, k = 2) => Math.round(v * 10 ** k) / 10 ** k;
  return {
    precisionPct: r(autoApproved ? (100 * autoCorrect) / autoApproved : 100),
    coveragePct: r((100 * autoApproved) / n),
    accuracyPct: r((100 * correct) / n),
    brier: r(brier / n, 4),
    ece: r(ece, 4),
  };
}
