import { getAddressDecoder, type Address } from "@solana/kit";
import { DOVES, ASSETS } from "./constants.js";
const discriminator = [112, 249, 139, 217, 215, 208, 249, 54];
export function readDoves(
  input: { address: Address; owner: Address; data: Uint8Array },
  expected: { feed: Address; asset: Address; now: bigint; staleSecs: number },
) {
  if (input.address !== expected.feed) throw new Error("FeedNotConfig");
  const d = input.data;
  if (
    input.owner !== DOVES ||
    d.length !== 394 ||
    !discriminator.every((v, i) => d[i] === v) ||
    d[176] !== 248
  )
    throw new Error("FeedInvalid");
  const asset = getAddressDecoder().decode(d.subarray(8, 40));
  if (asset !== expected.asset || !ASSETS.includes(asset))
    throw new Error("FeedAssetMismatch");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    price = v.getBigUint64(168, true),
    publishTs = v.getBigInt64(177, true);
  if (!price) throw new Error("FeedInvalid");
  if (expected.now - publishTs > BigInt(expected.staleSecs))
    throw new Error("FeedStale");
  return { price, exponent: -8, publishTs, asset };
}
