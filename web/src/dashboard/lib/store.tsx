import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type Address, type Hex, parseEventLogs } from "viem";
import { type CreditView, documentaryCreditAbi } from "@credoc/sdk";
import { CREDOC_ADDRESS, FROM_BLOCK } from "../../shared/config";
import { publicClient, reader } from "./clients";

/**
 * In-browser indexer: reads every DocumentaryCredit event from the deployment block, then follows new
 * blocks. Events give the history (who did what, when, with which transaction); contract reads give the
 * current state. Small enough for a hackathon deployment, no backend needed.
 */

export type ChainEvent = {
  name: string;
  args: Record<string, unknown>;
  block: bigint;
  tx: Hex;
  logIndex: number;
  time: number; // unix seconds, from the block
};

export type CreditRow = CreditView & {
  ref: string;
  openedAt: number;
  openTx: Hex;
  events: ChainEvent[]; // oldest first
};

export type OfferRow = {
  id: bigint;
  creditId: bigint;
  financier: Address;
  price: bigint;
  forOutstanding: bigint;
  validUntil: bigint;
  open: boolean;
  madeAt: number;
  tx: Hex;
};

type Store = {
  status: "unconfigured" | "loading" | "ready" | "error";
  error: string | null;
  credits: CreditRow[]; // newest first
  byId: Map<string, CreditRow>;
  offers: OfferRow[]; // newest first
  events: ChainEvent[]; // newest first, all credits
  /** chain time in seconds, extrapolated from the latest block (a local fork may run ahead of the wall clock) */
  now: () => number;
  refresh: () => Promise<void>;
};

const Ctx = createContext<Store | null>(null);
const CHUNK = 9_999n;
const POLL_MS = 1500;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<Store["status"]>(CREDOC_ADDRESS ? "loading" : "unconfigured");
  const [error, setError] = useState<string | null>(null);

  const scanned = useRef<bigint>(FROM_BLOCK - 1n);
  const events = useRef<ChainEvent[]>([]);
  const credits = useRef(new Map<string, CreditRow>());
  const offers = useRef(new Map<string, OfferRow>());
  const blockTimes = useRef(new Map<bigint, number>());
  const clock = useRef({ chain: Math.floor(Date.now() / 1000), wall: Date.now() });
  const busy = useRef(false);

  const now = useCallback(() => clock.current.chain + Math.floor((Date.now() - clock.current.wall) / 1000), []);

  const time = async (block: bigint) => {
    const cached = blockTimes.current.get(block);
    if (cached !== undefined) return cached;
    const b = await publicClient.getBlock({ blockNumber: block });
    const t = Number(b.timestamp);
    blockTimes.current.set(block, t);
    return t;
  };

  const tick = useCallback(async () => {
    const read = reader;
    if (!CREDOC_ADDRESS || !read || busy.current) return;
    busy.current = true;
    try {
      const head = await publicClient.getBlock();
      clock.current = { chain: Number(head.timestamp), wall: Date.now() };
      blockTimes.current.set(head.number, Number(head.timestamp));
      if (head.number <= scanned.current) return setStatus("ready");

      const fresh: ChainEvent[] = [];
      for (let from = scanned.current + 1n; from <= head.number; from += CHUNK + 1n) {
        const to = from + CHUNK > head.number ? head.number : from + CHUNK;
        const logs = await publicClient.getLogs({ address: CREDOC_ADDRESS, fromBlock: from, toBlock: to });
        for (const l of parseEventLogs({ abi: documentaryCreditAbi, logs })) {
          fresh.push({
            name: l.eventName,
            args: l.args as Record<string, unknown>,
            block: l.blockNumber,
            tx: l.transactionHash,
            logIndex: l.logIndex,
            time: await time(l.blockNumber),
          });
        }
      }
      scanned.current = head.number;
      if (fresh.length === 0) return setStatus("ready");

      const creditIds = new Set<bigint>();
      const offerIds = new Set<bigint>();
      for (const e of fresh) {
        if (typeof e.args.creditId === "bigint") creditIds.add(e.args.creditId);
        if (typeof e.args.offerId === "bigint") offerIds.add(e.args.offerId);
      }
      // offers point at credits too: an accepted offer changes the payee
      for (const id of offerIds) {
        const o = offers.current.get(id.toString());
        if (o) creditIds.add(o.creditId);
      }
      events.current = [...events.current, ...fresh];

      await Promise.all(
        [...creditIds].map(async (id) => {
          const view = await read.getCredit(id);
          const own = events.current.filter((e) => e.args.creditId === id);
          const opened = own.find((e) => e.name === "CreditOpened")!;
          credits.current.set(id.toString(), {
            ...view,
            ref: String(opened?.args.ref ?? ""),
            openedAt: opened?.time ?? 0,
            openTx: opened?.tx ?? ("0x" as Hex),
            events: own,
          });
        }),
      );
      await Promise.all(
        [...offerIds].map(async (id) => {
          const [creditId, financier, price, forOutstanding, validUntil, open] = await publicClient.readContract({
            address: CREDOC_ADDRESS!,
            abi: documentaryCreditAbi,
            functionName: "offers",
            args: [id],
          });
          const made = events.current.find((e) => e.name === "OfferMade" && e.args.offerId === id);
          offers.current.set(id.toString(), {
            id,
            creditId,
            financier,
            price,
            forOutstanding,
            validUntil,
            open,
            madeAt: made?.time ?? 0,
            tx: made?.tx ?? ("0x" as Hex),
          });
        }),
      );
      setStatus("ready");
      setError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((s) => (s === "loading" ? "error" : s));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!CREDOC_ADDRESS) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await tick();
      if (!stop) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [tick]);

  // `version` bumps whenever the indexed data changes; the lists below are rebuilt only then
  const value = useMemo<Store>(
    () => ({
      status,
      error,
      credits: [...credits.current.values()].sort((a, b) => (a.id < b.id ? 1 : -1)),
      byId: new Map(credits.current),
      offers: [...offers.current.values()].sort((a, b) => (a.id < b.id ? 1 : -1)),
      events: [...events.current].reverse(),
      now,
      refresh: tick,
    }),
    [status, error, version, now, tick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside StoreProvider");
  return v;
}

export const useCredit = (id: string | undefined) => {
  const { byId } = useStore();
  return id ? byId.get(id) : undefined;
};
