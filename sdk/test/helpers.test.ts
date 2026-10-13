import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, recoverTypedDataAddress } from "viem";
import { arc } from "viem/chains";
import {
  docs,
  docType,
  docLabel,
  hashDocument,
  quoteAssignment,
  validateOpenParams,
  signPresentation,
  presentationDomain,
  presentationTypes,
} from "../src/index.ts";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const F = "0x00000000000000000000000000000000000000f3";

test("docs() builds the bitmask and rejects bad indexes", () => {
  assert.equal(docs(0), 1);
  assert.equal(docs(0, 2), 5);
  assert.throws(() => docs(8));
});

test("docType and docLabel round-trip standard labels", () => {
  assert.equal(docLabel(docType("BILL_OF_LADING")), "BILL_OF_LADING");
  const unknown = docType("CUSTOM_DOC");
  assert.equal(docLabel(unknown), unknown);
});

test("hashDocument is keccak256 of the raw bytes", () => {
  assert.equal(
    hashDocument(new Uint8Array()),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});

test("validateOpenParams mirrors the contract checks", () => {
  const now = 1_000_000n;
  const good = {
    beneficiary: B,
    token: F,
    expiry: now + 86400n,
    terms: docType("x"),
    docs: [{ docType: docType("BILL_OF_LADING"), attestor: F }],
    tranches: [{ amount: 1n, requiredDocs: 1 }],
  } as const;
  assert.deepEqual(validateOpenParams({ ...good, docs: [...good.docs], tranches: [...good.tranches] }, A, now), []);
  const bad = validateOpenParams(
    {
      ...good,
      beneficiary: A,
      expiry: now,
      docs: [{ docType: docType("BILL_OF_LADING"), attestor: A }],
      tranches: [{ amount: 0n, requiredDocs: 2 }],
    },
    A,
    now,
  );
  assert.equal(bad.length, 5);
});

test("quoteAssignment discounts more for unknown exporters and longer tenors", () => {
  const outstanding = 10_000_000_000n; // 10,000 USDC
  const unknown = quoteAssignment({ outstanding, daysToExpiry: 60 });
  const proven = quoteAssignment({
    outstanding,
    daysToExpiry: 60,
    reputation: { delivered: 40, waived: 0, expired: 0, cancelled: 0, skipped: 0, onTimeRate: 1, averageTicket: 1n },
  });
  const hiding = quoteAssignment({
    outstanding,
    daysToExpiry: 60,
    reputation: { delivered: 40, waived: 0, expired: 0, cancelled: 0, skipped: 1, onTimeRate: 1, averageTicket: 1n },
  });
  assert.equal(hiding.price, unknown.price, "refused entries void the record");
  assert.ok(unknown.price < proven.price);
  assert.ok(Math.abs(proven.annualRate - 0.08) < 1e-9);
  assert.ok(Math.abs(unknown.annualRate - 0.28) < 1e-9);
  assert.equal(quoteAssignment({ outstanding, daysToExpiry: 0 }).price, outstanding);
  assert.equal(unknown.discount, outstanding - unknown.price);
});

test("signPresentation produces a signature recoverable to the attestor", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const wallet = createWalletClient({ account, chain: arc, transport: http("http://127.0.0.1:1") });
  const contract = "0x0000000000000000000000000000000000000c0c";
  const p = { creditId: 1n, tranche: 0, doc: 1, docHash: docType("file"), deadline: 123n };
  const s = await signPresentation(wallet, contract, 5042, p);
  const signer = await recoverTypedDataAddress({
    domain: presentationDomain(5042, contract),
    types: presentationTypes,
    primaryType: "Presentation",
    message: p,
    signature: s.signature,
  });
  assert.equal(signer, account.address);
  assert.equal(s.attestor, account.address);
});
