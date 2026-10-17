/**
 * First-party analytics and the admin session, with no third party and no tracking cookie.
 *
 * Visits: the page sends a small beacon (path, referrer, time zone, screen width). The server stores the day, the path,
 * the referring host, a country derived from the time zone, a device class, and a visitor id that is a hash of the IP
 * and user agent with a secret that changes every day: a visitor can be counted within a day, never followed across
 * days, and no IP is stored. Bots and Do Not Track browsers are not counted.
 *
 * Admin: wallets listed in ADMIN_ADDRESSES sign a one-time message; the server answers with an HttpOnly cookie signed
 * with ADMIN_SECRET. Stats are only served to that cookie.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Address, type Hex, getAddress, isAddress, recoverMessageAddress } from "viem";
import type { RelayLedger } from "../api/_relay-core";
import tzCountry from "./tz-country.json" with { type: "json" };

const TZ = tzCountry as Record<string, string>;
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|curl|wget|python|httpclient|monitor/i;
const RETENTION_DAYS = 400;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export type Hit = { path: string; referrer: string; tz: string; width: number; source: string };

/** Validates a beacon body; null if it is not one. */
export function parseHit(body: unknown, host: string): Hit | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  // routes are grouped: /app/#/credits/12 and /app/#/credits/13 are one page
  const path = str(b.p, 200).replace(/\/(0x[0-9a-fA-F]{6,}|\d+)(?=\/|$)/g, "/:id");
  if (!path.startsWith("/")) return null;
  let referrer = "";
  try {
    const r = new URL(str(b.r, 500));
    if (r.hostname && r.hostname !== host) referrer = r.hostname.replace(/^www\./, "");
  } catch {
    /* no or invalid referrer: direct visit */
  }
  return {
    path,
    referrer,
    tz: str(b.tz, 64),
    width: Number.isFinite(b.w) ? Math.max(0, Math.min(10_000, Math.round(b.w as number))) : 0,
    source: str(b.s, 64).toLowerCase().replace(/[^a-z0-9._-]/g, ""),
  };
}

export const deviceOf = (width: number, ua: string) =>
  /ipad|tablet/i.test(ua) || (width >= 600 && width < 1024) ? "tablet" : /mobi|android|iphone/i.test(ua) || (width > 0 && width < 600) ? "mobile" : "desktop";

export function openStore(dir: string, secret: string) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "credoc.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS hits (ts INTEGER, day TEXT, path TEXT, ref TEXT, country TEXT, device TEXT, visitor TEXT, source TEXT);
    CREATE INDEX IF NOT EXISTS hits_day ON hits(day);
    CREATE TABLE IF NOT EXISTS events (ts INTEGER, day TEXT, kind TEXT);
    CREATE INDEX IF NOT EXISTS events_day ON events(day);
    CREATE TABLE IF NOT EXISTS relays (ts INTEGER, key TEXT);
    CREATE INDEX IF NOT EXISTS relays_key ON relays(key, ts);
  `);
  const cutoff = day(Date.now() - RETENTION_DAYS * 86_400_000);
  db.prepare("DELETE FROM hits WHERE day < ?").run(cutoff);
  db.prepare("DELETE FROM events WHERE day < ?").run(cutoff);
  db.prepare("DELETE FROM relays WHERE ts < ?").run(Date.now() - 31 * 86_400_000); // the quota window is 30 days

  const insertHit = db.prepare("INSERT INTO hits VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertEvent = db.prepare("INSERT INTO events VALUES (?, ?, ?)");
  const countRelays = db.prepare("SELECT COUNT(*) AS n FROM relays WHERE key = ? AND ts > ?");
  const insertRelay = db.prepare("INSERT INTO relays VALUES (?, ?)");

  return {
    /** Free relay quota (api/_relay-core.ts), kept across restarts and deploys. Synchronous, like the check it backs. */
    relays: {
      count: (key: string, since: number) => Number((countRelays.get(key, since) as { n: number }).n),
      add: (key: string, now: number) => void insertRelay.run(now, key),
    } satisfies RelayLedger,

    /** Records a page view. ip and ua only feed the daily visitor hash and are not stored. */
    hit(h: Hit, ip: string, ua: string, now = Date.now()) {
      if (BOT.test(ua)) return;
      const d = day(now);
      const salt = createHmac("sha256", secret).update(d).digest();
      const visitor = createHash("sha256").update(salt).update(ip).update(ua).digest("hex").slice(0, 16);
      insertHit.run(now, d, h.path, h.referrer, TZ[h.tz] ?? "", deviceOf(h.width, ua), visitor, h.source);
    },

    /** Server-side activity worth watching (relays, refused relays, relay failures). */
    event(kind: string, now = Date.now()) {
      insertEvent.run(now, day(now), kind);
    },

    stats(days: number, now = Date.now()) {
      const from = day(now - (days - 1) * 86_400_000);
      const all = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as T[];
      const top = (col: string, limit = 20) =>
        all<{ key: string; views: number; visitors: number }>(
          `SELECT ${col} AS key, COUNT(*) AS views, COUNT(DISTINCT day || visitor) AS visitors FROM hits
           WHERE day >= ? GROUP BY ${col} ORDER BY visitors DESC, views DESC LIMIT ${limit}`,
          from,
        );
      const totals = all<{ views: number; visitors: number }>(
        "SELECT COUNT(*) AS views, COUNT(DISTINCT day || visitor) AS visitors FROM hits WHERE day >= ?",
        from,
      )[0]!;
      return {
        from,
        days,
        views: totals.views,
        visitors: totals.visitors, // daily unique visitors, summed: the id changes every day by design
        live: all<{ n: number }>("SELECT COUNT(DISTINCT visitor) AS n FROM hits WHERE ts >= ?", now - 5 * 60_000)[0]!.n,
        series: all<{ day: string; views: number; visitors: number }>(
          "SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM hits WHERE day >= ? GROUP BY day ORDER BY day",
          from,
        ),
        pages: top("path"),
        referrers: top("ref"),
        sources: top("source"),
        countries: top("country", 250),
        devices: top("device", 5),
        events: all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM events WHERE day >= ? GROUP BY kind", from),
      };
    },
  };
}

// ---------------------------------------------------------------- admin session

/** host: when set, the admin API only answers on that host name (its own origin, see deploy notes). */
export type AdminEnv = { admins: Address[]; secret: string; host?: string };

export function adminEnvFromProcess(): AdminEnv | null {
  const secret = process.env.ADMIN_SECRET ?? "";
  const admins = (process.env.ADMIN_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => isAddress(a))
    .map((a) => getAddress(a));
  const host = (process.env.ADMIN_HOST ?? "").trim().toLowerCase() || undefined;
  return secret.length >= 32 && admins.length ? { admins, secret, host } : null;
}

const NONCE_TTL = 5 * 60_000;
const SESSION_TTL = 8 * 3600_000;
const nonces = new Map<string, number>();

/** A one-time message for the wallet to sign. */
export function loginMessage(host: string, now = Date.now()) {
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
  const nonce = randomBytes(16).toString("hex");
  nonces.set(nonce, now + NONCE_TTL);
  return `Sign in to the Credoc admin on ${host}\n\nNonce: ${nonce}\nIssued at: ${new Date(now).toISOString()}`;
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** Checks the signed message (single-use nonce, admin wallet) and returns a session token, or null. */
export async function login(env: AdminEnv, message: unknown, signature: unknown, now = Date.now()): Promise<string | null> {
  if (typeof message !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return null;
  const nonce = /\nNonce: ([0-9a-f]{32})\n/.exec(message)?.[1];
  const exp = nonce ? nonces.get(nonce) : undefined;
  if (!nonce || !exp || exp < now) return null;
  nonces.delete(nonce); // single use, even when the signature turns out wrong
  let who: Address;
  try {
    who = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch {
    return null;
  }
  if (!env.admins.includes(who)) return null;
  const payload = `${who}.${now + SESSION_TTL}`;
  return `${payload}.${sign(env.secret, payload)}`;
}

/** The admin address behind a session cookie, or null. */
export function session(env: AdminEnv, cookieHeader: string | undefined, now = Date.now()): Address | null {
  const token = /(?:^|;\s*)credoc_admin=([^;]+)/.exec(cookieHeader ?? "")?.[1];
  const [addr, exp, mac] = (token ?? "").split(".");
  if (!addr || !exp || !mac) return null;
  const want = Buffer.from(sign(env.secret, `${addr}.${exp}`));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(exp) < now || !isAddress(addr) || !env.admins.includes(getAddress(addr))) return null;
  return getAddress(addr);
}

export const sessionCookie = (token: string) =>
  `credoc_admin=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`;
export const clearCookie = "credoc_admin=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
