/**
 * Read-only JSON-RPC proxy to Arc for the dashboard (same origin, so browser shields cannot block it).
 *
 * Every visitor's reads leave from this one server, so Arc's public RPC rate-limits it quickly. Two things keep it
 * under the limit: Arc finalizes blocks at once, so anything about a past block (logs of a closed range, a block, a
 * mined receipt) never changes and is answered from memory for everyone; and a rate-limited call is retried with a
 * short backoff instead of failing the page.
 */

/** Read-only methods the dashboard needs; anything else is refused before reaching Arc. */
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
const CACHE_MAX = 5_000;
const HEAD_TTL_MS = 400; // a bit under Arc's block time

type Call = { jsonrpc?: string; id?: unknown; method: string; params?: unknown[] };
type Reply = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

/** A single call or a batch, every call on the allowlist. */
export function rpcAllowed(body: unknown): boolean {
  const calls = Array.isArray(body) ? body : [body];
  return (
    calls.length > 0 &&
    calls.length <= RPC_BATCH &&
    calls.every((c) => !!c && typeof c === "object" && RPC_METHODS.has((c as { method?: unknown }).method as string))
  );
}

const isNum = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRpcProxy(upstream: () => string, fetchImpl: typeof fetch = fetch) {
  // ponytail: one in-memory LRU per process, lost on restart; refills itself from Arc on demand
  const cache = new Map<string, unknown>();
  let head = 0n;
  let headAt = 0;
  let headValue: unknown = null;
  const inflight = new Map<string, Promise<Reply>>();

  const remember = (key: string, result: unknown) => {
    cache.delete(key);
    cache.set(key, result);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  };

  /** True when the answer can never change: it is about blocks at or below the last head we saw. */
  const immutable = (c: Call, result: unknown): boolean => {
    const p = (c.params ?? []) as unknown[];
    switch (c.method) {
      case "eth_chainId":
        return true;
      case "eth_getLogs": {
        const f = (p[0] ?? {}) as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown };
        return !!f.blockHash || (isNum(f.fromBlock) && isNum(f.toBlock) && BigInt(f.toBlock) <= head);
      }
      case "eth_getBlockByNumber":
        return isNum(p[0]) && BigInt(p[0]) <= head && result !== null;
      case "eth_getTransactionReceipt":
        return result !== null; // mined, and final on Arc
      case "eth_getTransactionByHash":
        return !!result && (result as { blockNumber?: unknown }).blockNumber != null;
      default:
        return false;
    }
  };

  async function upstreamCall(c: Call): Promise<Reply> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: c.method, params: c.params ?? [] });
    for (let attempt = 0; ; attempt++) {
      let reply: Reply;
      try {
        const r = await fetchImpl(upstream(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        const limited = r.status === 429;
        reply = limited ? { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } } : ((await r.json()) as Reply);
      } catch {
        reply = { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Arc RPC unreachable" } };
      }
      const retry = reply.error && /rate limit|too many|unreachable/i.test(reply.error.message);
      if (!retry || attempt === 3) return reply;
      await sleep(250 * 2 ** attempt + Math.random() * 150); // 250, 500, 1000 ms, jittered
    }
  }

  async function one(c: Call): Promise<Reply> {
    const id = c.id ?? null;
    if (c.method === "eth_blockNumber" && headValue !== null && Date.now() - headAt < HEAD_TTL_MS)
      return { jsonrpc: "2.0", id, result: headValue };
    const key = JSON.stringify([c.method, c.params ?? []]);
    if (cache.has(key)) {
      const result = cache.get(key);
      remember(key, result); // refresh its place in the LRU
      return { jsonrpc: "2.0", id, result };
    }
    // identical calls in flight share one upstream request (many visitors opening the dashboard at once)
    let pending = inflight.get(key);
    if (!pending) {
      pending = upstreamCall(c).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const reply = await pending;
    if (!reply.error) {
      if (c.method === "eth_blockNumber" && isNum(reply.result)) {
        const n = BigInt(reply.result);
        if (n > head) head = n;
        headValue = reply.result;
        headAt = Date.now();
      }
      // the dashboard learns the head from the latest block; logs up to it are final from then on
      const latest = c.method === "eth_getBlockByNumber" && (c.params ?? [])[0] === "latest";
      const n = latest ? (reply.result as { number?: unknown } | null)?.number : null;
      if (isNum(n) && BigInt(n) > head) head = BigInt(n);
      if (immutable(c, reply.result)) remember(key, reply.result);
    }
    return { ...reply, jsonrpc: "2.0", id };
  }

  /** Answers a single call or a batch (calls run a few at a time, in order). */
  return async function handle(body: unknown): Promise<Reply | Reply[]> {
    if (!Array.isArray(body)) return one(body as Call);
    const out: Reply[] = new Array(body.length);
    for (let i = 0; i < body.length; i += 4) {
      const part = await Promise.all((body.slice(i, i + 4) as Call[]).map(one));
      part.forEach((r, j) => (out[i + j] = r));
    }
    return out;
  };
}
