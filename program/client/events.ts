import {
  getBase58Encoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import * as generated from "./src/generated/index.js";

const CPI_PREFIX = new Uint8Array([228, 69, 165, 46, 81, 203, 154, 29]);
const decoders = {
  Initialized: generated.getInitializedEventDecoder(),
  RuinSet: generated.getRuinSetEventDecoder(),
  ParamsSet: generated.getParamsSetEventDecoder(),
  FeedSet: generated.getFeedSetEventDecoder(),
  HousePosted: generated.getHousePostedEventDecoder(),
  HouseFunded: generated.getHouseFundedEventDecoder(),
  HouseAccepting: generated.getHouseAcceptingEventDecoder(),
  HouseClosed: generated.getHouseClosedEventDecoder(),
  OpenRequested: generated.getOpenRequestedEventDecoder(),
  Opened: generated.getOpenedEventDecoder(),
  OpenRefunded: generated.getOpenRefundedEventDecoder(),
  CloseRequested: generated.getCloseRequestedEventDecoder(),
  Settled: generated.getSettledEventDecoder(),
};
export type DecodedRuinEvent = {
  [K in keyof typeof decoders]: {
    name: K;
    data: ReturnType<(typeof decoders)[K]["decode"]>;
  };
}[keyof typeof decoders];
export type EventInstruction = {
  programAddress: Address;
  data: ReadonlyUint8Array | string;
};

/** Accept resolved inner instructions; RPC data strings use base58. */
export function decodeEvents(
  instructions: readonly EventInstruction[],
  program: Address = generated.RUIN_PROGRAM_ADDRESS,
): DecodedRuinEvent[] {
  const events: DecodedRuinEvent[] = [];
  for (const ix of instructions) {
    if (ix.programAddress !== program) continue;
    const data =
      typeof ix.data === "string"
        ? getBase58Encoder().encode(ix.data)
        : ix.data;
    if (!CPI_PREFIX.every((x, i) => data[i] === x)) continue;
    let decoded = false;
    for (const [name, decoder] of Object.entries(decoders)) {
      try {
        events.push({
          name,
          data: decoder.decode(data.subarray(8)),
        } as DecodedRuinEvent);
        decoded = true;
        break;
      } catch {
        /* A different event discriminator. */
      }
    }
    if (!decoded) throw new Error("Unknown or malformed RUIN event");
  }
  return events;
}
