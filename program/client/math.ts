export type SplitInput = {
  side: "Long" | "Short" | 0 | 1;
  lev: number;
  m: bigint;
  k: number;
  eBps: number;
  p0: bigint;
  p: bigint;
};
const U64 = (1n << 64n) - 1n,
  U128 = (1n << 128n) - 1n;
export function split({ side, lev, m, k, eBps, p0, p }: SplitInput) {
  if (
    p0 <= 0n ||
    p <= 0n ||
    p0 > U64 ||
    p > U64 ||
    m < 0n ||
    m > U64 ||
    !Number.isInteger(lev) ||
    lev < 1 ||
    lev > 10000 ||
    !Number.isInteger(k) ||
    k < 1 ||
    k > 100 ||
    !Number.isInteger(eBps) ||
    eBps < 0 ||
    eBps > 10000 ||
    !["Long", "Short", 0, 1].includes(side)
  )
    throw new Error("InvalidValue");
  const num =
    p0 + (side === "Long" || side === 0 ? 1n : -1n) * BigInt(lev) * (p - p0);
  const den = BigInt(1 + k) * p0,
    claimNum = m * (10000n + BigInt(k) * BigInt(10000 - eBps));
  if (claimNum * den > U128 || BigInt(1 + k) * m > U64)
    throw new Error("Overflow");
  const clamp = num < 0n ? 0n : num > den ? den : num;
  const a =
    num >= den ? claimNum / 10000n : (claimNum * clamp) / (10000n * den);
  return {
    a,
    b: BigInt(1 + k) * m - a,
    fE9: (clamp * 1000000000n) / den,
    line:
      num <= 0n
        ? ("TraderLine" as const)
        : num >= den
          ? ("HouseLine" as const)
          : null,
  };
}
export function lock(
  stake: bigint,
  freeStake: bigint,
  ruinPerUsd: bigint,
): bigint {
  if ([stake, freeStake, ruinPerUsd].some((v) => v < 0n || v > U64))
    throw new Error("InvalidValue");
  if (stake <= freeStake) return 0n;
  if (!ruinPerUsd) throw new Error("StakeOverFree");
  const value = (stake * ruinPerUsd + 999999n) / 1000000n;
  if (value > U64) throw new Error("Overflow");
  return value;
}
export function delay(hash: Uint8Array, min: number, max: number): bigint {
  if (
    hash.length !== 32 ||
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 1 ||
    max < min ||
    max > 65535
  )
    throw new Error("InvalidValue");
  return (
    BigInt(min) +
    (new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getBigUint64(
      0,
      true,
    ) %
      BigInt(max - min + 1))
  );
}
