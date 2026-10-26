import {
  address,
  getAddressDecoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { ASSETS, DOVES } from "../../../program/client/constants.js";
import { RUIN_PROGRAM_ADDRESS } from "../../../program/client/index.js";
import type { Cluster } from "./env.js";
export const MARKETS = ["SOL", "BTC", "ETH"] as const;
export type Market = (typeof MARKETS)[number];
export type Price = {
  price: bigint;
  publishTs: bigint;
  slot: number;
  recvMs: number;
};
export async function parseFeed(
  key: string,
  raw: any,
  market: number,
  cluster: Cluster,
): Promise<Price> {
  const d = Buffer.from(raw?.data?.[0] ?? "", "base64");
  const dev = (
    await getProgramDerivedAddress({
      programAddress: RUIN_PROGRAM_ADDRESS,
      seeds: ["dev_feed", new Uint8Array([market])],
    })
  )[0];
  if (
    !raw ||
    !(
      raw.owner === DOVES ||
      (cluster === "devnet" &&
        key === dev &&
        raw.owner === RUIN_PROGRAM_ADDRESS)
    ) ||
    d.length !== 394 ||
    d.subarray(0, 8).toString("hex") !== "70f98bd9d7d0f936" ||
    d[176] !== 248 ||
    getAddressDecoder().decode(d.subarray(8, 40)) !== ASSETS[market] ||
    d.readBigUInt64LE(168) === 0n
  )
    throw new Error("Invalid oracle account");
  return {
    price: d.readBigUInt64LE(168),
    publishTs: d.readBigInt64LE(177),
    slot: 0,
    recvMs: Date.now(),
  };
}
