/**
 * Production server: the built site (dist/), POST /api/relay, the read-only /api/rpc proxy, first-party analytics
 * (/api/hit) and the admin API (/api/admin/*), with no framework.
 * Runs behind the server's shared Caddy (TLS, compression, security headers), never exposed directly.
 *
 *   STATIC_DIR=dist PORT=8080 RELAYER_KEY=0x... node server.mjs
 */
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { envFromProcess, relayPresentation, type RelayEnv } from "../api/_relay-core";
import { type AdminEnv, adminEnvFromProcess, clearCookie, login, loginMessage, openStore, parseHit, session, sessionCookie } from "./analytics";
// bundled at build time: the image needs no extra file, and a new partner ships with a new image
import partnersJson from "../partners.json" with { type: "json" };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const MAX_BODY = 16_384;

const send = (res: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", ...extra });
  res.end(body);
};

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((ok) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) return void chunks.push(c);
      // too big: answer now and drain the rest unread (destroying the socket would drop the 413 itself)
      req.off("data", onData);
      req.resume();
      ok(null);
    };
    req.on("data", onData);
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => ok(null));
  });
}

/** White label: the brand a partner's domain shows, and the partner address and fee its credits are opened with. */
export type Brand = { name: string; partner: string | null; integratorFeeBps: number; supportUrl?: string };
export const DEFAULT_BRAND: Brand = { name: "Credoc", partner: null, integratorFeeBps: 0 };

/** Keeps only well-formed entries; a bad one falls back to the default brand rather than open credits wrongly. */
export function parsePartners(raw: unknown): Map<string, Brand> {
  const out = new Map<string, Brand>();
  if (!raw || typeof raw !== "object") return out;
  for (const [host, v] of Object.entries(raw as Record<string, unknown>)) {
    const b = v as Partial<Brand> | null;
    const ok =
      /^[a-z0-9.-]{1,253}$/.test(host) &&
      !!b &&
      typeof b.name === "string" &&
      b.name.length > 0 &&
      b.name.length <= 64 &&
      (b.partner === null || (typeof b.partner === "string" && /^0x[0-9a-fA-F]{40}$/.test(b.partner))) &&
      Number.isInteger(b.integratorFeeBps) &&
      b.integratorFeeBps! >= 0 &&
      b.integratorFeeBps! <= 50 &&
      (b.integratorFeeBps === 0 || b.partner !== null) && // the contract refuses a fee without a partner
      (b.supportUrl === undefined || (typeof b.supportUrl === "string" && /^(https:|mailto:)/.test(b.supportUrl)));
    if (!ok) {
      console.warn(`partners.json: ignoring invalid entry for ${JSON.stringify(host)}`);
      continue;
    }
    const brand: Brand = { name: b.name!, partner: b.partner!, integratorFeeBps: b.integratorFeeBps! };
    if (b.supportUrl) brand.supportUrl = b.supportUrl;
    out.set(host, brand);
  }
  return out;
}

const PARTNERS = parsePartners(partnersJson);

/** Host header, lowercased and without its port; anything unexpected gets the default brand. */
export function brandFor(host: string | undefined, partners: Map<string, Brand> = PARTNERS): Brand {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return (/^[a-z0-9.-]+$/.test(h) && partners.get(h)) || DEFAULT_BRAND;
}

/** Resolve a URL path to a file inside root, or null: decoding and normalisation cannot escape root. */
export async function resolveStatic(root: string, urlPath: string): Promise<string | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]!);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  let file = resolve(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return null;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Read-only JSON-RPC methods the dashboard needs. The proxy serves them from the site's own origin, because browser
 * shields and extensions block cross-site calls to the public Arc RPC; writes always go through the user's wallet.
 */
export const RPC_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);
const RPC_BATCH = 50;
const ARC_RPC = "https://rpc.mainnet.arc.io";

/** A single call or a batch, every call on the allowlist; anything else is refused before reaching Arc. */
export function rpcAllowed(body: unknown): boolean {
  const calls = Array.isArray(body) ? body : [body];
  return (
    calls.length > 0 &&
    calls.length <= RPC_BATCH &&
    calls.every((c) => !!c && typeof c === "object" && RPC_METHODS.has((c as { method?: unknown }).method as string))
  );
}

type Store = ReturnType<typeof openStore>;

/** JSON body of a POST, or the response already sent (413 or 400). */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ body: unknown } | null> {
  const raw = await readBody(req);
  if (raw === null) {
    send(res, 413, JSON.stringify({ error: "request too large" }), "application/json", { connection: "close" });
    return null;
  }
  try {
    return { body: JSON.parse(raw) };
  } catch {
    send(res, 400, JSON.stringify({ error: "invalid JSON" }), "application/json");
    return null;
  }
}

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(body), "application/json", { "cache-control": "no-store", ...extra });
const hostOf = (req: IncomingMessage) => (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
// only Caddy reaches this server, and it sets X-Forwarded-For
const ipOf = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim();

export function handler(
  rootDir: string,
  env: () => RelayEnv = envFromProcess,
  store: Store | null = null,
  admin: AdminEnv | null = null,
): RequestListener {
  const root = resolve(rootDir);
  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;

    if (path === "/api/hit") {
      if (req.method !== "POST") return send(res, 405, "method not allowed", undefined, { allow: "POST" });
      const r = await readJson(req, res);
      if (!r) return;
      const hit = parseHit(r.body, hostOf(req));
      if (hit && store && req.headers.dnt !== "1") store.hit(hit, ipOf(req), String(req.headers["user-agent"] ?? ""));
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }

    if (path.startsWith("/api/admin/")) {
      if (!admin || !store) return json(res, 503, { error: "admin is not configured" });
      if (path === "/api/admin/nonce" && req.method === "GET") return json(res, 200, { message: loginMessage(hostOf(req)) });
      if (path === "/api/admin/login" && req.method === "POST") {
        const r = await readJson(req, res);
        if (!r) return;
        const b = (r.body ?? {}) as Record<string, unknown>;
        const token = await login(admin, b.message, b.signature);
        if (!token) return json(res, 401, { error: "not an admin wallet, or the message expired" });
        return json(res, 200, { address: token.split(".")[0] }, { "set-cookie": sessionCookie(token) });
      }
      if (path === "/api/admin/logout" && req.method === "POST") return json(res, 200, {}, { "set-cookie": clearCookie });
      const who = session(admin, req.headers.cookie);
      if (!who) return json(res, 401, { error: "sign in first" });
      if (path === "/api/admin/me" && req.method === "GET") return json(res, 200, { address: who });
      if (path === "/api/admin/stats" && req.method === "GET") {
        const days = Math.max(1, Math.min(365, Number(new URL(req.url ?? "/", "http://x").searchParams.get("days")) || 30));
        // the relayer's address (never its key), so the admin page can watch its gas balance
        const key = env().relayerKey;
        const relayer = key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key as `0x${string}`).address : null;
        return json(res, 200, { ...store.stats(days), relayer });
      }
      return json(res, 404, { error: "not found" });
    }
    if (path === "/healthz") return send(res, 200, "ok");
    if (path === "/brand.json") {
      // varies by Host: a shared cache must not hand one partner's brand to another domain
      return send(res, 200, JSON.stringify(brandFor(req.headers.host)), "application/json", { "cache-control": "public, max-age=300", vary: "Host" });
    }

    if (path === "/api/relay") {
      if (req.method !== "POST") return send(res, 405, "method not allowed", undefined, { allow: "POST" });
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, JSON.stringify({ error: "request too large" }), "application/json", { connection: "close" });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, JSON.stringify({ error: "invalid JSON" }), "application/json");
      }
      const r = await relayPresentation(body, env());
      store?.event(r.status === 200 ? "relay" : r.status === 402 ? "relay_quota" : "relay_refused");
      return send(res, r.status, JSON.stringify(r.body), "application/json", { "cache-control": "no-store" });
    }

    if (path === "/api/rpc") {
      if (req.method !== "POST") return send(res, 405, "method not allowed", undefined, { allow: "POST" });
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, JSON.stringify({ error: "request too large" }), "application/json", { connection: "close" });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, JSON.stringify({ error: "invalid JSON" }), "application/json");
      }
      if (!rpcAllowed(body)) return send(res, 403, JSON.stringify({ error: "method not allowed" }), "application/json");
      try {
        // ponytail: no per-client rate limit; Arc's RPC limits the server's IP, add one here if that bites
        const up = await fetch(env().rpcUrl || ARC_RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
          signal: AbortSignal.timeout(15_000),
        });
        return send(res, up.status, await up.text(), "application/json", { "cache-control": "no-store" });
      } catch {
        return send(res, 502, JSON.stringify({ error: "Arc RPC unreachable" }), "application/json");
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", undefined, { allow: "GET, HEAD" });
    const file = await resolveStatic(root, path);
    if (!file) return send(res, 404, "not found");
    const data = await readFile(file);
    // hashed build assets never change; pages must always be revalidated to pick up a deploy
    const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": data.length,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  };
}

if (process.env.NODE_ENV === "production") {
  const port = Number(process.env.PORT ?? 8080);
  const admin = adminEnvFromProcess();
  let store: Store | null = null;
  try {
    // without ADMIN_SECRET the visitor hash still rotates, with a secret that only lives as long as the process
    store = openStore(process.env.DATA_DIR ?? "/data", admin?.secret ?? randomBytes(32).toString("hex"));
  } catch (e) {
    console.warn("analytics disabled:", (e as Error).message); // the site must keep serving without its data volume
  }
  if (!admin) console.warn("admin disabled: set ADMIN_ADDRESSES and ADMIN_SECRET (32+ characters)");
  createServer(handler(process.env.STATIC_DIR ?? "dist", envFromProcess, store, admin)).listen(port, () =>
    console.log(`credoc listening on :${port}`),
  );
}
