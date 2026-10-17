import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { isAcceptable, pendingActions, rolesOf, status, steps } from "./model.ts";
import type { ChainEvent, CreditRow, OfferRow } from "./store.tsx";

const IMP = "0x00000000000000000000000000000000000000a1" as Address;
const EXP = "0x00000000000000000000000000000000000000b2" as Address;
const FWD = "0x00000000000000000000000000000000000000c3" as Address;
const FIN = "0x00000000000000000000000000000000000000d4" as Address;
const ev = (name: string, time: number, args: Record<string, unknown> = {}): ChainEvent => ({
  name,
  args: { creditId: 1n, ...args },
  block: 1n,
  tx: "0x01" as Hex,
  logIndex: 0,
  time,
});

function credit(over: Partial<CreditRow> = {}): CreditRow {
  return {
    id: 1n,
    applicant: IMP,
    beneficiary: EXP,
    payee: EXP,
    token: "0x3600000000000000000000000000000000000000",
    expiry: 1000n,
    status: 1,
    feeBps: 0,
    total: 10n,
    outstanding: 10n,
    applicantAgent: null,
    beneficiaryAgent: null,
    terms: "0x00",
    docs: [{ docType: "0x01", attestor: FWD, label: "BILL_OF_LADING" }],
    tranches: [
      {
        amount: 10n,
        requiredDocs: 1,
        satisfiedDocs: 0,
        waivedDocs: 0,
        settled: false,
        documents: [{ doc: 0, required: true, satisfied: false, hash: null, waived: false }],
      },
    ],
    ref: "PO-1",
    openedAt: 100,
    openTx: "0x01" as Hex,
    events: [ev("CreditOpened", 100)],
    ...over,
  } as CreditRow;
}

test("roles follow the connected address", () => {
  const c = credit();
  assert.deepEqual([...rolesOf(c, IMP)], ["importer"]);
  assert.deepEqual([...rolesOf(c, EXP)].sort(), ["exporter", "payee"]);
  assert.deepEqual([...rolesOf(c, FWD)], ["attestor"]);
  assert.equal(rolesOf(c, null).size, 0);
});

test("status reads like a trader would say it", () => {
  assert.equal(status(credit(), 500).label, "Awaiting shipment");
  assert.equal(status(credit(), 1500).label, "Expired, refund due");
  const paid = credit({ status: 2, events: [ev("CreditOpened", 100), ev("TrancheSettled", 200, { amount: 10n }), ev("CreditClosed", 200, { fullyDelivered: true })] });
  assert.equal(status(paid, 300).label, "Paid");
  const cancelled = credit({ status: 2, events: [ev("CreditOpened", 100), ev("TrancheRefunded", 300, { amount: 10n }), ev("CreditClosed", 300, { fullyDelivered: false })] });
  assert.equal(status(cancelled, 400).label, "Cancelled");
  const refunded = credit({ status: 2, events: [ev("CreditOpened", 100), ev("TrancheRefunded", 1200, { amount: 10n }), ev("CreditClosed", 1200, { fullyDelivered: false })] });
  assert.equal(status(refunded, 1300).label, "Expired, refunded");
});

test("stepper marks the current milestone", () => {
  const s = steps(credit(), 500);
  assert.equal(s.find((x) => x.current)?.key, "docs");
  const exp = steps(credit(), 1500);
  assert.ok(exp.some((x) => x.key === "expired"));
});

test("pending actions per role", () => {
  const c = credit();
  const offer: OfferRow = { id: 1n, creditId: 1n, financier: FIN, price: 9n, forOutstanding: 10n, expiry: 1000n, validUntil: 900n, open: true, madeAt: 150, tx: "0x01" };
  assert.deepEqual(pendingActions([c], [offer], FWD, 500).map((a) => a.kind), ["attest"]);
  assert.deepEqual(pendingActions([c], [offer], EXP, 500).map((a) => a.kind), ["offers", "identity"]);
  assert.deepEqual(pendingActions([c], [offer], IMP, 1500).map((a) => a.kind), ["reclaim"]);
  assert.deepEqual(pendingActions([c], [offer], FIN, 950).map((a) => a.kind), ["withdraw"]);
});

test("an offer is acceptable only on the outstanding and expiry it priced", () => {
  const c = credit();
  const offer: OfferRow = { id: 1n, creditId: 1n, financier: FIN, price: 9n, forOutstanding: 10n, expiry: 1000n, validUntil: 900n, open: true, madeAt: 150, tx: "0x01" };
  assert.equal(isAcceptable(offer, c, 500), true);
  assert.equal(isAcceptable(offer, c, 901), false); // lapsed
  assert.equal(isAcceptable({ ...offer, open: false }, c, 500), false);
  assert.equal(isAcceptable(offer, credit({ outstanding: 5n }), 500), false); // a tranche was paid since
  const extended = credit({ expiry: 2000n });
  assert.equal(isAcceptable(offer, extended, 500), false); // the expiry was amended since
  assert.deepEqual(pendingActions([extended], [offer], EXP, 500).map((a) => a.kind), ["identity"]);
  assert.deepEqual(pendingActions([extended], [offer], FIN, 500).map((a) => a.kind), ["withdraw"]);
});
