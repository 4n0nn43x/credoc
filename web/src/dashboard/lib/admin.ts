import { useEffect, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { amount, shortHex } from "../../shared/format";
import type { ChainEvent } from "./store";

/**
 * Admin session (see server/analytics.ts) and the pure revenue arithmetic of the admin page. No config import here, so
 * the arithmetic runs under node's test runner.
 */

// ---------------------------------------------------------------- session

export type AdminSession =
  | { status: "loading" }
  | { status: "admin"; address: string }
  | { status: "guest" }
  /** no admin API: Vite dev, or a server without ADMIN_ADDRESSES / ADMIN_SECRET */
  | { status: "unavailable"; reason: string }
  /** the server only serves the admin on its own host name, and this is not it */
  | { status: "elsewhere" };

let current: AdminSession = { status: "loading" };
let checked = false;
const subs = new Set<() => void>();
const set = (s: AdminSession) => {
  current = s;
  subs.forEach((f) => f());
};

/** JSON answer of the admin API, or null when there is none (dev server, network down). */
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const r = await fetch(`/api/admin/${path}`, { credentials: "same-origin", ...init });
    if (!(r.headers.get("content-type") ?? "").includes("application/json")) return null;
    return { status: r.status, body: await r.json() };
  } catch {
    return null;
  }
}

const NO_API = "The admin API only runs on the Credoc server, not on the Vite dev server.";
const unavailable = (r: { status: number } | null): AdminSession =>
  r?.status === 404
    ? { status: "elsewhere" }
    : {
        status: "unavailable",
        reason: r?.status === 503 ? "Admin is not configured on this server: set ADMIN_ADDRESSES and ADMIN_SECRET." : NO_API,
      };

export async function checkAdmin() {
  const r = await call("me");
  if (r?.status === 200) set({ status: "admin", address: String(r.body.address) });
  else if (r?.status === 401) set({ status: "guest" });
  else set(unavailable(r));
}

/** Cached for the whole app: the sidebar and the admin page share one check. */
export function useAdmin(): AdminSession {
  useEffect(() => {
    if (checked) return;
    checked = true;
    void checkAdmin();
  }, []);
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => current,
  );
}

/** Signs the one-time message with the wallet. Resolves to an error to show, or null once signed in. */
export async function signIn(sign: (message: string) => Promise<Hex>): Promise<string | null> {
  const n = await call("nonce");
  if (n?.status !== 200) {
    set(unavailable(n));
    return null;
  }
  const signature = await sign(String(n.body.message));
  const r = await call("login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: n.body.message, signature }),
  });
  if (r?.status === 200) {
    set({ status: "admin", address: String(r.body.address) });
    return null;
  }
  if (r?.status === 401) return "This wallet is not an admin, or the message expired. Switch to an admin wallet and sign again.";
  set(unavailable(r));
  return null;
}

export async function signOut() {
  await call("logout", { method: "POST" });
  set({ status: "guest" });
}

type Row = { key: string; views: number; visitors: number };
export type AdminStats = {
  from: string;
  days: number;
  views: number;
  visitors: number;
  live: number;
  series: { day: string; views: number; visitors: number }[];
  pages: Row[];
  referrers: Row[];
  sources: Row[];
  countries: Row[];
  devices: Row[];
  events: { kind: string; n: number }[];
  relayer: string | null;
};

/** Stats for the last `days` days, or null when the session ended (the page then asks to sign in again). */
export async function loadStats(days: number): Promise<AdminStats | null> {
  const r = await call(`stats?days=${days}`);
  if (r?.status === 200) return r.body as unknown as AdminStats;
  if (r?.status === 401) set({ status: "guest" });
  else set(unavailable(r));
  return null;
}

// ---------------------------------------------------------------- revenue (pure)

export const PLAN_NAMES = ["attestor", "importer", "financier"] as const;
export type PlanKey = (typeof PLAN_NAMES)[number];
const DAY = 86400;
const key = (a: unknown) => String(a).toLowerCase();
const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

export type PassLine = { e: ChainEvent; plan: PlanKey; text: string };

/**
 * Credoc's income from the indexed events. Credoc keeps `TrancheSettled.fee` minus the partner's
 * `PartnerFeeAccrued.amount` (DocumentaryCredit._settle); plans are paid in USDC (`PassBought.paid`).
 * Maps are keyed by lowercase token address. `from` is the first day (unix seconds, UTC midnight) of a daily series of
 * `days` days, in USDC units of 1e-6.
 */
export function revenue(
  dc: ChainEvent[],
  pass: ChainEvent[],
  tokenOf: (creditId: bigint) => string | undefined,
  usdc: string,
  now: number,
  from: number,
  days: number,
) {
  const fees = new Map<string, bigint>();
  const partners = new Map<string, bigint>();
  const withdrawn = new Map<string, bigint>();
  const dailyFees = Array<number>(days).fill(0);
  const dailyPlans = Array<number>(days).fill(0);
  const slot = (t: number) => {
    const i = Math.floor((t - from) / DAY);
    return i >= 0 && i < days ? i : -1;
  };
  const chrono = (a: ChainEvent, b: ChainEvent) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1);

  for (const e of dc) {
    const token = typeof e.args.creditId === "bigint" ? tokenOf(e.args.creditId) : undefined;
    let v = 0n;
    if (e.name === "TrancheSettled" && token) v = (e.args.fee as bigint | undefined) ?? 0n;
    if (e.name === "PartnerFeeAccrued" && token) {
      v = -(e.args.amount as bigint);
      add(partners, key(token), e.args.amount as bigint);
    }
    if (e.name === "FeesWithdrawn") add(withdrawn, key(e.args.token), e.args.amount as bigint);
    if (!v || !token) continue;
    add(fees, key(token), v);
    const i = slot(e.time);
    if (i >= 0 && key(token) === key(usdc)) dailyFees[i]! += Number(v);
  }

  const plans = Object.fromEntries(PLAN_NAMES.map((p) => [p, { paid: 0n, count: 0, active: 0 }])) as Record<PlanKey, { paid: bigint; count: number; active: number }>;
  const until = new Map<string, { plan: PlanKey; until: number }>();
  const lines: PassLine[] = [];
  for (const e of [...pass].sort(chrono)) {
    const plan = PLAN_NAMES[Number(e.args.plan) - 1];
    if (!plan) continue;
    const k = `${key(e.args.account)}:${plan}`;
    const end = Number(e.args.until);
    const start = Math.max(until.get(k)?.until ?? 0, e.time);
    until.set(k, { plan, until: end });
    const title = plan.charAt(0).toUpperCase() + plan.slice(1);
    if (e.name === "PassBought") {
      const paid = e.args.paid as bigint;
      plans[plan].paid += paid;
      plans[plan].count++;
      const i = slot(e.time);
      if (i >= 0) dailyPlans[i]! += Number(paid);
      const forWhom = key(e.args.payer) === key(e.args.account) ? "" : ` for ${shortHex(String(e.args.account))}`;
      const n = Math.max(1, Math.round((end - start) / DAY));
      lines.push({ e, plan, text: `${shortHex(String(e.args.payer))} bought the ${title} plan${forWhom} for ${n} days, ${amount(paid)} USDC` });
    } else {
      const date = new Date(end * 1000).toUTCString().slice(5, 16);
      lines.push({ e, plan, text: `${shortHex(String(e.args.account))} was granted the ${title} plan until ${date}` });
    }
  }
  for (const { plan, until: end } of until.values()) if (end > now) plans[plan].active++;

  const total = new Map(fees);
  for (const p of PLAN_NAMES) add(total, key(usdc), plans[p].paid);
  return { fees, partners, withdrawn, plans, total, lines, dailyFees, dailyPlans };
}

/** One row per day from `from` (YYYY-MM-DD, UTC), zero where the server has nothing. */
export function fillDays(series: AdminStats["series"], from: string, days: number) {
  const byDay = new Map(series.map((s) => [s.day, s]));
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start + i * DAY * 1000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, views: 0, visitors: 0 };
  });
}

/** "FR" -> the French flag, from regional indicator letters. Empty for anything that is not two letters. */
export const flag = (cc: string) =>
  /^[A-Za-z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
