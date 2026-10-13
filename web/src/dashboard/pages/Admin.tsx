import { useEffect, useMemo, useState, type ReactNode } from "react";
import { type Address, type Hex, parseAbi, parseEventLogs } from "viem";
import { ARC, documentaryCreditAbi, passAbi } from "@credoc/sdk";
import { Addr, Amount, Card, Chart, Empty, PageTitle, Skeleton } from "../components/ui";
import { CreditStyles, EventLine, type Described, describe } from "../components/credit-kit";
import { SignButton } from "../components/form-kit";
import { Kpi } from "./Overview";
import { CREDOC_ADDRESS, FROM_BLOCK } from "../../shared/config";
import { amount, dateShort, shortHex } from "../../shared/format";
import { useTheme } from "../../shared/theme";
import { type AdminStats, PLAN_NAMES, fillDays, flag, loadStats, revenue, signIn, signOut, useAdmin } from "../lib/admin";
import { publicClient, reader } from "../lib/clients";
import { type ChainEvent, useStore } from "../lib/store";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";

const DAY = 86400;
const PERIODS = [7, 30, 90, 365];
const CHUNK = 9_999n;
const LOW_GAS = 50_000_000_000_000_000n; // 0.05 USDC, Arc's native gas token has 18 decimals
const TOKENS = [ARC.usdc, ARC.eurc] as const;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const passEventsAbi = [...passAbi, ...parseAbi(["event PassGranted(address indexed account, uint8 indexed plan, uint64 until)"])];
const lc = (a: string) => a.toLowerCase();
const int = (v: number) => v.toLocaleString("en-US");
const dayLabel = (ts: number) => dateShort(ts).replace(/ \d{4}$/, "");

type Onchain = {
  treasury: Address;
  balances: Map<string, bigint>; // treasury, per lowercase token
  waiting: Map<string, bigint>; // fees(token) still in the contract
  pass: ChainEvent[];
};

/** Treasury, fees waiting in the contract and every CredocPass event. Credit events come from the shared store. */
async function loadOnchain(): Promise<Onchain> {
  const dc = { address: CREDOC_ADDRESS!, abi: documentaryCreditAbi } as const;
  const [treasury, passAddr, head] = await Promise.all([
    publicClient.readContract({ ...dc, functionName: "treasury" }) as Promise<Address>,
    reader!.passAddress(),
    publicClient.getBlockNumber(),
  ]);
  const [bal, fees] = await Promise.all([
    Promise.all(TOKENS.map((t) => publicClient.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [treasury] }))),
    Promise.all(TOKENS.map((t) => publicClient.readContract({ ...dc, functionName: "fees", args: [t] }) as Promise<bigint>)),
  ]);
  const pass: ChainEvent[] = [];
  if (passAddr) {
    const times = new Map<bigint, number>();
    for (let from = FROM_BLOCK; from <= head; from += CHUNK + 1n) {
      const to = from + CHUNK > head ? head : from + CHUNK;
      const logs = await publicClient.getLogs({ address: passAddr, fromBlock: from, toBlock: to });
      for (const l of parseEventLogs({ abi: passEventsAbi, logs })) {
        if (l.eventName !== "PassBought" && l.eventName !== "PassGranted") continue;
        if (!times.has(l.blockNumber)) times.set(l.blockNumber, Number((await publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp));
        pass.push({ name: l.eventName, args: l.args as Record<string, unknown>, block: l.blockNumber, tx: l.transactionHash, logIndex: l.logIndex, time: times.get(l.blockNumber)! });
      }
    }
  }
  return {
    treasury,
    balances: new Map(TOKENS.map((t, i) => [lc(t), bal[i]!])),
    waiting: new Map(TOKENS.map((t, i) => [lc(t), fees[i]!])),
    pass,
  };
}

/** Fees are fractions of a cent at first: show four decimals under one unit when two would read 0.00. */
const places = (v: bigint) => (v > 0n && v < 1_000_000n && v % 10_000n !== 0n ? 4 : 2);
/** Same for chart figures, in units. */
const fig = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 1 ? 4 : 2 });

/** Amounts per token on one line each, USDC first; EURC only when there is some. `kpi` stacks them as KPI figures. */
function PerToken({ m, kpi }: { m: Map<string, bigint>; kpi?: boolean }) {
  const usdc = m.get(lc(ARC.usdc)) ?? 0n;
  const eurc = m.get(lc(ARC.eurc)) ?? 0n;
  const cls = kpi ? "kpi-figure" : "";
  return (
    <span className={`d-inline-flex flex-column ${kpi ? "" : "align-items-end"}`}>
      <Amount value={usdc} token={ARC.usdc} serif={kpi} className={cls} places={places(usdc)} />
      {eurc > 0n && <Amount value={eurc} token={ARC.eurc} serif={kpi} className={cls} places={places(eurc)} />}
    </span>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="d-flex align-items-baseline justify-content-between gap-2 mt-4 mb-3 flex-wrap">
        <h5 className="font-serif fs-22 text-dark mb-0">{title}</h5>
        {note && <span className="micro-label">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Line({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <li className="list-group-item px-0 d-flex justify-content-between align-items-start gap-3">
      <div>
        <div className="text-dark">{label}</div>
        {hint && <div className="fs-12 text-muted">{hint}</div>}
      </div>
      <div className="text-end">{children}</div>
    </li>
  );
}

/** Ranked rows with a hairline share bar; `value` drives the bar, `sub` is the muted figure beside it. */
function ShareRows({ rows, empty }: { rows: { key: string; label: ReactNode; value: number; sub: string }[]; empty: ReactNode }) {
  if (!rows.length) return <>{empty}</>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="list-unstyled mb-0 d-grid gap-2">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="d-flex justify-content-between gap-2 fs-13">
            <span className="text-dark text-truncate">{r.label}</span>
            <span className="num text-muted text-nowrap">{r.sub}</span>
          </div>
          <div className="admin-bar mt-1">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const regions = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
const countryName = (cc: string) => {
  if (!cc) return "Unknown";
  try {
    return regions?.of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
};
const DEVICE_ICON: Record<string, string> = { desktop: "ti-device-desktop", mobile: "ti-device-mobile", tablet: "ti-device-tablet" };

function AdminStyles() {
  return (
    <style>{`
.admin-bar { height: 4px; border-radius: 2px; background: var(--credoc-paper); overflow: hidden; }
.admin-bar > span { display: block; height: 100%; border-radius: 2px; background: var(--credoc-ink); opacity: .75; }
.admin-live .dot { position: relative; }
.admin-live .dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: admin-pulse 1.8s ease-out infinite; }
@keyframes admin-pulse { from { transform: scale(1); opacity: .7; } to { transform: scale(2.8); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .admin-live .dot::after { animation: none; } }
.admin-signin { max-width: 520px; margin: 8vh auto 0; }
`}</style>
  );
}

export function Admin() {
  const session = useAdmin();
  const { wallet } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sign = async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      setError(await signIn((message) => wallet.signMessage({ account: wallet.account, message })));
    } catch (e) {
      setError((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  if (session.status === "loading")
    return (
      <>
        <PageTitle title="Admin" />
        <Card>
          <Skeleton lines={6} />
        </Card>
      </>
    );

  if (session.status === "guest")
    return (
      <div className="admin-signin">
        <AdminStyles />
        <Card>
          <div className="text-center py-3">
            <i className="ti ti-shield-lock fs-32 text-muted" aria-hidden="true" />
            <h4 className="font-serif fs-24 text-dark mt-3 mb-2">Admin sign-in</h4>
            <p className="text-muted mx-auto mb-4" style={{ maxWidth: 380 }}>
              Sign a message with an admin wallet: no transaction, no gas. The session lasts 8 hours on this browser.
            </p>
            {error && (
              <div className="alert alert-danger text-start fs-13" role="alert">
                <i className="ti ti-alert-circle me-1" aria-hidden="true" />
                {error}
              </div>
            )}
            <SignButton onClick={() => void sign()} busy={busy}>
              <i className="ti ti-signature me-1" aria-hidden="true" /> Sign in with this wallet
            </SignButton>
          </div>
        </Card>
      </div>
    );

  return <Dashboard session={session} />;
}

function Dashboard({ session }: { session: Exclude<ReturnType<typeof useAdmin>, { status: "loading" | "guest" }> }) {
  const store = useStore();
  const { credits, byId, offers, events, now } = store;
  const { address } = useWallet();
  const { run } = useTx();
  const theme = useTheme();
  const ink = theme === "dark" ? ["#ecebe8", "#78716c"] : ["#191919", "#a8a29e"];
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [chain, setChain] = useState<Onchain | "error" | null>(null);
  const [version, setVersion] = useState(0);
  const [relayerBal, setRelayerBal] = useState<bigint | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const admin = session.status === "admin";

  useEffect(() => {
    if (!admin) return;
    let live = true;
    const load = () => void loadStats(days).then((s) => live && s && setStats(s));
    load();
    const timer = setInterval(load, 60_000); // keeps the live count honest
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [admin, days]);

  useEffect(() => {
    if (!CREDOC_ADDRESS || !reader) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout>;
    loadOnchain()
      .then((d) => live && setChain(d))
      .catch(() => {
        if (!live) return;
        setChain((c) => (c && c !== "error" ? c : "error")); // keep the last good figures
        retry = setTimeout(() => setVersion((v) => v + 1), 5000); // the RPC drops requests now and then
      });
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [version]);

  const relayer = stats?.relayer ?? null;
  useEffect(() => {
    if (!relayer) return;
    let live = true;
    publicClient
      .getBalance({ address: relayer as Address })
      .then((b) => live && setRelayerBal(b))
      .catch(() => live && setRelayerBal(null));
    return () => {
      live = false;
    };
  }, [relayer]);

  const t = now();
  const from = Math.floor(t / DAY) * DAY - (days - 1) * DAY;
  const tokenOf = useMemo(() => (id: bigint) => byId.get(id.toString())?.token, [byId]);
  const rev = useMemo(
    () => revenue(events, chain && chain !== "error" ? chain.pass : [], tokenOf, ARC.usdc, t, from, days),
    // chain time moves every second; recompute on new data or a new period only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, chain, tokenOf, days, from],
  );

  const biz = useMemo(() => {
    const volume = new Map<string, bigint>();
    const opened = new Map<string, { sum: bigint; n: bigint }>();
    const count = (name: string) => events.filter((e) => e.name === name).length;
    let refunded = 0n;
    for (const e of events) {
      const token = typeof e.args.creditId === "bigint" ? byId.get(e.args.creditId.toString())?.token : undefined;
      if (!token) continue;
      if (e.name === "TrancheSettled") volume.set(lc(token), (volume.get(lc(token)) ?? 0n) + (e.args.amount as bigint));
      if (e.name === "TrancheRefunded" && lc(token) === lc(ARC.usdc)) refunded += e.args.amount as bigint;
      if (e.name === "CreditOpened") {
        const o = opened.get(lc(token)) ?? { sum: 0n, n: 0n };
        opened.set(lc(token), { sum: o.sum + (e.args.total as bigint), n: o.n + 1n });
      }
    }
    return {
      volume,
      ticket: new Map([...opened].map(([k, o]) => [k, o.sum / o.n])),
      refunded,
      opened: count("CreditOpened"),
      active: credits.filter((c) => c.status === 1).length,
      settlements: count("TrancheSettled"),
      refunds: count("TrancheRefunded"),
      offers: count("OfferMade"),
      accepted: count("ProceedsAssigned"),
    };
  }, [events, byId, credits]);

  const feed = useMemo(() => {
    const dc = events.flatMap((e) => {
      const d = describe(e, byId, offers, address);
      return d ? [{ e, d }] : [];
    });
    const plans = rev.lines.map(({ e, text }) => ({ e, d: { text, icon: "ti-crown", category: "payments" } as Described }));
    return [...dc, ...plans].sort((a, b) => b.e.time - a.e.time || b.e.logIndex - a.e.logIndex).slice(0, 15);
  }, [events, byId, offers, address, rev.lines]);

  const withdraw = async (token: string) => {
    setSending(token);
    const ok = await run(`Send ${token === lc(ARC.usdc) ? "USDC" : "EURC"} fees to the treasury`, async (c) => {
      const w = c.wallet as unknown as NonNullable<ReturnType<typeof useWallet>["wallet"]>;
      const { request } = await publicClient.simulateContract({
        address: c.address,
        abi: documentaryCreditAbi,
        functionName: "withdrawFees",
        args: [token as Address],
        account: w.account,
      });
      const hash: Hex = await w.writeContract(request as never);
      c.hooks.onSubmitted?.(hash);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      c.hooks.onConfirmed?.(hash);
      if (r.status !== "success") throw new Error(`withdrawFees reverted: ${hash}`);
    });
    setSending(null);
    if (ok) setVersion((v) => v + 1);
  };

  const onchain = chain && chain !== "error" ? chain : null;
  const loadingChain = store.status === "loading" || (CREDOC_ADDRESS && chain === null);
  const planRevenue = PLAN_NAMES.reduce((s, p) => s + rev.plans[p].paid, 0n);
  const planCount = PLAN_NAMES.reduce((s, p) => s + rev.plans[p].count, 0);
  const activePlans = PLAN_NAMES.reduce((s, p) => s + rev.plans[p].active, 0);
  const periodFees = rev.dailyFees.reduce((a, b) => a + b, 0) / 1e6;
  const periodPlans = rev.dailyPlans.reduce((a, b) => a + b, 0) / 1e6;
  // a label every few days only (full date in the tooltip), so the axis stays readable down to phone width
  const axis = (labels: string[]) => {
    const step = Math.ceil(labels.length / 4);
    return {
      xaxis: { categories: labels.map((l, i) => (i % step === 0 ? l : "")), labels: { rotate: 0, style: { fontSize: "11px" } }, tooltip: { enabled: false } },
      tooltip: { x: { formatter: (_: unknown, o?: { dataPointIndex?: number }) => labels[o?.dataPointIndex ?? 0] ?? "" } },
    };
  };
  const revAxis = axis(Array.from({ length: days }, (_, i) => dayLabel(from + i * DAY)));
  const relays = (kind: string) => stats?.events.find((e) => e.kind === kind)?.n ?? 0;
  const traffic = stats ? fillDays(stats.series, stats.from, stats.days) : [];
  const trafficAxis = axis(traffic.map((d) => dayLabel(Date.parse(`${d.day}T00:00:00Z`) / 1000)));

  return (
    <>
      <CreditStyles />
      <AdminStyles />
      <PageTitle
        title="Admin"
        subtitle={admin ? `Revenue, activity and traffic. Signed in as admin ${shortHex(session.address)}.` : "Revenue and activity, read from Arc."}
        actions={
          admin ? (
            <div className="d-flex align-items-center gap-2 flex-wrap">
              {stats && (
                <span className="network-pill admin-live num" title="Visitors in the last 5 minutes">
                  <span className="dot" /> {int(stats.live)} live
                </span>
              )}
              <ul className="nav nav-pills gap-1 flex-nowrap text-nowrap" aria-label="Period">
                {PERIODS.map((d) => (
                  <li key={d} className="nav-item">
                    <button type="button" className={`nav-link py-1 px-2 px-sm-3 ${days === d ? "active bg-dark text-white" : "text-dark"}`} onClick={() => setDays(d)} aria-pressed={days === d}>
                      {d === 365 ? "1 year" : `${d} days`}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => void signOut()}>
                <i className="ti ti-logout me-1" aria-hidden="true" /> Sign out
              </button>
            </div>
          ) : undefined
        }
      />

      {session.status === "unavailable" && (
        <div className="alert alert-light border d-flex gap-2 align-items-start mb-4">
          <i className="ti ti-server-off fs-18 mt-1" aria-hidden="true" />
          <div>
            <div className="fw-semibold text-dark">Admin API only runs on the server</div>
            <div className="fs-13 text-muted">{session.reason} Traffic and relayer figures need it; the onchain sections below do not.</div>
          </div>
        </div>
      )}

      <Section title="Revenue" note="Onchain, since launch">
        {!CREDOC_ADDRESS ? (
          <Card>
            <Empty icon="ti-plug-off" title="No contract configured">Set VITE_CREDOC_ADDRESS to read revenue from Arc.</Empty>
          </Card>
        ) : loadingChain ? (
          <Card>
            <Skeleton lines={6} />
          </Card>
        ) : chain === "error" ? (
          <Card>
            <Empty icon="ti-alert-circle" title="Cannot read the chain">
              The network did not answer.{" "}
              <button type="button" className="btn btn-link p-0 align-baseline" onClick={() => setVersion((v) => v + 1)}>
                Try again
              </button>
            </Empty>
          </Card>
        ) : (
          <>
            <div className="row g-3 mb-3">
              <Kpi label="Total revenue" hint="Settlement fees kept plus plans sold">
                <PerToken kpi m={rev.total} />
              </Kpi>
              <Kpi label="Settlement fees" hint="Net of partner shares">
                <PerToken kpi m={rev.fees} />
              </Kpi>
              <Kpi label="Plans" hint={`${planCount} ${planCount === 1 ? "purchase" : "purchases"}`}>
                <PerToken kpi m={new Map([[lc(ARC.usdc), planRevenue]])} />
              </Kpi>
              <Kpi label="Active plans" hint="Accounts with a plan running now">
                <div className="font-serif kpi-figure num">{int(activePlans)}</div>
              </Kpi>
            </div>
            <div className="row g-3 mb-3">
              <div className="col-xl-8">
                <Card title="Revenue by day" action={<span className="fs-12 text-muted num">{fig(periodFees + periodPlans)} USDC in {days} days</span>} className="h-100 mb-0">
                  {periodFees + periodPlans === 0 ? (
                    <Empty icon="ti-chart-bar" title="No revenue in this period">
                      Each bar is what Credoc earned that day: settlement fees it kept and plans it sold, in USDC.
                    </Empty>
                  ) : (
                    <Chart
                      height={260}
                      options={{
                        chart: { type: "bar", stacked: true },
                        colors: ink,
                        series: [
                          { name: "Settlement fees", data: rev.dailyFees.map((v) => v / 1e6) },
                          { name: "Plans", data: rev.dailyPlans.map((v) => v / 1e6) },
                        ],
                        xaxis: revAxis.xaxis,
                        yaxis: { labels: { formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v < 10 ? fig(v) : `${Math.round(v)}`) } },
                        plotOptions: { bar: { columnWidth: "60%", borderRadius: 2 } },
                        legend: { show: true, position: "top", horizontalAlign: "right" },
                        tooltip: { ...revAxis.tooltip, y: { formatter: (v: number) => `${fig(v)} USDC` } },
                      }}
                    />
                  )}
                </Card>
              </div>
              <div className="col-xl-4">
                <Card title="Settlement fees" className="h-100 mb-0" bodyClass="py-0">
                  <ul className="list-group list-group-flush">
                    <Line label="Collected" hint="Kept by Credoc after partner shares">
                      <PerToken m={rev.fees} />
                    </Line>
                    <Line
                      label="Waiting in the contract"
                      hint={
                        <>
                          Anyone can send them, only to the treasury
                          {[...onchain!.waiting].filter(([, v]) => v > 0n).map(([token]) => (
                            <div key={token} className="mt-2">
                              <SignButton className="btn btn-sm btn-dark" onClick={() => void withdraw(token)} busy={sending === token} disabled={!!sending}>
                                <i className="ti ti-send me-1" aria-hidden="true" /> Send {token === lc(ARC.usdc) ? "USDC" : "EURC"} to treasury
                              </SignButton>
                            </div>
                          ))}
                        </>
                      }
                    >
                      <PerToken m={onchain!.waiting} />
                    </Line>
                    <Line label="Sent to the treasury">
                      <PerToken m={rev.withdrawn} />
                    </Line>
                    <Line label="Paid to partners" hint="White-label shares, accrued to them">
                      <PerToken m={rev.partners} />
                    </Line>
                  </ul>
                </Card>
              </div>
            </div>
            <div className="row g-3">
              <div className="col-lg-7">
                <Card title="Plans" action={<span className="fs-12 text-muted">Paid in USDC</span>} className="h-100 mb-0">
                  {planCount === 0 && activePlans === 0 ? (
                    <Empty icon="ti-crown" title="No plan sold yet">Prepaid plans bought on the Plans page show up here, by plan.</Empty>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-sm align-middle mb-0">
                        <thead>
                          <tr className="micro-label">
                            <th className="fw-medium">Plan</th>
                            <th className="fw-medium text-end">Purchases</th>
                            <th className="fw-medium text-end">Active now</th>
                            <th className="fw-medium text-end">Revenue</th>
                          </tr>
                        </thead>
                        <tbody>
                          {PLAN_NAMES.map((p) => (
                            <tr key={p}>
                              <td className="text-dark text-capitalize">{p}</td>
                              <td className="text-end num">{int(rev.plans[p].count)}</td>
                              <td className="text-end num">{int(rev.plans[p].active)}</td>
                              <td className="text-end">
                                <Amount value={rev.plans[p].paid} token={ARC.usdc} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>
              <div className="col-lg-5">
                <Card title="Treasury" className="h-100 mb-0">
                  <div className="mb-3">
                    <Addr address={onchain!.treasury} />
                  </div>
                  <div className="d-flex gap-4 flex-wrap">
                    {TOKENS.map((tk) => (
                      <div key={tk}>
                        <div className="micro-label mb-1">{tk === ARC.usdc ? "USDC" : "EURC"}</div>
                        <Amount value={onchain!.balances.get(lc(tk)) ?? 0n} token={tk} serif className="fs-24 text-dark" />
                      </div>
                    ))}
                  </div>
                  <div className="fs-12 text-muted mt-3">Fees reach it when someone sends them from the contract. Plan payments go straight to the plans contract's treasury.</div>
                </Card>
              </div>
            </div>
          </>
        )}
      </Section>

      <Section title="Business activity" note="Onchain, since launch">
        {store.status === "loading" ? (
          <Card>
            <Skeleton lines={6} />
          </Card>
        ) : (
          <>
            <div className="row g-3 mb-3">
              <Kpi label="Credits opened" hint={`${biz.active} active now`}>
                <div className="font-serif kpi-figure num">{int(biz.opened)}</div>
              </Kpi>
              <Kpi label="Settled volume" hint={`${biz.settlements} ${biz.settlements === 1 ? "settlement" : "settlements"}`}>
                <PerToken kpi m={biz.volume} />
              </Kpi>
              <Kpi label="Average ticket" hint="Credit size at opening">
                <PerToken kpi m={biz.ticket} />
              </Kpi>
              <Kpi label="Financing" hint={`${biz.refunds} ${biz.refunds === 1 ? "refund" : "refunds"}, ${amount(biz.refunded)} USDC`}>
                <div className="font-serif kpi-figure num">
                  {int(biz.accepted)} <span className="fs-14 text-muted font-sans">of {int(biz.offers)} offers accepted</span>
                </div>
              </Kpi>
            </div>
            <Card title="Recent activity" action={<span className="fs-12 text-muted">Both contracts, latest 15</span>} bodyClass="py-0">
              {feed.length === 0 ? (
                <Empty icon="ti-activity" title="Nothing on chain yet">Credits, payments and plan purchases will be listed here with their transactions.</Empty>
              ) : (
                <ul className="list-group list-group-flush">
                  {feed.map(({ e, d }) => (
                    <EventLine key={`${e.tx}-${e.logIndex}-${e.name}`} e={e} d={d} now={t} />
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </Section>

      <Section title="Relayer" note={admin ? `Last ${days} days` : undefined}>
        <Card>
          {!stats ? (
            <Empty icon="ti-gas-station" title="Relayer figures come from the server">Its address and relay counts are served by the admin API.</Empty>
          ) : !relayer ? (
            <Empty icon="ti-gas-station" title="No relayer configured">Set RELAYER_PRIVATE_KEY on the server to offer gasless presentations.</Empty>
          ) : (
            <div className="row g-4 align-items-center">
              <div className="col-lg-5">
                <div className="micro-label mb-2">Gas balance</div>
                <div className="d-flex align-items-center gap-2 flex-wrap">
                  {relayerBal === null ? (
                    <span className="text-muted">…</span>
                  ) : (
                    <span className="amount num font-serif kpi-figure text-dark">
                      {amount(relayerBal, 18)}
                      <span className="ccy">USDC</span>
                    </span>
                  )}
                  {relayerBal !== null &&
                    (relayerBal < LOW_GAS ? (
                      <span className="badge-soft tone-warning">
                        <i className="ti ti-alert-triangle" aria-hidden="true" /> Low, top up
                      </span>
                    ) : (
                      <span className="badge-soft tone-success">
                        <i className="ti ti-circle-check" aria-hidden="true" /> Funded
                      </span>
                    ))}
                </div>
                <div className="mt-2 fs-13">
                  <Addr address={relayer} />
                </div>
              </div>
              <div className="col-lg-7">
                <div className="row g-3">
              {[
                ["Relayed", "relay", "Presentations sent for free"],
                ["Over quota", "relay_quota", "Free allowance used, no plan"],
                ["Refused or failed", "relay_refused", "Invalid, or the chain said no"],
              ].map(([label, kind, hint]) => (
                <div key={kind} className="col-sm-4">
                  <div className="micro-label mb-2">{label}</div>
                  <div className="font-serif kpi-figure num text-dark">{int(relays(kind!))}</div>
                  <div className="fs-12 text-muted mt-1">{hint}</div>
                </div>
              ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section title="Traffic" note={stats ? `${dayLabel(Date.parse(`${stats.from}T00:00:00Z`) / 1000)} to today` : undefined}>
        {!admin ? (
          <Card>
            <Empty icon="ti-chart-area-line" title="Traffic comes from the server">Page views are counted first-party by the Credoc server; run it to see them here.</Empty>
          </Card>
        ) : !stats ? (
          <Card>
            <Skeleton lines={6} />
          </Card>
        ) : (
          <>
            <div className="row g-3 mb-3">
              <Kpi label="Visitors" hint="Unique per day, summed">
                <div className="font-serif kpi-figure num">{int(stats.visitors)}</div>
              </Kpi>
              <Kpi label="Page views" hint={`Over ${stats.days} days`}>
                <div className="font-serif kpi-figure num">{int(stats.views)}</div>
              </Kpi>
              <Kpi label="Views per visitor" hint="Pages seen in a visit day">
                <div className="font-serif kpi-figure num">{stats.visitors ? (stats.views / stats.visitors).toFixed(1) : "0"}</div>
              </Kpi>
              <Kpi label="Live" hint="Visitors in the last 5 minutes">
                <div className="font-serif kpi-figure num">{int(stats.live)}</div>
              </Kpi>
            </div>
            <div className="row g-3 mb-3">
              <div className="col-xl-8">
                <Card title="Visitors and page views" className="h-100 mb-0">
                  {stats.views === 0 ? (
                    <Empty icon="ti-chart-area-line" title="No visits in this period">Each point is one day of first-party page views.</Empty>
                  ) : (
                    <Chart
                      height={260}
                      options={{
                        chart: { type: "area" },
                        colors: ink,
                        series: [
                          { name: "Visitors", data: traffic.map((d) => d.visitors) },
                          { name: "Page views", data: traffic.map((d) => d.views) },
                        ],
                        stroke: { curve: "smooth", width: 2 },
                        fill: { type: "solid", opacity: [0.08, 0] },
                        xaxis: trafficAxis.xaxis,
                        yaxis: { min: 0, forceNiceScale: true, labels: { formatter: (v: number) => int(Math.round(v)) } },
                        legend: { show: true, position: "top", horizontalAlign: "right" },
                        tooltip: { ...trafficAxis.tooltip, y: { formatter: (v: number) => int(v) } },
                      }}
                    />
                  )}
                </Card>
              </div>
              <div className="col-xl-4">
                <Card title="Devices" className="h-100 mb-0">
                  <ShareRows
                    rows={stats.devices.map((d) => ({
                      key: d.key,
                      label: (
                        <>
                          <i className={`ti ${DEVICE_ICON[d.key] ?? "ti-device-desktop"} me-2 text-muted`} aria-hidden="true" />
                          <span className="text-capitalize">{d.key || "Unknown"}</span>
                        </>
                      ),
                      value: d.visitors,
                      sub: `${Math.round((d.visitors / Math.max(1, stats.devices.reduce((s, x) => s + x.visitors, 0))) * 100)}%`,
                    }))}
                    empty={<Empty icon="ti-devices" title="No devices yet" />}
                  />
                </Card>
              </div>
            </div>
            <div className="row g-3">
              <div className="col-xl-4 col-lg-6">
                <Card title="Top pages" action={<span className="fs-12 text-muted">Visitors</span>} className="h-100 mb-0">
                  <ShareRows
                    rows={stats.pages.slice(0, 10).map((p) => ({ key: p.key, label: <span className="hash">{p.key}</span>, value: p.visitors, sub: `${int(p.visitors)} · ${int(p.views)} views` }))}
                    empty={<Empty icon="ti-file" title="No pages yet" />}
                  />
                </Card>
              </div>
              <div className="col-xl-4 col-lg-6">
                <Card title="Sources" action={<span className="fs-12 text-muted">Visitors</span>} className="h-100 mb-0">
                  <ShareRows
                    rows={stats.referrers.slice(0, 8).map((r) => ({
                      key: r.key,
                      label: r.key ? r.key : <span className="text-muted">Direct</span>,
                      value: r.visitors,
                      sub: int(r.visitors),
                    }))}
                    empty={<Empty icon="ti-link" title="No referrers yet" />}
                  />
                  {stats.sources.some((s) => s.key) && (
                    <>
                      <div className="micro-label mt-4 mb-2">Campaigns (utm_source)</div>
                      <ShareRows
                        rows={stats.sources.filter((s) => s.key).slice(0, 6).map((s) => ({ key: s.key, label: s.key, value: s.visitors, sub: int(s.visitors) }))}
                        empty={null}
                      />
                    </>
                  )}
                </Card>
              </div>
              <div className="col-xl-4 col-lg-12">
                <Card title="Countries" action={<span className="fs-12 text-muted">Visitors</span>} className="h-100 mb-0">
                  <ShareRows
                    rows={stats.countries.slice(0, 10).map((c) => ({
                      key: c.key,
                      label: (
                        <>
                          {flag(c.key) ? <span className="me-2" aria-hidden="true">{flag(c.key)}</span> : <i className="ti ti-world me-2 text-muted" aria-hidden="true" />}
                          {countryName(c.key)}
                        </>
                      ),
                      value: c.visitors,
                      sub: int(c.visitors),
                    }))}
                    empty={<Empty icon="ti-world" title="No countries yet" />}
                  />
                </Card>
              </div>
            </div>
            <p className="fs-12 text-muted mt-3 mb-0">
              <i className="ti ti-shield-check me-1" aria-hidden="true" />
              First-party, cookie-free counting: no IP stored, visitors counted per day, Do Not Track respected.
            </p>
          </>
        )}
      </Section>
    </>
  );
}
