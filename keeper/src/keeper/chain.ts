import { readFileSync } from "node:fs";
import {
  address,
  createKeyPairSignerFromBytes,
  getAddressDecoder,
  getProgramDerivedAddress,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import * as r from "../../../program/client/index.js";
import { TOKEN } from "../../../program/client/constants.js";
import { RpcPool } from "../common/rpc.js";
export async function signerFile(path: string) {
  try {
    return await createKeyPairSignerFromBytes(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
    );
  } catch {
    throw new Error("Unable to load signing key");
  }
}
export const encodedAccount = (
  rpc: RpcPool,
  a: string,
  mode: "normal" | "prepare" = "normal",
) =>
  rpc
    .call(
      "getAccountInfo",
      [a, { encoding: "base64", commitment: "processed" }],
      mode,
    )
    .then((v) => v.value);
export function tokenAccount(
  raw: any,
): { owner: Address; mint: Address } | null {
  if (!raw) return null;
  const d = Buffer.from(raw.data?.[0] ?? "", "base64");
  if (raw.owner !== TOKEN || d.length < 165)
    return {
      owner: address(raw.owner),
      mint: address("11111111111111111111111111111111"),
    };
  return {
    owner: getAddressDecoder().decode(d.subarray(32, 64)),
    mint: getAddressDecoder().decode(d.subarray(0, 32)),
  };
}
export const eventAccounts = async () => ({
  eventAuthority: (
    await getProgramDerivedAddress({
      programAddress: r.RUIN_PROGRAM_ADDRESS,
      seeds: ["__event_authority"],
    })
  )[0],
  program: r.RUIN_PROGRAM_ADDRESS,
});
export async function buildRefund(input: {
  table: r.Table;
  tableAddress: Address;
  payer: TransactionSigner;
  quoteMint: Address;
  getAccount: (a: Address) => Promise<{ owner: Address; mint: Address } | null>;
  rent: bigint;
}): Promise<Instruction[]> {
  const { table, quoteMint, payer } = input,
    [ata] = await findAssociatedTokenPda({
      owner: table.trader,
      mint: quoteMint,
      tokenProgram: TOKEN,
    }),
    existing = await input.getAccount(ata),
    ixs: Instruction[] = [];
  let destination = ata;
  if (existing?.owner === table.trader && existing.mint === quoteMint) {
  } else if (!existing)
    ixs.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: table.trader,
        mint: quoteMint,
        tokenProgram: TOKEN,
      }),
    );
  else {
    const account = await generateKeyPairSigner();
    destination = account.address;
    ixs.push(
      getCreateAccountInstruction({
        payer,
        newAccount: account,
        space: 165n,
        lamports: input.rent,
        programAddress: TOKEN,
      }),
      getInitializeAccount3Instruction({
        account: account.address,
        mint: quoteMint,
        owner: table.trader,
      }),
    );
  }
  ixs.push(
    r.getRefundOpenInstruction({
      config: (await r.findConfigPda())[0],
      house: table.house,
      table: input.tableAddress,
      quoteMint,
      vault: (await r.findHouseVaultPda(table.house))[0],
      destination,
      trader: table.trader,
      tokenProgram: TOKEN,
      ...(await eventAccounts()),
    }),
  );
  return ixs;
}
