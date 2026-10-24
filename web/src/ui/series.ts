const DAY_US = 86_400_000_000n;

export function dayLabel(dayIndex: number): string {
  return new Date(dayIndex * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Buckets rows into UTC days over the trailing `days`, ending today. Days with no rows are
 * present with zero values: an empty day in a ledger is a real zero, not missing data.
 */
export function dailyBuckets<T, K extends string>(
  rows: T[],
  time: (row: T) => bigint,
  keys: readonly K[],
  value: (row: T) => { key: K; amount: number } | null,
  days = 30,
): Array<{ x: string } & Record<K, number>> {
  const today = Number(BigInt(Date.now()) * 1000n / DAY_US);
  const first = today - days + 1;
  const out = Array.from({ length: days }, (_, i) => {
    const row = { x: dayLabel(first + i) } as { x: string } & Record<K, number>;
    for (const k of keys) (row as Record<string, number | string>)[k] = 0;
    return row;
  });
  for (const r of rows) {
    const d = Number(time(r) / DAY_US) - first;
    if (d < 0 || d >= days) continue;
    const v = value(r);
    if (!v) continue;
    (out[d] as Record<string, number | string>)[v.key] = (out[d][v.key] as number) + v.amount;
  }
  return out;
}
