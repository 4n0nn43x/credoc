/**
 * Production server: the built site (dist/) plus POST /api/relay, with no framework.
 * Runs behind the server's shared Caddy (TLS, compression, security headers), never exposed directly.
 *
 *   STATIC_DIR=dist PORT=8080 RELAYER_KEY=0x... node server.mjs
 */
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { envFromProcess, relayPresentation, type RelayEnv } from "../api/_relay-core";
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

export function handler(rootDir: string, env: () => RelayEnv = envFromProcess): RequestListener {
  const root = resolve(rootDir);
  return async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
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
      return send(res, r.status, JSON.stringify(r.body), "application/json", { "cache-control": "no-store" });
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
  createServer(handler(process.env.STATIC_DIR ?? "dist")).listen(port, () => console.log(`credoc listening on :${port}`));
}
