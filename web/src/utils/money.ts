/** Formats a cent amount as dollars, e.g. 856500n -> "$8.6K". Sign is dropped. */
export function formatDollars(cents: bigint): string {
  const dollars = Math.abs(Number(cents)) / 100;
  if (dollars >= 1000000) {
    return `$${(dollars / 1000000).toFixed(2)}M`;
  }
  if (dollars >= 1000) {
    return `$${(dollars / 1000).toFixed(1)}K`;
  }
  return `$${dollars.toFixed(0)}`;
}
