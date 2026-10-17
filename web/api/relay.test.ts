import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Hex, encodeAbiParameters, encodeFunctionResult, parseAbi, parseTransaction, toFunctionSelector } from "viem";
import { FREE_RELAYS, FREE_RELAYS_PER_APPLICANT, RELAY_GAS_LIMIT, freeQuota, memoryLedger, relayPresentation, reserve } from "./_relay-core.ts";

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

test("the free relay quota allows FREE_RELAYS per attestor per 30 days, then refills", () => {
  const who = "0x00000000000000000000000000000000000000aA";
  const t0 = 1_800_000_000_000;
  assert.equal(freeQuota.left(who, t0), FREE_RELAYS);
  for (let i = 0; i < FREE_RELAYS; i++) freeQuota.take(who.toUpperCase().replace("0X", "0x"), t0 + i);
  assert.equal(freeQuota.left(who, t0 + 10), 0, "case-insensitive per attestor");
  assert.equal(freeQuota.left("0x00000000000000000000000000000000000000bb", t0), FREE_RELAYS);
  assert.equal(freeQuota.left(who, t0 + 31 * 86_400_000), FREE_RELAYS, "a month later");
});

/** A fake Arc JSON-RPC: credit 1 has doc 1 nominated to `attestor`, no CredocPass, and every transaction reverts. */
async function fakeChain(o: { attestorCode?: Hex; receipt?: "none"; refuseSend?: boolean } = {}) {
  const views = parseAbi([
    "function pass() view returns (address)",
    "function getDocs(uint256 id) view returns ((bytes32 docType, address attestor)[])",
  ]);
  const attestor = "0x00000000000000000000000000000000000a77e5";
  const applicant = "0x000000000000000000000000000000000000a991";
  const zero32 = `0x${"00".repeat(32)}` as Hex;
  const types = ["address", "address", "address", "address", "uint64", "uint8", "uint16", "uint128", "uint128", "uint256", "uint256", "bytes32", "address", "uint16", "uint16"];
  const credit = encodeAbiParameters(
    [{ type: "tuple", components: types.map((type) => ({ type })) }],
    [[applicant, applicant, applicant, applicant, 0n, 1, 0, 0n, 0n, 0n, 0n, zero32, applicant, 0, 0]] as never,
  );
  const sent: bigint[] = [];
  const nonces: number[] = [];
  const answer = (method: string, params: unknown[]): unknown => {
    const p0 = (params[0] ?? {}) as { data?: string; input?: string };
    const data = String(p0.data ?? p0.input ?? "");
    switch (method) {
      case "eth_chainId":
        return "0x13b2";
      case "eth_call":
        if (data === toFunctionSelector("pass()")) return encodeFunctionResult({ abi: views, functionName: "pass", result: `0x${"00".repeat(20)}` });
        if (data.startsWith(toFunctionSelector("getDocs(uint256)")))
          return encodeFunctionResult({ abi: views, functionName: "getDocs", result: [{ docType: zero32, attestor: applicant }, { docType: zero32, attestor }] });
        if (data.startsWith(toFunctionSelector("getCredit(uint256)"))) return credit;
        return "0x"; // presentWithSig: the simulation passes
      case "eth_getCode":
        return o.attestorCode ?? "0x";
      case "eth_getTransactionCount":
        return `0x${(5 + nonces.length).toString(16)}`; // pending count: 5 earlier transactions, plus those broadcast here
      case "eth_getBlockByNumber":
        return { number: "0x1", hash: `0x${"11".repeat(32)}`, baseFeePerGas: "0x1", timestamp: "0x1", transactions: [] };
      case "eth_maxPriorityFeePerGas":
      case "eth_gasPrice":
        return "0x1";
      case "eth_blockNumber":
        return "0x2";
      case "eth_sendRawTransaction":
        if (o.refuseSend) throw new Error("insufficient funds for gas");
        sent.push(parseTransaction(params[0] as Hex).gas!);
        nonces.push(parseTransaction(params[0] as Hex).nonce!);
        return `0x${"ab".repeat(32)}`;
      case "eth_getTransactionReceipt":
        if (o.receipt === "none") return null;
        return {
          transactionHash: `0x${"ab".repeat(32)}`, status: "0x0", blockNumber: "0x2", blockHash: `0x${"11".repeat(32)}`, logs: [],
          gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", transactionIndex: "0x0", type: "0x2",
          from: applicant, to: applicant, contractAddress: null, logsBloom: `0x${"00".repeat(256)}`,
        };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const one = (c: { id: unknown; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params ?? []) };
        } catch (e) {
          return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: (e as Error).message } };
        }
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, sent, nonces, attestor, applicant, close: () => server.close() };
}

test("a relayed presentation is sent with the gas cap and counted before sending, even when it reverts", async () => {
  const chain = await fakeChain();
  try {
    const ledger = memoryLedger();
    const r = await relayPresentation(good, { ...env, rpcUrl: chain.url }, ledger);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "transaction reverted");
    assert.deepEqual(chain.sent, [RELAY_GAS_LIMIT]);
    const since = Date.now() - 60_000;
    assert.equal(ledger.count(`attestor:${chain.attestor}`, since), 1, "the revert used the attestor's free relay");
    assert.equal(ledger.count(`applicant:${chain.applicant}`, since), 1, "and the importer's");
  } finally {
    chain.close();
  }
});

test("a presentation the RPC refuses to broadcast gives the free relay back", async () => {
  const chain = await fakeChain({ refuseSend: true });
  try {
    const ledger = memoryLedger();
    const r = await relayPresentation(good, { ...env, rpcUrl: chain.url }, ledger);
    assert.equal(r.status, 502);
    const since = Date.now() - 60_000;
    assert.equal(ledger.count(`attestor:${chain.attestor}`, since), 0);
    assert.equal(ledger.count(`applicant:${chain.applicant}`, since), 0);
  } finally {
    chain.close();
  }
});

test("reserve leaves no half reservation when the store fails", () => {
  const ledger = memoryLedger();
  const failing = { ...ledger, add: (key: string, now: number) => (key === "b" ? (() => { throw new Error("disk full"); })() : ledger.add(key, now)) };
  assert.throws(() => reserve(failing, [["a", 1], ["b", 1]], 1_000));
  assert.equal(ledger.count("a", 0), 0);
});

test("the free tier is for wallet attestors only, and is capped per importer too", async () => {
  const contractAttestor = await fakeChain({ attestorCode: "0x6080" });
  try {
    const r = await relayPresentation(good, { ...env, rpcUrl: contractAttestor.url }, memoryLedger());
    assert.equal(r.status, 402);
    assert.deepEqual(contractAttestor.sent, [], "nothing sent for a contract attestor without a plan");
  } finally {
    contractAttestor.close();
  }
  const chain = await fakeChain();
  try {
    const ledger = memoryLedger();
    for (let i = 0; i < FREE_RELAYS_PER_APPLICANT; i++) ledger.add(`applicant:${chain.applicant}`, Date.now());
    const r = await relayPresentation(good, { ...env, rpcUrl: chain.url }, ledger);
    assert.equal(r.status, 402, "a fresh attestor does not refill the importer's quota");
    assert.deepEqual(chain.sent, []);
  } finally {
    chain.close();
  }
});

test("no receipt in time answers 202 with the hash, and the same document cannot be relayed twice at once", async () => {
  const chain = await fakeChain({ receipt: "none" });
  try {
    const e = { ...env, rpcUrl: chain.url, receiptTimeoutMs: 1_500 };
    const first = relayPresentation(good, e, memoryLedger());
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await relayPresentation(good, e, memoryLedger())).status, 409);
    assert.deepEqual(await first, { status: 202, body: { hash: `0x${"ab".repeat(32)}`, status: "pending" } });
  } finally {
    chain.close();
  }
});

test("concurrent relays get distinct nonces", async () => {
  const chain = await fakeChain();
  try {
    const e = { ...env, rpcUrl: chain.url, relayerKey: `0x${"13".repeat(32)}` }; // own relayer: a fresh nonce sequence
    await Promise.all([relayPresentation({ ...good, doc: 0 }, e, memoryLedger()), relayPresentation(good, e, memoryLedger())]);
    assert.deepEqual([...chain.nonces].sort(), [5, 6]);
  } finally {
    chain.close();
  }
});

test("reserve takes every limit or none", () => {
  const ledger = memoryLedger();
  ledger.add("b", 1_000);
  assert.equal(reserve(ledger, [["a", 1], ["b", 1]], 2_000), false);
  assert.equal(ledger.count("a", 0), 0, "nothing taken when one limit is full");
  assert.equal(reserve(ledger, [["a", 1], ["c", 1]], 2_000), true);
  assert.equal(reserve(ledger, [["a", 1]], 3_000), false);
});
