import type { Instruction } from "@solana/kit";
export function writableAccounts(ixs: readonly Instruction[], payer: string) {
  const set = new Set([payer]);
  for (const ix of ixs)
    for (const a of ix.accounts ?? []) if (a.role & 1) set.add(a.address);
  return [...set];
}
export function selectPriorityFee(samples: unknown, min: bigint, max: bigint) {
  if (min < 0n || max < min) throw new Error("Invalid fee bounds");
  const prices = Array.isArray(samples)
    ? samples
        .map((x) => x?.prioritizationFee)
        .filter(
          (x) => typeof x === "number" && Number.isSafeInteger(x) && x > 0,
        )
        .map(BigInt)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  const p = prices.length ? prices[Math.ceil(prices.length * 0.75) - 1] : min;
  return p < min ? min : p > max ? max : p;
}
