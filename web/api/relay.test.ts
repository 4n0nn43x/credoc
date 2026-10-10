import { test } from "node:test";
import assert from "node:assert/strict";
import { relayPresentation } from "./_relay-core.ts";

const env = {
  rpcUrl: "http://127.0.0.1:1", // unreachable on purpose: these cases must be rejected before any network call
  contract: "0x0000000000000000000000000000000000000c0c",
  relayerKey: `0x${"11".repeat(32)}`,
};
const good = {
  creditId: "1",
  tranche: 0,
  doc: 1,
  docHash: `0x${"22".repeat(32)}`,
  deadline: "9999999999",
  signature: `0x${"ab".repeat(65)}`,
};

test("refuses to run without configuration", async () => {
  assert.equal((await relayPresentation(good, { ...env, relayerKey: undefined })).status, 503);
  assert.equal((await relayPresentation(good, { ...env, contract: "nope" })).status, 503);
});

test("rejects malformed presentations before touching the network", async () => {
  const cases: Record<string, unknown>[] = [
    { ...good, tranche: 8 },
    { ...good, doc: -1 },
    { ...good, creditId: "abc" },
    { ...good, docHash: "0x1234" },
    { ...good, signature: "0x12" },
    { ...good, deadline: undefined },
  ];
  for (const c of cases) {
    const r = await relayPresentation(c, env);
    assert.equal(r.status, 400, JSON.stringify(c));
  }
  assert.equal((await relayPresentation(null, env)).status, 400);
});

test("a well-formed request reaches the chain (and fails cleanly when it is unreachable)", async () => {
  const r = await relayPresentation(good, env);
  assert.equal(r.status, 502);
});
