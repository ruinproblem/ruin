import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(resolve(ROOT, ".env")))
  process.loadEnvFile(resolve(ROOT, ".env"));
export type Cluster = "devnet" | "mainnet";
export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};
export const PUBLIC = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};
export function cluster(): Cluster {
  const c = process.env.RUIN_CLUSTER || "devnet";
  if (c !== "devnet" && c !== "mainnet")
    throw new Error("Invalid RUIN_CLUSTER");
  return c;
}
export const dataDir = () =>
  resolve(ROOT, process.env.TAPE_DATA_DIR || "keeper/data");
export const json = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
