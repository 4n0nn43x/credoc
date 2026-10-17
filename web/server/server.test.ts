import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BRAND, brandFor, handler, parsePartners, rateLimiter, resolveStatic, rpcAllowed } from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "credoc-static-"));
mkdirSync(join(root, "app"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<h1>landing</h1>");
writeFileSync(join(root, "app", "index.html"), "<h1>app</h1>");
writeFileSync(join(root, "assets", "a-123.js"), "console.log(1)");
writeFileSync(join(root, "..", "secret-outside-root.txt"), "nope");

test("static paths cannot escape the root", async () => {
  assert.equal(await resolveStatic(root, "/"), join(root, "index.html"));
  assert.equal(await resolveStatic(root, "/app/"), join(root, "app", "index.html"));
  assert.equal(await resolveStatic(root, "/../secret-outside-root.txt"), null);
  assert.equal(await resolveStatic(root, "/%2e%2e/secret-outside-root.txt"), null);
  assert.equal(await resolveStatic(root, "/%2e%2e%2fsecret-outside-root.txt"), null);
  assert.equal(await resolveStatic(root, "/assets/%00.js"), null);
  assert.equal(await resolveStatic(root, "/%E0%A4%A"), null); // malformed escape
  assert.equal(await resolveStatic(root, "/missing.js"), null);
});

test("serves pages, assets, health and rejects bad relay calls", async () => {
  const server = createServer(handler(root, () => ({ relayerKey: undefined, contract: undefined })));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/app/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.match(await page.text(), /app/);

    const asset = await fetch(`${base}/assets/a-123.js`);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");

    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${base}/api/relay`)).status, 405);
    assert.equal((await fetch(`${base}/api/relay`, { method: "POST", body: "{not json" })).status, 400);
    assert.equal((await fetch(`${base}/api/relay`, { method: "POST", body: "x".repeat(20_000) })).status, 413);
    // no relayer key configured: refused before any chain call
    assert.equal((await fetch(`${base}/api/relay`, { method: "POST", body: "{}" })).status, 503);
  } finally {
    server.close();
  }
});

test("a failing handler answers 500 and a failing analytics write is ignored, the server keeps serving", async () => {
  const broken = { hit() { throw new Error("disk full"); }, event() { throw new Error("disk full"); } };
  const env = (): never => {
    throw new Error("boom");
  };
  const server = createServer(handler(root, env, broken as never));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/hit`, { method: "POST", body: JSON.stringify({ p: "/" }), headers: { "user-agent": "Mozilla/5.0" } })).status, 204);
    assert.equal((await fetch(`${base}/api/relay`, { method: "POST", body: "{}" })).status, 500);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    server.close();
  }
});

test("rate limits: token bucket per client, bounded memory, relays capped per IP", async () => {
  const limit = rateLimiter(3, 1, 2);
  assert.deepEqual([1, 2, 3, 4].map(() => limit("a", 1, 0)), [true, true, true, false]);
  assert.equal(limit("a", 1, 1_000), true, "refills over time");
  assert.equal(limit("a", 2, 1_000), false, "a batch costs one token per call");
  limit("b", 1, 1_000);
  limit("c", 1, 1_000); // only two clients remembered: "a" is forgotten, and starts full again
  assert.equal(limit("a", 3, 1_000), true);

  const server = createServer(handler(root, () => ({ relayerKey: undefined, contract: undefined })));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await fetch(`${base}/api/relay`, { method: "POST", body: "{}" })).status);
    assert.deepEqual(codes, [...Array(10).fill(503), 429]);
    assert.equal((await fetch(`${base}/api/relay`, { method: "POST", body: "{}", headers: { "x-forwarded-for": "9.9.9.9" } })).status, 503, "per client");
  } finally {
    server.close();
  }
});

test("brand per host: validated partners, everything else gets the default", async () => {
  const p = "0x" + "ab".repeat(20);
  const table = parsePartners({
    "lc.bank.example": { name: "Bank LC", partner: p, integratorFeeBps: 30, supportUrl: "https://bank.example/help" },
    "big.example": { name: "Greedy", partner: p, integratorFeeBps: 51 },
    "nopartner.example": { name: "Fee without partner", partner: null, integratorFeeBps: 10 },
    "bad.example": { name: "Bad address", partner: "0x123", integratorFeeBps: 0 },
    "frac.example": { name: "Fraction", partner: p, integratorFeeBps: 1.5 },
    "Upper.example": { name: "Uppercase key", partner: null, integratorFeeBps: 0 },
  });
  assert.deepEqual([...table.keys()], ["lc.bank.example"]);
  assert.equal(brandFor("LC.Bank.Example:443", table).name, "Bank LC");
  assert.equal(brandFor("big.example", table), DEFAULT_BRAND);
  assert.equal(brandFor("lc.bank.example/../x", table), DEFAULT_BRAND);
  assert.equal(brandFor(undefined, table), DEFAULT_BRAND);
  assert.equal(parsePartners(null).size, 0);
  // the shipped file: Credoc's own hosts, no partner
  assert.deepEqual(brandFor("www.credoc.xyz"), { name: "Credoc", partner: null, integratorFeeBps: 0 });

  const server = createServer(handler(root, () => ({ relayerKey: undefined, contract: undefined })));
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await new Promise<{ status?: number; cache?: string; body: string }>((ok, fail) =>
      get({ port, path: "/brand.json", headers: { host: "unknown.example" } }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => ok({ status: r.statusCode, cache: r.headers["cache-control"], body }));
      }).on("error", fail),
    );
    assert.equal(res.status, 200);
    assert.equal(res.cache, "public, max-age=300");
    assert.deepEqual(JSON.parse(res.body), DEFAULT_BRAND);
  } finally {
    server.close();
  }
});

test("the RPC proxy only forwards read methods", () => {
  assert.equal(rpcAllowed({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [] }), true);
  assert.equal(rpcAllowed([{ method: "eth_call" }, { method: "eth_blockNumber" }]), true);
  assert.equal(rpcAllowed({ method: "eth_sendRawTransaction" }), false);
  assert.equal(rpcAllowed([{ method: "eth_call" }, { method: "debug_traceTransaction" }]), false);
  assert.equal(rpcAllowed([]), false);
  assert.equal(rpcAllowed(Array.from({ length: 51 }, () => ({ method: "eth_call" }))), false);
  assert.equal(rpcAllowed(null), false);
});

test("the admin API only answers on its own host, and that host is not counted as traffic", async () => {
  const { openStore } = await import("./analytics.ts");
  const { request } = await import("node:http");
  const store = openStore(mkdtempSync(join(tmpdir(), "credoc-admin-")));
  const admin = { admins: [], secret: "k".repeat(32), host: "back.example.org" };
  const server = createServer(handler(root, () => ({}), store, admin));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  // fetch() cannot set Host, so plain http requests
  const call = (host: string, path: string, body?: string) =>
    new Promise<number>((ok, ko) => {
      const req = request({ port, path, method: body ? "POST" : "GET", headers: { host, "content-type": "application/json", "user-agent": "Mozilla/5.0" } }, (res) => {
        res.resume();
        ok(res.statusCode!);
      });
      req.on("error", ko);
      req.end(body);
    });
  try {
    assert.equal(await call("credoc.xyz", "/api/admin/nonce"), 404);
    assert.equal(await call("back.example.org:443", "/api/admin/nonce"), 200);
    await call("back.example.org", "/api/hit", JSON.stringify({ p: "/" }));
    await call("credoc.xyz", "/api/hit", JSON.stringify({ p: "/" }));
    assert.equal(store.stats(1).views, 1);
  } finally {
    server.close();
  }
});
