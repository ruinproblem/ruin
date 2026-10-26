import { createHash } from "node:crypto";
import {
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type TransactionSigner,
  type Instruction,
} from "@solana/kit";
import { RUIN_PROGRAM_ADDRESS } from "../client/src/generated/index.js";
export const findDevFeedPda = (market: number) =>
  getProgramDerivedAddress({
    programAddress: RUIN_PROGRAM_ADDRESS,
    seeds: ["dev_feed", new Uint8Array([market])],
  });
export async function devFeedInstruction(input: {
  authority: TransactionSigner;
  programData: Address;
  market: number;
  price?: bigint;
  publishTs?: bigint;
}): Promise<Instruction> {
  const write = input.price !== undefined;
  const name = write ? "dev_feed_write" : "dev_feed_init";
  const data = Buffer.alloc(write ? 25 : 9);
  createHash("sha256").update(`global:${name}`).digest().copy(data, 0, 0, 8);
  data[8] = input.market;
  if (write) {
    data.writeBigUInt64LE(input.price!, 9);
    data.writeBigInt64LE(input.publishTs!, 17);
  }
  const eventAuthority = (
    await getProgramDerivedAddress({
      programAddress: RUIN_PROGRAM_ADDRESS,
      seeds: ["__event_authority"],
    })
  )[0];
  const accounts = [
    {
      address: input.authority.address,
      role: AccountRole.WRITABLE_SIGNER,
      signer: input.authority,
    },
    { address: RUIN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: input.programData, role: AccountRole.READONLY },
    {
      address: (await findDevFeedPda(input.market))[0],
      role: AccountRole.WRITABLE,
    },
  ];
  if (!write)
    accounts.push({
      address: "11111111111111111111111111111111" as Address,
      role: AccountRole.READONLY,
    });
  accounts.push(
    { address: eventAuthority, role: AccountRole.READONLY },
    { address: RUIN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  );
  return { programAddress: RUIN_PROGRAM_ADDRESS, accounts, data };
}
