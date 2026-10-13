import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type Address, isAddress, parseUnits } from "viem";
import { ARC, DOC_LABELS, type OpenParams, docType, documentaryCreditAbi, validateOpenParams } from "@credoc/sdk";
import { CREDOC_ADDRESS } from "../../shared/config";
import { useBrand } from "../../shared/brand";
import { dateShort, pct, sameAddress } from "../../shared/format";
import { Amount, Card, PageTitle } from "../components/ui";
import { FeeNote, FileDrop, type Hashed, SignButton, partyName, prettyDoc } from "../components/form-kit";
import { publicClient, reader, readFees } from "../lib/clients";
import { useStore } from "../lib/store";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";

type Ccy = "USDC" | "EURC";
type DocRow = { label: string; custom: string; attestor: string };
type TrRow = { amount: string; docs: boolean[] };
type Form = {
  beneficiary: string;
  ccy: Ccy;
  ref: string;
  docs: DocRow[];
  tranches: TrRow[];
  expiry: string; // YYYY-MM-DD
  terms: Hashed | null;
  agent: string;
};

const CUSTOM = "__custom";
const DAY = 86400;
const STEPS = ["Parties and currency", "Documents", "Shipments", "Review"];
const ZERO32 = `0x${"0".repeat(64)}` as const;

const isoDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
/** noon UTC of the chosen day: far from both day boundaries */
const dayToTs = (d: string) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
const toUnits = (s: string): bigint | null => {
  if (!/^\d+(\.\d{1,6})?$/.test(s.trim())) return null;
  return parseUnits(s.trim(), 6);
};
/** What the exporter will be charged on each paid shipment, as the contract will fix it at opening. */
type Pricing = { feeBps: number; proFeeBps: number; importerPlan: boolean; partnerRegistered: boolean };

const labelOf = (d: DocRow) =>
  d.label === CUSTOM ? d.custom.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") : d.label;


export function NewCredit() {
  const { address, balances } = useWallet();
  const { now } = useStore();
  const { run } = useTx();
  const navigate = useNavigate();
  const brand = useBrand();
  const [pricing, setPricing] = useState<Pricing | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    // the contract refuses a partner the owner has not registered: until it is, credits open without one
    const share = brand.partner && CREDOC_ADDRESS
      ? publicClient.readContract({ address: CREDOC_ADDRESS, abi: documentaryCreditAbi, functionName: "partnerShareBps", args: [brand.partner] })
      : 0;
    Promise.all([readFees(), reader?.plans(address) ?? null, share])
      .then(([fees, plans, shareBps]) =>
        live && fees && setPricing({ ...fees, importerPlan: !!plans?.importer.active, partnerRegistered: Number(shareBps) > 0 }),
      )
      .catch(() => undefined); // the fee line simply stays generic, and no partner is passed
    return () => {
      live = false;
    };
  }, [address, brand.partner]);
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Form>(() => ({
    beneficiary: "",
    ccy: "USDC",
    ref: "",
    docs: [{ label: "BILL_OF_LADING", custom: "", attestor: "" }],
    tranches: [{ amount: "", docs: [true] }],
    expiry: "", // empty = default, 30 days after the chain clock (known only once the first block is read)
    terms: null,
    agent: "",
  }));
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const setDoc = (i: number, patch: Partial<DocRow>) => set({ docs: f.docs.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const setTr = (i: number, patch: Partial<TrRow>) => set({ tranches: f.tranches.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const token: Address = f.ccy === "USDC" ? ARC.usdc : ARC.eurc;
  const balance = balances ? (f.ccy === "USDC" ? balances.usdc : balances.eurc) : null;
  const amounts = f.tranches.map((t) => toUnits(t.amount));
  const total = amounts.reduce<bigint>((s, a) => s + (a ?? 0n), 0n);
  const t0 = now();
  // nor a partner that is a party to the credit
  const partner =
    brand.partner && pricing?.partnerRegistered && !sameAddress(brand.partner, address) && !sameAddress(brand.partner, f.beneficiary)
      ? brand.partner
      : null;
  const expiry = f.expiry || isoDay(t0 + 30 * DAY);

  // per-step problems, in plain words
  const problems = (() => {
    const p: string[][] = [[], [], [], []];
    if (!isAddress(f.beneficiary)) p[0]!.push("Enter the exporter's wallet address (0x…).");
    else if (sameAddress(f.beneficiary, address)) p[0]!.push("The exporter must be another wallet than yours.");
    if (!f.ref.trim()) p[0]!.push("Add your purchase order reference.");
    else if (f.ref.length > 64) p[0]!.push("Keep the reference under 64 characters.");

    if (f.docs.length === 0) p[1]!.push("Require at least one document.");
    f.docs.forEach((d, i) => {
      const n = `Document ${i + 1}`;
      if (!labelOf(d)) p[1]!.push(`${n}: name the document.`);
      if (!isAddress(d.attestor)) p[1]!.push(`${n}: enter the attestor's wallet address.`);
      else if (sameAddress(d.attestor, address) || sameAddress(d.attestor, f.beneficiary))
        p[1]!.push(`${n}: the attestor must be independent from you and the exporter.`);
    });
    const labels = f.docs.map(labelOf);
    if (new Set(labels).size !== labels.length) p[1]!.push("Each document can be listed only once.");

    f.tranches.forEach((t, i) => {
      const n = `Shipment ${i + 1}`;
      if (!amounts[i] || amounts[i] === 0n) p[2]!.push(`${n}: enter an amount (up to 6 decimals).`);
      if (!f.docs.some((_, d) => t.docs[d])) p[2]!.push(`${n}: tick at least one document.`);
    });
    const exp = dayToTs(expiry);
    if (!exp || exp <= t0) p[2]!.push("The expiry must be in the future.");
    else if (exp > t0 + 730 * DAY) p[2]!.push("The expiry must be within 730 days.");
    if (f.agent && !/^\d+$/.test(f.agent.trim())) p[2]!.push("The identity number is a whole number.");
    return p;
  })();

  const params: OpenParams | null =
    problems.slice(0, 3).every((x) => x.length === 0)
      ? {
          beneficiary: f.beneficiary as Address,
          token,
          expiry: BigInt(dayToTs(expiry)),
          terms: f.terms?.hash ?? ZERO32,
          applicantAgent: f.agent.trim() ? BigInt(f.agent.trim()) : undefined,
          partner: partner ?? undefined,
          integratorFeeBps: partner ? brand.integratorFeeBps : 0,
          docs: f.docs.map((d) => ({ docType: docType(labelOf(d)), attestor: d.attestor as Address })),
          tranches: f.tranches.map((t, i) => ({
            amount: amounts[i]!,
            requiredDocs: t.docs.reduce((m, on, d) => (on && d < f.docs.length ? m | (1 << d) : m), 0),
          })),
        }
      : null;
  const sdkErrors = params && address ? validateOpenParams(params, address, BigInt(t0)) : [];
  const short = balance !== null && total > balance;

  const go = (to: number) => {
    // forward only through valid steps; backward always
    for (let s = step; s < to; s++) {
      if (problems[s]!.length) {
        setStep(s);
        setTried(true);
        return;
      }
    }
    setTried(false);
    setStep(to);
    window.scrollTo({ top: 0 });
  };

  const removeDoc = (i: number) =>
    set({ docs: f.docs.filter((_, j) => j !== i), tranches: f.tranches.map((t) => ({ ...t, docs: t.docs.filter((_, j) => j !== i) })) });
  const addDoc = () => {
    const used = new Set(f.docs.map((d) => d.label));
    const next = DOC_LABELS.find((l) => !used.has(l)) ?? CUSTOM;
    set({ docs: [...f.docs, { label: next, custom: "", attestor: "" }], tranches: f.tranches.map((t) => ({ ...t, docs: [...t.docs, true] })) });
  };

  const submit = async () => {
    if (!params) return;
    setBusy(true);
    let id: bigint | null = null;
    const ok = await run(`Open credit ${f.ref.trim()}`, async (c) => {
      id = (await c.open(params, f.ref.trim())).id;
    });
    setBusy(false);
    if (ok && id !== null) navigate(`/credits/${String(id)}`);
  };

  const shown = tried ? problems[step]! : [];
  const exporterName = isAddress(f.beneficiary) ? partyName(f.beneficiary) : "the exporter";

  return (
    <>
      <PageTitle title="Open a credit" subtitle="Lock the funds once. The exporter is paid automatically, shipment by shipment, when the documents arrive." />
      <div className="row justify-content-center">
        <div className="col-xl-9">
          <div className="card">
            <div className="card-body pt-0">
              <ul className="nav nav-pills nav-justified form-wizard-header mb-4">
                {STEPS.map((s, i) => (
                  <li key={s} className="nav-item">
                    <button
                      type="button"
                      className={`nav-link rounded-0 py-3 w-100 ${i === step ? "fw-semibold text-dark" : "text-muted"}`}
                      style={{ borderBottom: i === step ? "2px solid #191919" : "2px solid transparent" }}
                      onClick={() => go(i)}
                      aria-current={i === step ? "step" : undefined}
                    >
                      <span
                        className={`d-inline-flex align-items-center justify-content-center rounded-circle fw-semibold fs-12 me-sm-2 num ${
                          i < step ? "bg-dark text-white" : i === step ? "border border-dark text-dark" : "border text-muted"
                        }`}
                        style={{ width: 24, height: 24 }}
                      >
                        {i < step ? <i className="ti ti-check" /> : i + 1}
                      </span>
                      <span className="d-none d-sm-inline">{s}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {step === 0 && (
                <div className="row g-3">
                  <div className="col-12">
                    <label className="form-label" htmlFor="nc-exp">Exporter (who gets paid)</label>
                    <input id="nc-exp" className="form-control font-monospace" placeholder="0x…" value={f.beneficiary} onChange={(e) => set({ beneficiary: e.target.value.trim() })} />
                  </div>
                  <div className="col-md-6">
                    <span className="form-label d-block">Currency</span>
                    <div className="btn-group w-100" role="group" aria-label="Currency">
                      {(["USDC", "EURC"] as const).map((c) => (
                        <button key={c} type="button" className={`btn ${f.ccy === c ? "btn-light border-dark fw-semibold" : "btn-outline-light border text-dark"}`} onClick={() => set({ ccy: c })} aria-pressed={f.ccy === c}>
                          {c}<span className="d-none d-sm-inline">{c === "USDC" ? " · digital dollar" : " · digital euro"}</span>
                        </button>
                      ))}
                    </div>
                    <div className="form-text">
                      {balance !== null ? (
                        <>
                          Available: <Amount value={balance} token={token} />
                        </>
                      ) : (
                        "Connect a wallet to see your balance."
                      )}
                    </div>
                  </div>
                  <div className="col-md-6">
                    <label className="form-label" htmlFor="nc-ref">Purchase order reference</label>
                    <input id="nc-ref" className="form-control" placeholder="PO-2026-1010" value={f.ref} maxLength={64} onChange={(e) => set({ ref: e.target.value })} />
                    <div className="form-text">Tagged on the transaction with Arc Memo, so both sides find it in their books.</div>
                  </div>
                </div>
              )}

              {step === 1 && (
                <>
                  <p className="text-muted">
                    List the documents that prove the goods shipped, and who vouches for each. <strong className="text-dark">Attestors must be independent from you and the exporter</strong>: a freight forwarder, an inspection company.
                  </p>
                  <div className="list-group mb-3">
                    {f.docs.map((d, i) => (
                      <div key={i} className="list-group-item py-3">
                        <div className="row g-2 align-items-end">
                          <div className="col-md-5">
                            <label className="form-label fs-12 text-muted mb-1" htmlFor={`nc-doc-${i}`}>Document {i + 1}</label>
                            <select id={`nc-doc-${i}`} className="form-select" value={d.label} onChange={(e) => setDoc(i, { label: e.target.value })}>
                              {DOC_LABELS.map((l) => (
                                <option key={l} value={l}>{prettyDoc(l)}</option>
                              ))}
                              <option value={CUSTOM}>Other document…</option>
                            </select>
                            {d.label === CUSTOM && (
                              <input className="form-control mt-2" placeholder="e.g. Fumigation certificate" value={d.custom} onChange={(e) => setDoc(i, { custom: e.target.value })} aria-label="Document name" />
                            )}
                          </div>
                          <div className="col-md-6">
                            <label className="form-label fs-12 text-muted mb-1" htmlFor={`nc-att-${i}`}>Attestor</label>
                            <input id={`nc-att-${i}`} className="form-control font-monospace" placeholder="0x…" value={d.attestor} onChange={(e) => setDoc(i, { attestor: e.target.value.trim() })} />
                          </div>
                          <div className="col-md-1 text-md-end">
                            <button type="button" className="btn btn-sm btn-outline-light text-muted" onClick={() => removeDoc(i)} disabled={f.docs.length === 1} aria-label={`Remove document ${i + 1}`}>
                              <i className="ti ti-trash" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="btn btn-outline-dark btn-sm" onClick={addDoc} disabled={f.docs.length >= 8}>
                    <i className="ti ti-plus me-1" /> Add a document
                  </button>
                  <span className="fs-12 text-muted ms-2 num">{f.docs.length} of 8</span>
                </>
              )}

              {step === 2 && (
                <>
                  <p className="text-muted">Split the payment by shipment. Each shipment is paid on its own, as soon as its documents are in.</p>
                  <div className="table-responsive">
                    <table className="table table-centered mb-0">
                      <thead>
                        <tr>
                          <th>Shipment</th>
                          <th style={{ minWidth: 150 }}>Amount ({f.ccy})</th>
                          {f.docs.map((d, i) => (
                            <th key={i} className="fs-12 text-center">{d.label === CUSTOM ? d.custom || `Document ${i + 1}` : prettyDoc(d.label)}</th>
                          ))}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {f.tranches.map((t, i) => (
                          <tr key={i}>
                            <td className="fw-medium num">#{i + 1}</td>
                            <td>
                              <input className="form-control num" inputMode="decimal" placeholder="15000" value={t.amount} onChange={(e) => setTr(i, { amount: e.target.value.replace(/,/g, "") })} aria-label={`Amount for shipment ${i + 1}`} />
                            </td>
                            {f.docs.map((d, j) => (
                              <td key={j} className="text-center">
                                <input
                                  type="checkbox"
                                  className="form-check-input"
                                  checked={!!t.docs[j]}
                                  onChange={(e) => setTr(i, { docs: f.docs.map((_, k) => (k === j ? e.target.checked : !!t.docs[k])) })}
                                  aria-label={`Shipment ${i + 1} needs ${prettyDoc(labelOf(d) || "document")}`}
                                />
                              </td>
                            ))}
                            <td className="text-end">
                              <button type="button" className="btn btn-sm btn-outline-light text-muted" onClick={() => set({ tranches: f.tranches.filter((_, j) => j !== i) })} disabled={f.tranches.length === 1} aria-label={`Remove shipment ${i + 1}`}>
                                <i className="ti ti-trash" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td className="fw-semibold">Total</td>
                          <td colSpan={f.docs.length + 2}>
                            <Amount value={total} token={token} className="fw-semibold" />
                            {short && <span className="text-warning fs-12 ms-2">More than your balance</span>}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <button type="button" className="btn btn-outline-dark btn-sm mt-2" onClick={() => set({ tranches: [...f.tranches, { amount: "", docs: f.docs.map(() => true) }] })} disabled={f.tranches.length >= 8}>
                    <i className="ti ti-plus me-1" /> Add a shipment
                  </button>
                  <span className="fs-12 text-muted ms-2 num">{f.tranches.length} of 8</span>

                  <div className="row g-3 mt-2">
                    <div className="col-md-6">
                      <label className="form-label" htmlFor="nc-expiry">Expiry</label>
                      <input id="nc-expiry" type="date" className="form-control" value={expiry} min={isoDay(t0 + DAY)} max={isoDay(t0 + 729 * DAY)} onChange={(e) => set({ expiry: e.target.value })} />
                      <div className="form-text">Unpaid shipments come back to you after this date. Up to two years.</div>
                    </div>
                    <div className="col-md-6">
                      <label className="form-label" htmlFor="nc-agent">Link my ERC-8004 identity <span className="text-muted fw-normal">(optional)</span></label>
                      <input id="nc-agent" className="form-control num" inputMode="numeric" placeholder="Identity number, e.g. 12" value={f.agent} onChange={(e) => set({ agent: e.target.value.trim() })} />
                      <div className="form-text">Builds your public track record as a buyer. Find or create yours on the Track record page.</div>
                    </div>
                    <div className="col-12">
                      <span className="form-label d-block">Proforma invoice or sales contract <span className="text-muted fw-normal">(recommended)</span></span>
                      <FileDrop value={f.terms} onChange={(terms) => set({ terms })} note="Your file never leaves this device, only its fingerprint is recorded." />
                    </div>
                  </div>
                </>
              )}

              {step === 3 && (
                <Review f={{ ...f, expiry }} token={token} total={total} amounts={amounts} exporterName={exporterName} pricing={pricing} partnerFee={partner ? { name: brand.name, bps: brand.integratorFeeBps } : null} />
              )}

              {(shown.length > 0 || (step === 3 && (sdkErrors.length > 0 || problems.some((p) => p.length)))) && (
                <div className="alert alert-warning mt-3 mb-0 fs-13" role="alert">
                  <ul className="mb-0 ps-3">
                    {(step === 3 ? [...problems.flat(), ...sdkErrors.map((e) => e.charAt(0).toUpperCase() + e.slice(1) + ".")] : shown).map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="card-footer d-flex flex-wrap justify-content-between align-items-center gap-2 border-top border-dashed">
              <button type="button" className="btn btn-outline-dark" onClick={() => go(step - 1)} disabled={step === 0}>
                <i className="ti ti-arrow-left me-1" /> Back
              </button>
              {step < 3 ? (
                <button type="button" className="btn btn-dark" onClick={() => go(step + 1)}>
                  Continue <i className="ti ti-arrow-right ms-1" />
                </button>
              ) : (
                <div className="d-flex flex-column align-items-end gap-1">
                  <SignButton onClick={() => void submit()} busy={busy} disabled={!params || sdkErrors.length > 0 || short}>
                    <i className="ti ti-lock me-1" /> Lock funds and open
                  </SignButton>
                  <FeeNote />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

type PartnerFee = { name: string; bps: number } | null;

function FeeLine({ pricing, partner }: { pricing: Pricing | null; partner: PartnerFee }) {
  const pro = !!pricing && pricing.importerPlan && pricing.proFeeBps < pricing.feeBps;
  const partnerFee = partner && partner.bps > 0 ? <>, plus {pct(partner.bps)} for {partner.name}</> : null;
  return (
    <li>
      <i className="ti ti-receipt me-1" />
      {!pricing ? (
        <>The exporter pays Credoc's settlement fee on each paid shipment{partnerFee}. Refunds are free.</>
      ) : pro ? (
        <>The exporter pays {pct(pricing.proFeeBps)} instead of {pct(pricing.feeBps)} on each paid shipment, thanks to your importer plan{partnerFee}. Refunds are free.</>
      ) : (
        <>
          The exporter pays {pct(pricing.feeBps)} on each paid shipment{partnerFee}. Refunds are free.
          {pricing.proFeeBps < pricing.feeBps && (
            <> With an <Link to="/plans" className="link-dark">importer plan</Link>, credits you open cost {pct(pricing.proFeeBps)}.</>
          )}
        </>
      )}
    </li>
  );
}

function Review({ f, token, total, amounts, exporterName, pricing, partnerFee }: { f: Form; token: Address; total: bigint; amounts: (bigint | null)[]; exporterName: string; pricing: Pricing | null; partnerFee: PartnerFee }) {
  const docName = (i: number) => {
    const d = f.docs[i]!;
    return (d.label === CUSTOM ? d.custom.trim() || `document ${i + 1}` : prettyDoc(d.label)).toLowerCase();
  };
  const who = (i: number) => (isAddress(f.docs[i]!.attestor) ? partyName(f.docs[i]!.attestor) : "the attestor");
  return (
    <>
      <div className="text-center py-3">
        <div className="micro-label mb-1">You lock</div>
        <Amount value={total} token={token} serif className="fs-24 text-dark" />
        <div className="text-muted mt-1">
          for {exporterName}, reference <span className="fw-medium text-dark">{f.ref.trim() || "missing"}</span>, until {f.expiry ? dateShort(dayToTs(f.expiry)) : "?"}
        </div>
      </div>
      <ol className="list-group list-group-numbered mb-3">
        {f.tranches.map((t, i) => {
          const need = f.docs.map((_, j) => j).filter((j) => t.docs[j]);
          return (
            <li key={i} className="list-group-item d-flex gap-1">
              <span>
                {exporterName} is paid <Amount value={amounts[i] ?? 0n} token={token} className="fw-semibold text-dark" /> as soon as{" "}
                {need.length === 0
                  ? "(no document ticked)"
                  : need.map((j, k) => (
                      <Fragment key={j}>
                        {k > 0 && <strong> AND </strong>}
                        {who(j)} presents the {docName(j)}
                      </Fragment>
                    ))}{" "}
                for shipment {i + 1}.
              </span>
            </li>
          );
        })}
      </ol>
      <ul className="list-unstyled fs-13 text-muted mb-0 d-grid gap-1">
        <li><i className="ti ti-arrow-back-up me-1" />Shipments not paid by the expiry come back to you.</li>
        <FeeLine pricing={pricing} partner={partnerFee} />
        <li><i className="ti ti-stack-2 me-1" />ONE transaction: it authorizes the amount and opens the credit, tagged with your reference by Arc Memo.</li>
        <li><i className="ti ti-fingerprint me-1" />{f.terms ? <>Contract fingerprint <span className="hash">{f.terms.hash.slice(0, 18)}…</span> ({f.terms.name})</> : "No contract file attached."}</li>
        {f.agent && <li><i className="ti ti-id-badge-2 me-1" />Linked to your identity #{f.agent}.</li>}
      </ul>
    </>
  );
}
