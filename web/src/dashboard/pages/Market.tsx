import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { parseUnits } from "viem";
import { type Reputation, netProceeds, quoteAssignment } from "@credoc/sdk";
import { sameAddress } from "../../shared/format";
import { Amount, Card, Empty, PageTitle, Skeleton, When, tokenSymbol } from "../components/ui";
import { FeeNote, SignButton, daysLeft, partyName, recordFacts } from "../components/form-kit";
import { isAcceptable, presentedCount, requiredCount } from "../lib/model";
import { readFees, reader } from "../lib/clients";
import { type CreditRow, type OfferRow, useStore } from "../lib/store";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";

const DAY = 86400;

/** Reputation of every linked exporter on screen, fetched once per agent. */
function useReputations(credits: CreditRow[]) {
  const [reps, setReps] = useState(new Map<string, Reputation>());
  const ids = [...new Set(credits.filter((c) => c.beneficiaryAgent !== null).map((c) => `${c.beneficiaryAgent}:${tokenSymbol(c.token)}`))];
  const key = ids.join(",");
  useEffect(() => {
    if (!reader) return;
    let live = true;
    for (const id of ids) {
      const [agent, sym] = id.split(":");
      reader
        .reputation(BigInt(agent!), sym === "EURC" ? "EURC" : "USDC")
        .then((r) => live && setReps((m) => new Map(m).set(id, r)))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (c: CreditRow) => (c.beneficiaryAgent === null ? undefined : reps.get(`${c.beneficiaryAgent}:${tokenSymbol(c.token)}`));
}

export function Market() {
  const { address, balances } = useWallet();
  const { credits, offers, events, now, status } = useStore();
  const { run } = useTx();
  const t = now();
  const repOf = useReputations(credits);
  const [open, setOpen] = useState<CreditRow | null>(null);

  const market = credits.filter((c) => c.status === 1 && Number(c.expiry) > t && c.outstanding > 0n);
  const best = (c: CreditRow) =>
    offers.filter((o) => isAcceptable(o, c, t)).sort((a, b) => (a.price < b.price ? 1 : -1))[0];

  const mine = address ? offers.filter((o) => sameAddress(o.financier, address)) : [];
  const accepted = (o: OfferRow) => events.some((e) => e.name === "ProceedsAssigned" && e.args.offerId === o.id);
  const portfolio = address ? credits.filter((c) => sameAddress(c.payee, address) && !sameAddress(c.beneficiary, address)) : [];
  const collected = (c: CreditRow) =>
    c.events.filter((e) => e.name === "TrancheSettled" && sameAddress(e.args.payee as string, address)).reduce((s, e) => s + (e.args.amount as bigint), 0n);
  const paidFor = (c: CreditRow) =>
    c.events.filter((e) => e.name === "ProceedsAssigned" && sameAddress(e.args.to as string, address)).reduce((s, e) => s + (e.args.price as bigint), 0n);

  return (
    <>
      <PageTitle title="Receivables market" subtitle="Buy an exporter's future payment today. You collect when the documents are in." />

      <Card title="Open credits" action={<span className="fs-12 text-muted num">{market.length} available</span>} bodyClass="p-0">
        {status === "loading" ? (
          <div className="p-3"><Skeleton /></div>
        ) : market.length === 0 ? (
          <Empty icon="ti-building-bank" title="No receivable on offer right now">
            Every active credit with money still to pay shows up here. Its exporter can sell that future payment to you at a discount, and the contract pays you instead when the documents arrive.
          </Empty>
        ) : (
          <div className="table-responsive">
            <table className="table table-hover table-centered mb-0">
              <thead>
                <tr>
                  <th>Credit</th>
                  <th>Exporter</th>
                  <th className="text-end">Outstanding</th>
                  <th>Documents</th>
                  <th>Expires</th>
                  <th>Track record</th>
                  <th>Paid to</th>
                  <th className="text-end">Best offer</th>
                </tr>
              </thead>
              <tbody>
                {market.map((c) => {
                  const b = best(c);
                  return (
                    <tr key={String(c.id)} role="button" tabIndex={0} onClick={() => setOpen(c)} onKeyDown={(e) => e.key === "Enter" && setOpen(c)}>
                      <td>
                        <span className="fw-semibold text-dark text-nowrap">{c.ref || `#${c.id}`}</span>
                        <div className="fs-12 text-muted">#{String(c.id)}</div>
                      </td>
                      <td>{partyName(c.beneficiary)}</td>
                      <td className="text-end"><Amount value={c.outstanding} token={c.token} /></td>
                      <td className="num">{presentedCount(c)}/{requiredCount(c)}</td>
                      <td className="num">{daysLeft(c.expiry, t)} days</td>
                      <td className="fs-13">{recordFacts(repOf(c), c.beneficiaryAgent !== null)}</td>
                      <td className="fs-13">{sameAddress(c.payee, c.beneficiary) ? "Exporter" : <>{sameAddress(c.payee, address) ? "You" : partyName(c.payee)} <span className="text-muted">(assigned)</span></>}</td>
                      <td className="text-end">{b ? <Amount value={b.price} token={c.token} /> : <span className="text-muted">None</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {address && (
        <div className="row">
          <div className="col-xl-6">
            <Card title="My offers" bodyClass="p-0">
              {mine.length === 0 ? (
                <p className="text-muted p-3 mb-0">Pick a credit above to make your first offer.</p>
              ) : (
                <div className="table-responsive">
                  <table className="table table-centered mb-0">
                    <thead>
                      <tr><th>Credit</th><th className="text-end">Price</th><th>Status</th><th /></tr>
                    </thead>
                    <tbody>
                      {mine.map((o) => {
                        const c = credits.find((x) => x.id === o.creditId);
                        const st = accepted(o) ? ["Accepted", "success"] : !o.open ? ["Withdrawn", "secondary"] : c && isAcceptable(o, c, t) ? ["Open", "info"] : ["Lapsed", "warning"];
                        return (
                          <tr key={String(o.id)}>
                            <td>
                              <Link to={`/credits/${o.creditId}`} className="text-dark fw-medium text-nowrap">{c?.ref || `#${o.creditId}`}</Link>
                              <div className="fs-12 text-muted">made <When ts={o.madeAt} now={t} /></div>
                            </td>
                            <td className="text-end"><Amount value={o.price} token={c?.token} /></td>
                            <td><span className={`badge-soft tone-${st[1]}`}>{st[0]}</span></td>
                            <td className="text-end">
                              {o.open && (
                                <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => void run(`Withdraw offer on ${c?.ref ?? `#${o.creditId}`}`, (x) => x.withdrawOffer(o.id))}>
                                  Withdraw
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
          <div className="col-xl-6">
            <Card title="My portfolio" bodyClass="p-0">
              {portfolio.length === 0 ? (
                <p className="text-muted p-3 mb-0">Receivables you bought appear here once an exporter accepts your offer.</p>
              ) : (
                <div className="table-responsive">
                  <table className="table table-centered mb-0">
                    <thead>
                      <tr><th>Credit</th><th className="text-end">Paid</th><th className="text-end">Collected</th><th className="text-end">To collect</th></tr>
                    </thead>
                    <tbody>
                      {portfolio.map((c) => (
                        <tr key={String(c.id)}>
                          <td><Link to={`/credits/${c.id}`} className="text-dark fw-medium text-nowrap">{c.ref || `#${c.id}`}</Link></td>
                          <td className="text-end"><Amount value={paidFor(c)} token={c.token} /></td>
                          <td className="text-end"><Amount value={collected(c)} token={c.token} /></td>
                          <td className="text-end"><Amount value={c.status === 1 ? c.outstanding : 0n} token={c.token} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {open && (
        <OfferDrawer
          c={open}
          rep={repOf(open)}
          now={t}
          balance={balances ? (tokenSymbol(open.token) === "EURC" ? balances.eurc : balances.usdc) : null}
          isPayee={sameAddress(open.payee, address)}
          close={() => setOpen(null)}
          submit={async (price, validUntil) => {
            const ok = await run(`Offer on ${open.ref || `#${open.id}`}`, (x) => x.makeOffer(open.id, price, validUntil));
            if (ok) setOpen(null);
          }}
        />
      )}
    </>
  );
}

function OfferDrawer({
  c,
  rep,
  now,
  balance,
  isPayee,
  close,
  submit,
}: {
  c: CreditRow;
  rep: Reputation | undefined;
  now: number;
  balance: bigint | null;
  isPayee: boolean;
  close: () => void;
  submit: (price: bigint, validUntil: bigint) => Promise<void>;
}) {
  const days = Math.max(1, (Number(c.expiry) - now) / DAY);
  const ccy = tokenSymbol(c.token);
  const priceAt = (rate: number) => quoteAssignment({ outstanding: c.outstanding, daysToExpiry: days, baseRate: rate, maxRiskPremium: 0 }).price;
  const suggested = quoteAssignment({ outstanding: c.outstanding, daysToExpiry: days, reputation: rep });
  const [price, setPrice] = useState(() => (Number(suggested.price) / 1e6).toFixed(2));
  const [validDays, setValidDays] = useState("3");
  const [busy, setBusy] = useState(false);
  const { address } = useWallet();
  // a financier plan lowers the fee on tranches paid to its holder (the contract checks it at each settlement)
  const [proFeeBps, setProFeeBps] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!reader || !address) return;
    let live = true;
    Promise.all([readFees(), reader.plans(address)])
      .then(([fees, plans]) => live && setProFeeBps(fees && plans?.financier.active ? fees.proFeeBps : undefined))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address]);

  let units: bigint | null = null;
  try {
    units = /^\d+(\.\d{1,6})?$/.test(price) ? parseUnits(price, 6) : null;
  } catch {
    units = null;
  }
  // what the financier collects: each unpaid tranche less the settlement fees, as the contract splits it
  const net = netProceeds(c, proFeeBps);
  const rate = units && units > 0n ? (Number(net) / Number(units) - 1) * (365 / days) : 0;
  const ret = units ? net - units : 0n;
  const vd = Number(validDays);
  const problem =
    isPayee ? "You are the current payee of this credit."
    : !units || units === 0n ? "Enter a price."
    : units > c.outstanding ? "The price cannot exceed the outstanding amount."
    : balance !== null && units > balance ? `Not enough ${ccy} in this wallet.`
    : !(vd > 0 && vd <= 30) ? "Validity is 1 to 30 days."
    : now >= Number(c.expiry) ? "This credit has expired."
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <>
      <div className="offcanvas offcanvas-end show" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="offer-title" style={{ visibility: "visible", maxWidth: "100vw" }}>
        <div className="offcanvas-header border-bottom border-dashed">
          <div>
            <h5 className="offcanvas-title" id="offer-title">Make an offer</h5>
            <div className="fs-12 text-muted">{c.ref || `#${c.id}`} · exporter {partyName(c.beneficiary)}</div>
          </div>
          <button type="button" className="btn-close" aria-label="Close" onClick={close} />
        </div>
        <div className="offcanvas-body">
          <div className="d-flex justify-content-between mb-3">
            <div>
              <div className="micro-label">Outstanding</div>
              <Amount value={c.outstanding} token={c.token} serif className="fs-22 text-dark" />
            </div>
            <div className="text-end">
              <div className="micro-label">Expires in</div>
              <span className="font-serif fs-22 text-dark num">{Math.floor(days)}</span> <span className="text-muted">days</span>
            </div>
          </div>
          <div className="fs-13 mb-3">
            <span className="text-muted">Track record: </span>
            {recordFacts(rep, c.beneficiaryAgent !== null)} · <span className="num">{presentedCount(c)}/{requiredCount(c)}</span> documents in
          </div>

          <label className="form-label" htmlFor="offer-price">Your price</label>
          <div className="input-group">
            <input id="offer-price" className="form-control num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/,/g, ""))} />
            <span className="input-group-text">{ccy}</span>
          </div>
          <div className="form-text">
            Suggested from the time to expiry and the track record: <span className="num">{(suggested.annualRate * 100).toFixed(1)}%</span> a year.
          </div>

          <label className="form-label mt-3 d-flex justify-content-between" htmlFor="offer-rate">
            <span>Annual rate</span>
            <span className="num">{(rate * 100).toFixed(1)}%</span>
          </label>
          <input
            id="offer-rate"
            type="range"
            className="form-range"
            min={0}
            max={40}
            step={0.5}
            value={Math.min(40, Math.max(0, rate * 100))}
            onChange={(e) => setPrice((Number(priceAt(Number(e.target.value) / 100)) / 1e6).toFixed(2))}
          />

          <div className="bg-light rounded-3 p-3 my-3 fs-14">
            You pay <Amount value={units ?? 0n} token={c.token} className="fw-semibold text-dark" /> today, you collect{" "}
            <Amount value={net} token={c.token} className="fw-semibold text-dark" /> on delivery
            {net < c.outstanding && <> (after <Amount value={c.outstanding - net} token={c.token} /> of settlement fees)</>}: a return of{" "}
            <Amount value={ret > 0n ? ret : 0n} token={c.token} className="fw-semibold text-dark" /> (<span className="num">{(rate * 100).toFixed(1)}%</span> annualized to expiry).
          </div>

          <label className="form-label" htmlFor="offer-valid">Offer valid for</label>
          <div className="input-group mb-3">
            <input id="offer-valid" type="number" min={1} max={30} className="form-control num" value={validDays} onChange={(e) => setValidDays(e.target.value)} />
            <span className="input-group-text">days</span>
          </div>

          <ul className="list-unstyled fs-13 text-muted d-grid gap-2">
            <li><i className="ti ti-alert-triangle me-1" />The risk: if the exporter never ships, the credit expires and the funds go back to the importer. You lose the price.</li>
            <li><i className="ti ti-lock me-1" />Your price is held by the contract until the exporter accepts or you withdraw. Withdraw anytime.</li>
            <li><i className="ti ti-arrows-exchange me-1" />If accepted, the contract pays you instead of the exporter, shipment by shipment.</li>
          </ul>

          {problem && units !== null && <div className="alert alert-warning fs-13 py-2">{problem}</div>}
          <div className="d-grid gap-2">
            <SignButton
              busy={busy}
              disabled={!!problem}
              onClick={() => {
                setBusy(true);
                void submit(units!, BigInt(Math.min(now + Math.round(vd * DAY), Number(c.expiry)))).finally(() => setBusy(false));
              }}
            >
              Authorize and offer
            </SignButton>
            <FeeNote />
          </div>
        </div>
      </div>
      <div className="offcanvas-backdrop fade show" onClick={close} />
    </>
  );
}
