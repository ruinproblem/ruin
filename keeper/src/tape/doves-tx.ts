import { DOVES, FEEDS } from "../../../program/client/constants.js";
import { MARKETS } from "../common/oracle.js";

export type DovesUpdate = { feed: string; market: string; price: string; publish_ts: number; slot: number; recv_ms: number };
/** Decodes the source selected by each successful top-level oracle update. */
export function decodeDovesTransaction(tx: any): DovesUpdate[] {
  if (!tx?.meta || tx.meta.err !== null) return [];
  if (!Number.isFinite(tx.slot) || !Number.isFinite(tx.blockTime)) throw new Error("Oracle transaction time unavailable");
  const keys = [...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])]
    .map((key: any) => typeof key === "string" ? key : key.pubkey);
  const instructions = tx.transaction.message.instructions.filter((ix: any) => keys[ix.programIdIndex] === DOVES && ix.data === "BFFRQh5PNJx");
  const blocks: string[][] = [];
  for (const line of tx.meta.logMessages ?? []) {
    if (line === "Program log: Instruction: UpdateAgPrice2") blocks.push([]);
    else blocks.at(-1)?.push(line);
  }
  if (instructions.length !== blocks.length) throw new Error("Oracle instruction/log count mismatch");
  const updates: DovesUpdate[] = [];
  instructions.forEach((ix: any, i: number) => {
    const feed = keys[ix.accounts[1]], market = FEEDS.indexOf(feed as any);
    const chosen = blocks[i]!.map((line) => /updated from (.+)$/.exec(line)?.[1]?.trim()).find(Boolean);
    if (!chosen) return;
    const values = blocks[i]!.map((line) => /^Program log: (.+) price: (\d+), timestamp: (-?\d+)$/.exec(line));
    const value = values.find((match) => match?.[1] === chosen);
    if (!value || BigInt(value[2]!) <= 0n) throw new Error("Selected oracle source missing");
    if (market < 0) return;
    updates.push({ feed, market: MARKETS[market]!, price: value[2]!, publish_ts: Number(value[3]), slot: tx.slot, recv_ms: tx.blockTime * 1000 });
  });
  return updates.sort((a, b) => a.publish_ts - b.publish_ts);
}
