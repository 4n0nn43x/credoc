import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpcProxy, rpcAllowed } from "./rpc.ts";

/** A fake Arc: counts calls, can rate-limit the first n of them. */
function fakeArc(limitFirst = 0) {
  const seen: string[] = [];
  let left = limitFirst;
  const f = (async (_url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body));
    seen.push(c.method);
    if (left-- > 0) return new Response("Too Many Requests", { status: 429 });
    const result =
      c.method === "eth_getBlockByNumber" ? { number: "0x64" } : c.method === "eth_getLogs" ? [{ data: "0x1" }] : "0x64";
    return Response.json({ jsonrpc: "2.0", id: c.id, result });
  }) as typeof fetch;
  return { f, seen };
}

const logs = (from: string, to: string) => ({ jsonrpc: "2.0", id: 7, method: "eth_getLogs", params: [{ fromBlock: from, toBlock: to }] });

test("logs of a past range are fetched from Arc once, then served from memory", async () => {
  const arc = fakeArc();
  const rpc = createRpcProxy(() => "http://arc", arc.f);
  await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }); // head = 100
  for (let i = 0; i < 3; i++) assert.deepEqual(await rpc(logs("0x1", "0x50")), { jsonrpc: "2.0", id: 7, result: [{ data: "0x1" }] });
  assert.equal(arc.seen.filter((m) => m === "eth_getLogs").length, 1);
  await rpc(logs("0x1", "0x99")); // beyond the head: may still change, never cached
  await rpc(logs("0x1", "0x99"));
  assert.equal(arc.seen.filter((m) => m === "eth_getLogs").length, 3);
});

test("batches keep their order and ids", async () => {
  const rpc = createRpcProxy(() => "http://arc", fakeArc().f);
  const out = (await rpc([
    { jsonrpc: "2.0", id: "a", method: "eth_chainId" },
    { jsonrpc: "2.0", id: "b", method: "eth_blockNumber" },
  ])) as { id: string }[];
  assert.deepEqual(out.map((r) => r.id), ["a", "b"]);
});

test("a rate-limited call is retried instead of failing the page", async () => {
  const arc = fakeArc(2);
  const rpc = createRpcProxy(() => "http://arc", arc.f);
  const r = (await rpc({ jsonrpc: "2.0", id: 3, method: "eth_chainId" })) as { result?: string };
  assert.equal(r.result, "0x64");
  assert.equal(arc.seen.length, 3);
});

test("identical calls in flight share one request", async () => {
  const arc = fakeArc();
  const rpc = createRpcProxy(() => "http://arc", arc.f);
  await Promise.all([1, 2, 3].map((id) => rpc({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: "0x1" }, "latest"] })));
  assert.equal(arc.seen.length, 1);
});

test("only read methods pass", () => {
  assert.equal(rpcAllowed({ method: "eth_getLogs" }), true);
  assert.equal(rpcAllowed({ method: "eth_sendRawTransaction" }), false);
});
