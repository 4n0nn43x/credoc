import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handler, resolveStatic } from "./index.ts";

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
