import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { fillDays, flag, revenue } from "./admin.ts";
import type { ChainEvent } from "./store.tsx";

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const DAY = 86400;
const T0 = 1_800_000_000 - (1_800_000_000 % DAY);
let n = 0;
const ev = (name: string, time: number, args: Record<string, unknown>): ChainEvent => ({
  name,
  args,
  block: BigInt(++n),
  tx: "0x01" as Hex,
  logIndex: 0,
  time,
});

test("revenue: fees net of partner share, per token, plus plans; daily USDC series", () => {
  const tokens: Record<string, string> = { "1": USDC, "2": EURC };
  const dc = [
    ev("TrancheSettled", T0 + 10, { creditId: 1n, fee: 2500n, amount: 1_000_000n }),
    ev("PartnerFeeAccrued", T0 + 10, { creditId: 1n, amount: 500n }),
    ev("TrancheSettled", T0 + DAY, { creditId: 2n, fee: 7000n, amount: 2_000_000n }),
    ev("FeesWithdrawn", T0 + DAY, { token: USDC, amount: 1000n }),
    ev("CreditOpened", T0, { creditId: 1n }),
  ];
  const pass = [
    ev("PassBought", T0 + 100, { account: A, plan: 2, until: BigInt(T0 + 100 + 30 * DAY), payer: A, paid: 99_000_000n }),
    // extension bought by a sponsor: 30 more days from the previous end, not from now
    ev("PassBought", T0 + DAY + 5, { account: A, plan: 2, until: BigInt(T0 + 100 + 60 * DAY), payer: B, paid: 99_000_000n }),
    ev("PassGranted", T0 + 200, { account: B, plan: 1, until: BigInt(T0 + 300) }),
  ];
  const r = revenue(dc, pass, (id) => tokens[id.toString()], USDC, T0 + 2 * DAY, T0, 3);
  assert.equal(r.fees.get(USDC.toLowerCase()), 2000n);
  assert.equal(r.fees.get(EURC.toLowerCase()), 7000n);
  assert.equal(r.partners.get(USDC.toLowerCase()), 500n);
  assert.equal(r.withdrawn.get(USDC.toLowerCase()), 1000n);
  assert.deepEqual(r.plans.importer, { paid: 198_000_000n, count: 2, active: 1 });
  assert.deepEqual(r.plans.attestor, { paid: 0n, count: 0, active: 0 }); // granted, already ended
  assert.equal(r.total.get(USDC.toLowerCase()), 198_002_000n);
  assert.deepEqual(r.dailyFees, [2000, 0, 0]); // the EURC fee is not mixed into the USDC chart
  assert.deepEqual(r.dailyPlans, [99_000_000, 99_000_000, 0]);
  assert.match(r.lines[1]!.text, /^0x0000…00b2 bought the Importer plan for 0x0000…00a1 for 30 days, 99\.00 USDC$/);
  assert.match(r.lines[2]!.text, /was granted the Attestor plan/);
});

test("fillDays pads missing days with zero", () => {
  const rows = fillDays([{ day: "2026-01-02", views: 5, visitors: 2 }], "2026-01-01", 3);
  assert.deepEqual(
    rows.map((r) => [r.day, r.views]),
    [["2026-01-01", 0], ["2026-01-02", 5], ["2026-01-03", 0]],
  );
});

test("flag from an ISO country code", () => {
  assert.equal(flag("fr"), "\u{1F1EB}\u{1F1F7}");
  assert.equal(flag(""), "");
});
