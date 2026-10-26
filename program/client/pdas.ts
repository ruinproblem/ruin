import {
  getProgramDerivedAddress,
  getAddressEncoder,
  getU64Encoder,
  type Address,
} from "@solana/kit";
import { RUIN_PROGRAM_ADDRESS } from "./src/generated/index.js";
const pda = (
  seeds: readonly (string | Uint8Array)[],
  programAddress: Address = RUIN_PROGRAM_ADDRESS,
) =>
  getProgramDerivedAddress({
    programAddress,
    seeds: [...seeds],
  });
export const findConfigPda = (programAddress?: Address) =>
  pda(["config"], programAddress);
export const findHousePda = (id: bigint, programAddress?: Address) =>
  pda(["house", getU64Encoder().encode(id) as Uint8Array], programAddress);
export const findHouseVaultPda = (house: Address, programAddress?: Address) =>
  pda(
    ["house_vault", getAddressEncoder().encode(house) as Uint8Array],
    programAddress,
  );
export const findLockVaultPda = (house: Address, programAddress?: Address) =>
  pda(
    ["lock_vault", getAddressEncoder().encode(house) as Uint8Array],
    programAddress,
  );
export const findTablePda = (
  house: Address,
  seq: bigint,
  programAddress?: Address,
) =>
  pda(
    [
      "table",
      getAddressEncoder().encode(house) as Uint8Array,
      getU64Encoder().encode(seq) as Uint8Array,
    ],
    programAddress,
  );
