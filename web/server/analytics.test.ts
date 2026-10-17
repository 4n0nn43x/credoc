import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { deviceOf, login, loginMessage, logout, openStore, parseHit, session } from "./analytics.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/140";

test("beacons are validated, routes grouped, own host never counted as a referrer", () => {
  const h = parseHit({ p: "/app/#/credits/12", r: "https://www.google.com/search?q=x", tz: "Africa/Abidjan", w: 1440, s: "Twitter!" }, "credoc.xyz");
  assert.deepEqual(h, { path: "/app/#/credits/:id", referrer: "google.com", tz: "Africa/Abidjan", width: 1440, source: "twitter" });
  assert.equal(parseHit({ p: "/", r: "https://credoc.xyz/app/" }, "credoc.xyz")!.referrer, "");
  assert.equal(parseHit({ p: "javascript:alert(1)" }, "credoc.xyz"), null);
  assert.equal(parseHit(null, "credoc.xyz"), null);
  assert.equal(deviceOf(390, "Mozilla/5.0 (iPhone)"), "mobile");
  assert.equal(deviceOf(1440, UA), "desktop");
});

test("visits are counted per day without storing the IP, bots are skipped", () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "credoc-data-")));
  const t = Date.UTC(2026, 9, 13, 12);
  const hit = (ip: string, path = "/", ua = UA, now = t) =>
    store.hit(parseHit({ p: path, r: "https://x.com/post", tz: "Europe/Paris", w: 1440 }, "credoc.xyz")!, ip, ua, now);
  hit("1.1.1.1");
  hit("1.1.1.1", "/app/");
  hit("2.2.2.2");
  hit("3.3.3.3", "/", "Googlebot/2.1");
  hit("1.1.1.1", "/", UA, t + 86_400_000); // the same person the next day is a new daily visitor
  const s = store.stats(30, t + 86_400_000);
  assert.equal(s.views, 4);
  assert.equal(s.visitors, 3);
  assert.deepEqual({ ...s.countries[0] }, { key: "FR", views: 4, visitors: 3 });
  assert.equal(s.referrers[0]!.key, "x.com");
  assert.equal(s.series.length, 2);
  store.event("relay", t);
  assert.deepEqual(store.stats(30, t).events.map((e) => ({ ...e })), [{ kind: "relay", n: 1 }]);
});

test("the daily visitor salt is random: the same visitor hashes differently in another process", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const t = Date.UTC(2026, 9, 13, 12);
  const ids = [1, 2].map(() => {
    const dir = mkdtempSync(join(tmpdir(), "credoc-salt-"));
    const store = openStore(dir);
    const hit = parseHit({ p: "/" }, "credoc.xyz")!;
    store.hit(hit, "1.1.1.1", UA, t);
    store.hit(hit, "1.1.1.1", UA, t + 1000);
    return (new DatabaseSync(join(dir, "credoc.db")).prepare("SELECT DISTINCT visitor FROM hits").all() as { visitor: string }[]).map((r) => r.visitor);
  });
  assert.equal(ids[0]!.length, 1, "one visitor within the day");
  assert.notEqual(ids[0]![0], ids[1]![0], "not derivable from a shared secret and the date");
});

test("the free relay quota survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "credoc-relays-"));
  const now = Date.now();
  openStore(dir).relays.add("attestor:0xab", now);
  const again = openStore(dir).relays;
  assert.equal(again.count("attestor:0xab", now - 1000), 1);
  assert.equal(again.count("attestor:0xab", now), 0, "outside the window");
  assert.equal(again.count("attestor:0xcd", 0), 0);
});

test("admin sign-in: only listed wallets, single-use nonce, tamper-proof cookie", async () => {
  const admin = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const other = privateKeyToAccount(`0x${"34".repeat(32)}`);
  const env = { admins: [admin.address], secret: "k".repeat(32) };

  const m1 = loginMessage("credoc.xyz");
  const token = await login(env, m1, await admin.signMessage({ message: m1 }));
  assert.ok(token);
  assert.equal(session(env, `foo=1; credoc_admin=${token}`), admin.address);
  assert.equal(await login(env, m1, await admin.signMessage({ message: m1 })), null, "nonce is single use");

  const m2 = loginMessage("credoc.xyz");
  assert.equal(await login(env, m2, await other.signMessage({ message: m2 })), null, "not an admin");
  assert.equal(await login(env, "Nonce: deadbeef", "0x00"), null);

  const m3 = loginMessage("credoc.xyz");
  const forged = m3.replace("credoc.xyz", "evil.example"); // same nonce, another site's text
  assert.equal(await login(env, forged, await admin.signMessage({ message: forged })), null, "only the exact issued message");
  assert.equal(await login(env, m3, await admin.signMessage({ message: m3 })), null, "and its nonce is spent");

  const first = loginMessage("credoc.xyz");
  for (let i = 0; i < 1_000; i++) loginMessage("credoc.xyz");
  assert.equal(await login(env, first, await admin.signMessage({ message: first })), null, "pending nonces are capped");

  const [addr, exp, mac] = token!.split(".");
  assert.equal(session(env, `credoc_admin=${addr}.${Number(exp) + 1}.${mac}`), null, "expiry cannot be extended");
  assert.equal(session(env, `credoc_admin=${token}`, Number(exp) + 1), null, "expired");
  assert.equal(session({ ...env, admins: [] }, `credoc_admin=${token}`), null, "removed admins lose access");

  const m4 = loginMessage("credoc.xyz");
  const other4 = await login(env, m4, await admin.signMessage({ message: m4 }), Date.now() + 1);
  logout(env, `credoc_admin=${token}`);
  assert.equal(session(env, `credoc_admin=${token}`), null, "signed out on the server too");
  assert.equal(session(env, `credoc_admin=${other4}`), admin.address, "other sessions stay");
});
