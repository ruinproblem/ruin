import { it, expect } from "vitest";
import { FailedTransactionMetadata } from "litesvm";
import { readFileSync } from "node:fs";
import { Harness, PROGRAM, accountData } from "./harness.js";
import { devFeedInstruction, findDevFeedPda } from "../scripts/dev-feed.js";
import { getAddressDecoder } from "@solana/kit";
it("P0 devnet-only instructions and oracle ownership are absent from production and work with authority in devnet", async () => {
  const main = await Harness.create({ initialize: false });
  const ix = await devFeedInstruction({
    authority: main.admin,
    programData: main.programData,
    market: 0,
  });
  const rejected = main.svm.sendTransaction(
    await main.transaction([ix], main.admin),
  );
  expect(rejected).toBeInstanceOf(FailedTransactionMetadata);
  const h = await Harness.create({
    initialize: false,
    binary: "../target/devnet/ruin.so",
  });
  for (let market = 0; market < 3; market++) {
    const wrong = await devFeedInstruction({
      authority: h.stranger,
      programData: h.programData,
      market,
    });
    let result = h.svm.sendTransaction(
      await h.transaction([wrong], h.stranger),
    );
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    if (result instanceof FailedTransactionMetadata)
      expect(result.meta().logs().join("\n")).toContain("NotUpgradeAuthority");
    for (const input of [
      { market },
      { market, price: 10677218000n, publishTs: 1000n },
    ]) {
      const instruction = await devFeedInstruction({
        authority: h.admin,
        programData: h.programData,
        ...input,
      });
      const result = h.svm.sendTransaction(
        await h.transaction([instruction], h.admin),
      );
      if (result instanceof FailedTransactionMetadata)
        throw new Error(result.meta().logs().join("\n"));
    }
    const d = accountData(h.svm, (await findDevFeedPda(market))[0]);
    expect(d.length).toBe(394);
    expect(d.subarray(0, 8).toString("hex")).toBe("70f98bd9d7d0f936");
    expect(getAddressDecoder().decode(d.subarray(8, 40))).toBe(
      [
        "So11111111111111111111111111111111111111112",
        "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
        "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
      ][market],
    );
    expect(d[176]).toBe(248);
    expect(d.readBigUInt64LE(168)).toBe(10677218000n);
    expect(d.readBigInt64LE(177)).toBe(1000n);
  }
  await h.send(
    "init",
    h.initIx({
      solFeed: (await findDevFeedPda(0))[0],
      btcFeed: (await findDevFeedPda(1))[0],
      ethFeed: (await findDevFeedPda(2))[0],
    }),
    h.admin,
  );
  const house = await h.post();
  const t = await h.tableRef(house);
  await h.send(
    "request_open",
    h.requestIx(t, { feed: (await findDevFeedPda(0))[0] }),
    h.trader,
  );
  const idl = JSON.parse(
    readFileSync(new URL("../client/idl/ruin.json", import.meta.url), "utf8"),
  );
  expect(idl.instructions.some((i: any) => i.name.startsWith("dev_feed"))).toBe(
    false,
  );
});
