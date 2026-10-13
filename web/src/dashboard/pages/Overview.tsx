import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ARC, type Reputation } from "@credoc/sdk";
import { Amount, Card, Chart, Empty, PageTitle, Skeleton, When, tokenSymbol } from "../components/ui";
import { CreditStyles, EventLine, describe } from "../components/credit-kit";
import { dateShort, sameAddress, shortHex } from "../../shared/format";
import { pendingActions } from "../lib/model";
import { reader } from "../lib/clients";
import { useStore } from "../lib/store";
import { useWallet } from "../lib/wallet";

const DAY = 86400;

/** Sum per token symbol, rendered as stacked Amounts (USDC first). */
function Sums({ sums }: { sums: Map<string, bigint> }) {
  const entries = [...sums.entries()].filter(([, v]) => v > 0n);
  if (!entries.length) return <Amount value={0n} token={ARC.usdc} serif className="kpi-figure" />;
  return (
    <div className="d-flex flex-column">
      {entries.map(([token, v]) => (
        <Amount key={token} value={v} token={token} serif className="kpi-figure" />
      ))}
    </div>
  );
}

function add(m: Map<string, bigint>, token: string, v: bigint) {
  m.set(token, (m.get(token) ?? 0n) + v);
}

export function Kpi({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="col-sm-6 col-xl-3">
      <div className="card h-100">
        <div className="card-body">
          <div className="micro-label mb-2">{label}</div>
          {children}
          <div className="fs-12 text-muted mt-2">{hint}</div>
        </div>
      </div>
    </div>
  );
}

export function Overview() {
  const { status, credits, byId, offers, events, now } = useStore();
  const { address } = useWallet();
  const t = now();
  const me = address;

  const kpis = useMemo(() => {
    const locked = new Map<string, bigint>();
    const receivable = new Map<string, bigint>();
    const paid = new Map<string, bigint>();
    for (const c of credits) {
      if (c.status === 1 && sameAddress(c.applicant, me)) add(locked, c.token, c.outstanding);
      if (c.status === 1 && sameAddress(c.payee, me)) add(receivable, c.token, c.outstanding);
      for (const e of c.events)
        if (e.name === "TrancheSettled" && sameAddress(e.args.payee as string, me)) add(paid, c.token, (e.args.amount as bigint) - ((e.args.fee as bigint | undefined) ?? 0n));
    }
    return { locked, receivable, paid };
  }, [credits, me]);

  // track record: the reputation registry if one of my credits links my identity, else the event history
  const agent = credits.find((c) => sameAddress(c.beneficiary, me) && c.beneficiaryAgent !== null);
  const [rep, setRep] = useState<Reputation | null>(null);
  useEffect(() => {
    setRep(null);
    if (!agent || !reader) return;
    let live = true;
    reader
      .reputation(agent.beneficiaryAgent!, tokenSymbol(agent.token) === "EURC" ? "EURC" : "USDC")
      .then((r) => live && setRep(r))
      .catch(() => live && setRep(null));
    return () => {
      live = false;
    };
  }, [agent?.beneficiaryAgent, agent?.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const derived = useMemo(() => {
    let delivered = 0;
    let expired = 0;
    for (const c of credits)
      if (sameAddress(c.beneficiary, me))
        for (const e of c.events) {
          if (e.name === "TrancheSettled") delivered++;
          if (e.name === "TrancheRefunded") expired++;
        }
    return { delivered, expired };
  }, [credits, me]);
  const track = rep ? { delivered: rep.delivered, expired: rep.expired + rep.cancelled } : derived;

  const todo = pendingActions(credits, offers, me, t);

  // daily settled volume, last 45 days of chain time
  const chart = useMemo(() => {
    const start = Math.floor(t / DAY) * DAY - 44 * DAY;
    const days = Array.from({ length: 45 }, (_, i) => start + i * DAY);
    const perToken = new Map<string, number[]>();
    for (const e of events) {
      if (e.name !== "TrancheSettled" || e.time < start) continue;
      const c = byId.get(String(e.args.creditId));
      const sym = c ? tokenSymbol(c.token) : "USDC";
      const row = perToken.get(sym) ?? days.map(() => 0);
      row[Math.floor((e.time - start) / DAY)]! += Number(e.args.amount as bigint) / 1e6;
      perToken.set(sym, row);
    }
    return { days, series: [...perToken.entries()].sort().map(([name, data]) => ({ name, data })) };
  }, [events, byId, t]);

  const active = credits.filter((c) => c.status === 1).sort((a, b) => Number(a.expiry - b.expiry));
  const recent = events
    .map((e) => ({ e, d: describe(e, byId, offers, me) }))
    .filter((x) => x.d)
    .slice(0, 8);

  const subtitle = address
    ? `Signed in as ${shortHex(address)}. Figures below are for this wallet.`
    : "Connect a wallet to see what is waiting for you.";

  if (status === "loading")
    return (
      <>
        <PageTitle title="Overview" subtitle="Reading the chain…" />
        <Card>
          <Skeleton lines={6} />
        </Card>
      </>
    );

  return (
    <>
      <CreditStyles />
      <PageTitle
        title="Overview"
        subtitle={subtitle}
        actions={
          <Link to="/credits/new" className="btn btn-dark">
            <i className="ti ti-plus me-1" /> Open a credit
          </Link>
        }
      />

      <div className="row g-3 mb-3">
        <Kpi label="Locked as importer" hint="Held by the contract until documents arrive">
          <Sums sums={kpis.locked} />
        </Kpi>
        <Kpi label="Receivable" hint="Released the moment each shipment is documented">
          <Sums sums={kpis.receivable} />
        </Kpi>
        <Kpi label="Paid to you" hint="Settled onchain, final">
          <Sums sums={kpis.paid} />
        </Kpi>
        <Kpi
          label="Track record"
          hint={rep ? `ERC-8004 identity #${agent!.beneficiaryAgent}` : "From this contract's settlements"}
        >
          <div className="font-serif kpi-figure num">
            {track.delivered} <span className="fs-14 text-muted font-sans">delivered</span>
          </div>
          <div className="fs-13 text-muted num">{track.expired} expired or cancelled</div>
        </Kpi>
      </div>

      <div className="row g-3">
        <div className="col-xl-5">
          <Card title="To do" action={todo.length ? <span className="badge-soft tone-dark num">{todo.length}</span> : undefined} className="h-100">
            {!me ? (
              <Empty icon="ti-wallet" title="No wallet selected">
                Connect a wallet in the top bar. Tasks are worked out from your role on each credit.
              </Empty>
            ) : todo.length === 0 ? (
              <Empty icon="ti-checks" title="Nothing waiting for you">
                Credits move on their own: each shipment is paid the moment its documents are attested.
              </Empty>
            ) : (
              <ul className="list-group list-group-flush">
                {todo.map((a, i) => {
                  const c = byId.get(a.creditId.toString());
                  return (
                    <li key={i} className="list-group-item px-0">
                      <Link to={`/credits/${a.creditId}`} className="d-flex align-items-center gap-2 text-reset">
                        <i className={`ti ${a.urgency >= 3 ? "ti-alert-circle" : "ti-point"} fs-16`} />
                        <span className="flex-grow-1 text-dark">{a.label}</span>
                        <span className="fs-12 text-muted">{c?.ref || `#${a.creditId}`}</span>
                        <i className="ti ti-chevron-right text-muted" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <div className="col-xl-7">
          <Card title="Settled volume" action={<span className="fs-12 text-muted">Last 45 days</span>} className="h-100">
            {chart.series.length === 0 ? (
              <Empty icon="ti-chart-area" title="No payments yet">
                Each bar is money released to an exporter after its documents were attested.
              </Empty>
            ) : (
              <Chart
                height={240}
                options={{
                  chart: { type: "bar", stacked: true },
                  series: chart.series,
                  xaxis: {
                    categories: chart.days.map((d) => dateShort(d).replace(/ \d{4}$/, "")),
                    tickAmount: 6,
                    labels: { rotate: 0, style: { fontSize: "11px" } },
                  },
                  // small volumes keep their cents, so ticks never read 0, 0, 1 for a one-dollar day
                  yaxis: { min: 0, forceNiceScale: true, labels: { formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v >= 10 ? `${Math.round(v)}` : v.toFixed(2).replace(/\.?0+$/, "")) } },
                  plotOptions: { bar: { columnWidth: "60%", borderRadius: 2 } },
                  tooltip: { y: { formatter: (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } },
                }}
              />
            )}
          </Card>
        </div>

        <div className="col-12">
          <Card title="Maturity schedule" action={<span className="fs-12 text-muted">Active credits by expiry</span>}>
            {active.length === 0 ? (
              <Empty icon="ti-calendar" title="No active credits">
                Open a credit to lock funds against shipping documents; it appears here until it settles or expires.
              </Empty>
            ) : (
              <Gantt credits={active} now={t} />
            )}
          </Card>
        </div>

        <div className="col-12">
          <Card
            title="Recent activity"
            action={
              <Link to="/activity" className="btn btn-sm btn-light">
                All activity
              </Link>
            }
          >
            {recent.length === 0 ? (
              <Empty icon="ti-activity" title="Nothing on chain yet">
                Every lock, document and payment will be listed here with its transaction.
              </Empty>
            ) : (
              <ul className="list-group list-group-flush">
                {recent.map(({ e, d }) => (
                  <EventLine key={`${e.tx}-${e.logIndex}`} e={e} d={d!} now={t} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Gantt({ credits, now }: { credits: ReturnType<typeof useStore>["credits"]; now: number }) {
  const from = Math.min(now, ...credits.map((c) => c.openedAt));
  const to = Math.max(now + DAY, ...credits.map((c) => Number(c.expiry)));
  const pct = (ts: number) => ((ts - from) / (to - from)) * 100;
  return (
    <div>
      <div className="d-flex justify-content-between fs-12 text-muted mb-1 ps-0">
        <span>{dateShort(from)}</span>
        <span>{dateShort(to)}</span>
      </div>
      {credits.map((c) => {
        const late = Number(c.expiry) < now;
        return (
          <Link key={c.id.toString()} to={`/credits/${c.id}`} className="credit-gantt-row text-reset">
            <div className="text-truncate fs-13">
              <span className="text-dark fw-medium">{c.ref || `#${c.id}`}</span>
              <div className="fs-12 text-muted">
                {late ? "Expired " : "Expires "}
                <When ts={c.expiry} now={now} />
              </div>
            </div>
            <div className="credit-gantt-track" title={`${dateShort(c.openedAt)} to ${dateShort(c.expiry)}`}>
              <span
                className={`credit-gantt-bar ${late ? "late" : ""}`}
                style={{ left: `${pct(c.openedAt)}%`, width: `${pct(Number(c.expiry)) - pct(c.openedAt)}%` }}
              />
              <span className="credit-gantt-today" style={{ left: `${pct(now)}%` }} title="Today" />
            </div>
          </Link>
        );
      })}
      <div className="fs-12 text-muted mt-2">
        <span className="d-inline-block me-1" style={{ width: 10, height: 1, background: "#b7791f", verticalAlign: "middle" }} /> Today
        (chain time)
      </div>
    </div>
  );
}
