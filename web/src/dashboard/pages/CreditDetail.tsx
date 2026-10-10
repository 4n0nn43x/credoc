import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import type { Reputation } from "@credoc/sdk";
import { Addr, Amount, Card, Empty, PageTitle, Skeleton, StatusBadge, TxLink, When, tokenSymbol } from "../components/ui";
import { CreditStyles, Stepper, describe, prettyDoc, who } from "../components/credit-kit";
import { ActionCard } from "../components/credit-actions";
import { CREDOC_ADDRESS } from "../../shared/config";
import { sameAddress, shortHex } from "../../shared/format";
import { paidAmount, refundedAmount, status, steps } from "../lib/model";
import { reader } from "../lib/clients";
import { type ChainEvent, type CreditRow, useStore } from "../lib/store";
import { useWallet } from "../lib/wallet";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useCopied() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text: string) =>
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }),
  };
}

export function CreditDetail() {
  const { id } = useParams();
  const isPublic = useLocation().pathname.startsWith("/track");
  const { status: load, byId, offers, events, now } = useStore();
  const { address: me } = useWallet();
  const c = id ? byId.get(id) : undefined;
  const t = now();
  const { copied, copy } = useCopied();
  const link = `${location.origin}/app/#/track/${id}`;

  // the credit's own events plus withdrawals of its offers (they carry only an offer id)
  const timeline = useMemo<ChainEvent[]>(() => {
    if (!c) return [];
    const mine = new Set(offers.filter((o) => o.creditId === c.id).map((o) => o.id));
    const extra = events.filter((e) => e.name === "OfferWithdrawn" && mine.has(e.args.offerId as bigint));
    return [...c.events, ...extra]
      .filter((e) => e.name !== "ReputationSkipped")
      .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  }, [c, offers, events]);

  // Replay: reveal the timeline one event at a time, the stepper follows the revealed time
  const [shown, setShown] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);
  const replay = () => {
    clearInterval(timer.current);
    if (reduced()) return setShown(null);
    setShown(0);
    let n = 0;
    timer.current = setInterval(() => {
      n++;
      if (n > timeline.length) {
        clearInterval(timer.current);
        setShown(null);
      } else setShown(n);
    }, 700);
  };

  if (load === "loading" || (load !== "ready" && !c))
    return (
      <>
        <PageTitle title={`Credit #${id}`} subtitle="Reading the chain…" />
        <Card>
          <Skeleton lines={8} />
        </Card>
      </>
    );
  if (!c)
    return (
      <Card>
        <Empty
          icon="ti-file-unknown"
          title={`No credit #${id}`}
          action={
            <Link to="/credits" className="btn btn-outline-dark btn-sm">
              See all credits
            </Link>
          }
        >
          This contract has no credit with that number yet. Check the link, or wait a few seconds if it was just opened.
        </Empty>
      </Card>
    );

  const st = steps(c, t);
  const revealedTime = shown === null ? Infinity : shown === 0 ? -Infinity : timeline[shown - 1]!.time;
  let stepReveal: number | undefined;
  if (shown !== null) {
    stepReveal = 0;
    while (stepReveal < st.length && st[stepReveal]!.done && (st[stepReveal]!.time ?? Infinity) <= revealedTime) stepReveal++;
  }
  const expired = t > Number(c.expiry);
  const assigned = !sameAddress(c.payee, c.beneficiary);

  return (
    <>
      <CreditStyles />
      {isPublic && (
        <div className="alert alert-light border d-flex gap-2 align-items-center fs-13 mb-3" role="note">
          <i className="ti ti-world fs-18" />
          <span className="flex-grow-1">Public tracking page: anyone with this link can follow this credit, no wallet needed.</span>
        </div>
      )}

      {/* header */}
      <div className="d-flex flex-column flex-lg-row gap-3 justify-content-between align-items-lg-end mb-3 pt-3">
        <div className="min-w-0">
          <div className="micro-label">Letter of credit #{c.id.toString()}</div>
          <h1 className="font-serif fs-24 mb-2 mt-1 text-dark">{c.ref || "No reference"}</h1>
          <div className="d-flex flex-wrap align-items-center gap-3">
            <Amount value={c.total} token={c.token} serif className="hero-amount text-dark" />
            <StatusBadge s={status(c, t)} />
          </div>
          <div className="fs-13 text-muted mt-2 d-flex flex-wrap gap-1 align-items-center">
            <span>{expired ? "Expired" : "Expires"}</span> <When ts={c.expiry} now={t} />
            <span className="mx-1">·</span>
            <span className="text-dark">{who(c.applicant, me)}</span>
            <i className="ti ti-arrow-right" aria-label="pays" />
            <span className="text-dark">{who(c.beneficiary, me)}</span>
            {assigned && (
              <span>
                (proceeds assigned to <span className="text-dark">{who(c.payee, me)}</span>)
              </span>
            )}
          </div>
        </div>
        <div className="d-flex gap-2 flex-shrink-0">
          {isPublic ? (
            <>
              <button type="button" className="btn btn-outline-dark btn-sm" onClick={replay} title={reduced() ? "Disabled: reduced motion is on" : undefined}>
                <i className="ti ti-player-play me-1" /> Replay
              </button>
              <button type="button" className="btn btn-dark btn-sm" onClick={() => copy(link)}>
                <i className={`ti ${copied ? "ti-check" : "ti-link"} me-1`} /> {copied ? "Copied" : "Copy link"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-light btn-sm" onClick={() => copy(link)}>
                <i className={`ti ${copied ? "ti-check" : "ti-share"} me-1`} /> {copied ? "Link copied" : "Share tracking link"}
              </button>
            </>
          )}
        </div>
      </div>

      <Card>
        <Stepper steps={st} reveal={stepReveal} now={t} />
      </Card>

      <div className="row g-3">
        <div className="col-xl-8">
          {!isPublic && <ActionCard c={c} now={t} />}
          <Matrix c={c} now={t} />
          <Card title="History" action={<span className="fs-12 text-muted num">{timeline.length} events</span>}>
            <Timeline c={c} items={timeline} shown={shown} now={t} />
          </Card>
        </div>
        <div className="col-xl-4">
          <Parties c={c} />
          <Terms c={c} />
          <TrackRecord c={c} />
        </div>
      </div>
    </>
  );
}

function Matrix({ c, now }: { c: CreditRow; now: number }) {
  const { address: me } = useWallet();
  const settled = (ti: number) => c.events.find((e) => e.name === "TrancheSettled" && e.args.tranche === ti);
  const refunded = (ti: number) => c.events.find((e) => e.name === "TrancheRefunded" && e.args.tranche === ti);
  const presented = (ti: number, doc: number) =>
    c.events.find((e) => e.name === "DocumentPresented" && e.args.tranche === ti && e.args.doc === doc);
  return (
    <Card title="Shipments and documents" bodyClass="p-0">
      <div className="table-responsive">
        <table className="table table-centered table-nowrap mb-0 fs-13">
          <thead>
            <tr className="fs-12 text-muted">
              <th className="ps-3">Shipment</th>
              {c.docs.map((d, i) => (
                <th key={i}>{prettyDoc(d.label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.tranches.map((tr, ti) => {
              const paid = settled(ti);
              const back = refunded(ti);
              return (
                <tr key={ti}>
                  <td className="ps-3">
                    <div className="fw-medium text-dark">Shipment {ti + 1}</div>
                    <Amount value={tr.amount} token={c.token} />
                    <div className="mt-1">
                      {paid ? (
                        <span className="badge-soft tone-success">
                          <i className="ti ti-circle-check" /> Paid <When ts={paid.time} now={now} />
                        </span>
                      ) : back ? (
                        <span className="badge-soft tone-secondary">
                          <i className="ti ti-arrow-back-up" /> Refunded
                        </span>
                      ) : (
                        <span className="badge-soft tone-dark">
                          <i className="ti ti-hourglass" /> Waiting
                        </span>
                      )}
                    </div>
                  </td>
                  {tr.documents.map((d) => {
                    if (!d.required)
                      return (
                        <td key={d.doc}>
                          <span className="credit-cell na">Not required</span>
                        </td>
                      );
                    if (d.waived)
                      return (
                        <td key={d.doc}>
                          <span className="credit-cell waived">
                            <i className="ti ti-file-like" /> Accepted by importer
                          </span>
                        </td>
                      );
                    if (d.satisfied) {
                      const ev = presented(ti, d.doc);
                      return (
                        <td key={d.doc}>
                          <span className="credit-cell presented" title={d.hash ?? undefined}>
                            <i className="ti ti-file-check" /> Presented
                          </span>
                          <div className="fs-12 text-muted mt-1">
                            <span className="hash">{d.hash ? shortHex(d.hash) : ""}</span> by {who(c.docs[d.doc]!.attestor, me)}
                            {ev && (
                              <>
                                {" "}
                                <When ts={ev.time} now={now} />
                              </>
                            )}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={d.doc}>
                        <span className="credit-cell waiting">
                          <i className="ti ti-file-dots" /> {tr.settled ? "Not presented" : "Waiting"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Timeline({ c, items, shown, now }: { c: CreditRow; items: ChainEvent[]; shown: number | null; now: number }) {
  const { byId, offers } = useStore();
  const { address: me } = useWallet();
  return (
    <ol className="credit-timeline">
      {items.map((e, i) => {
        const d = describe(e, byId, offers, me);
        if (!d) return null;
        const sameTxDoc =
          e.name === "TrancheSettled" &&
          c.events.some((x) => x.tx === e.tx && (x.name === "DocumentPresented" || x.name === "DocumentWaived"));
        return (
          <li key={`${e.tx}-${e.logIndex}`} className={shown !== null && i >= shown ? "hidden-step" : ""}>
            <span className="credit-ev-icon">
              <i className={`ti ${d.icon}`} aria-hidden="true" />
            </span>
            <div className="text-dark">{d.text}</div>
            {sameTxDoc && (
              <div className="fs-12 text-muted">Paid in the same transaction as the last document: final in that block, no settlement delay.</div>
            )}
            <div className="fs-12 text-muted d-flex flex-wrap gap-2 align-items-center mt-1">
              <When ts={e.time} now={now} />
              {d.actor && <Addr address={d.actor} me={me} />}
              <TxLink hash={e.tx} />
              <span className="num">block {e.block.toString()}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="d-flex justify-content-between gap-2 py-1 fs-13">
      <span className="text-muted">{k}</span>
      <span className="text-end">{children}</span>
    </div>
  );
}

function Parties({ c }: { c: CreditRow }) {
  const { address: me } = useWallet();
  return (
    <Card title="Parties">
      <Row k="Importer">
        <Addr address={c.applicant} me={me} />
      </Row>
      <Row k="Exporter">
        <Addr address={c.beneficiary} me={me} />
      </Row>
      <Row k="Paid to">
        <Addr address={c.payee} me={me} />
      </Row>
      <div className="micro-label mt-3 mb-1">Attestors</div>
      {c.docs.map((d, i) => (
        <Row key={i} k={prettyDoc(d.label)}>
          <Addr address={d.attestor} me={me} />
        </Row>
      ))}
    </Card>
  );
}

function Terms({ c }: { c: CreditRow }) {
  return (
    <Card title="Terms">
      <Row k="Terms hash">
        <span className="hash" title={c.terms}>
          {shortHex(c.terms)}
        </span>
      </Row>
      <Row k="Currency">{tokenSymbol(c.token)}</Row>
      <Row k="Total">
        <Amount value={c.total} token={c.token} />
      </Row>
      <Row k="Outstanding">
        <Amount value={c.outstanding} token={c.token} />
      </Row>
      <Row k="Paid">
        <Amount value={paidAmount(c)} token={c.token} />
      </Row>
      <Row k="Refunded">
        <Amount value={refundedAmount(c)} token={c.token} />
      </Row>
      {CREDOC_ADDRESS && (
        <Row k="Contract">
          <Addr address={CREDOC_ADDRESS} />
        </Row>
      )}
      <Row k="Opened">
        <TxLink hash={c.openTx} />
      </Row>
    </Card>
  );
}

function TrackRecord({ c }: { c: CreditRow }) {
  const [rep, setRep] = useState<Reputation | null | "error">(null);
  const agent = c.beneficiaryAgent;
  const sym = tokenSymbol(c.token) === "EURC" ? "EURC" : "USDC";
  useEffect(() => {
    setRep(null);
    if (agent === null || !reader) return;
    let live = true;
    reader
      .reputation(agent, sym)
      .then((r) => live && setRep(r))
      .catch(() => live && setRep("error"));
    return () => {
      live = false;
    };
  }, [agent, sym, c.events.length]);
  return (
    <Card title="Exporter track record">
      {agent === null ? (
        <p className="fs-13 text-muted mb-0">
          The exporter has not linked an ERC-8004 identity to this credit, so its settlements do not build a public track record yet.
        </p>
      ) : rep === null ? (
        <Skeleton lines={3} />
      ) : rep === "error" ? (
        <p className="fs-13 text-muted mb-0">The reputation registry could not be read right now.</p>
      ) : (
        <>
          <div className="d-flex align-items-baseline gap-2 mb-2">
            <span className="font-serif fs-24 num text-dark">{rep.onTimeRate === null ? "None" : `${Math.round(rep.onTimeRate * 100)}%`}</span>
            <span className="fs-12 text-muted">on time, identity #{agent.toString()}</span>
          </div>
          <Row k="Delivered">
            <span className="num">{rep.delivered}</span>
          </Row>
          <Row k="Waived">
            <span className="num">{rep.waived}</span>
          </Row>
          <Row k="Expired">
            <span className="num">{rep.expired}</span>
          </Row>
          <Row k="Cancelled">
            <span className="num">{rep.cancelled}</span>
          </Row>
          <div className="fs-12 text-muted mt-2">Only entries written by this contract during settlements are counted.</div>
        </>
      )}
    </Card>
  );
}
