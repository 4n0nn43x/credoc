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
