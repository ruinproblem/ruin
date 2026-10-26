import {
  generateKeyPairSigner,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
} from "@solana-program/token";
import {
  getSettleInstruction,
  RUIN_PROGRAM_ADDRESS,
  type Table,
} from "./src/generated/index.js";
import { findConfigPda, findHouseVaultPda } from "./pdas.js";
import { TOKEN } from "./constants.js";
import { split } from "./math.js";
/** Build atomically with a trader-owned recipient even if the original ATA was closed or reassigned. */
export async function buildSettleInstructions(input: {
  payer: TransactionSigner;
  tableAddress: Address;
  table: Table;
  quoteMint: Address;
  feed: Address;
  price: bigint;
  getAccount: (a: Address) => Promise<{ owner: Address; mint: Address } | null>;
  rent: bigint;
}): Promise<Instruction[]> {
  const { payer, tableAddress, table, quoteMint, feed } = input;
  const { a } = split({
    side: table.side,
    lev: table.lev,
    m: table.m,
    k: table.k,
    eBps: table.eBps,
    p0: table.p0,
    p: input.price,
  });
  let destination: Address | null = null;
  const ixs: Instruction[] = [];
  if (a > 0n) {
    const [associated] = await findAssociatedTokenPda({
      owner: table.trader,
      mint: quoteMint,
      tokenProgram: TOKEN,
    });
    const existing = await input.getAccount(associated);
    if (existing?.owner === table.trader && existing.mint === quoteMint)
      destination = associated;
    else if (!existing) {
      destination = associated;
      ixs.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer,
          owner: table.trader,
          mint: quoteMint,
          tokenProgram: TOKEN,
        }),
      );
    } else {
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
  }
  ixs.push(
    getSettleInstruction({
      config: (await findConfigPda())[0],
      house: table.house,
      table: tableAddress,
      quoteMint,
      vault: (await findHouseVaultPda(table.house))[0],
      trader: table.trader,
      destination: destination ?? undefined,
      feed,
      tokenProgram: TOKEN,
      eventAuthority: (
        await getProgramDerivedAddress({
          programAddress: RUIN_PROGRAM_ADDRESS,
          seeds: ["__event_authority"],
        })
      )[0],
      program: RUIN_PROGRAM_ADDRESS,
    }),
  );
  return ixs;
}
