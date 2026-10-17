import { useState } from "react";
import { Link } from "react-router-dom";
import type { Hex } from "viem";
import { signPresentation } from "@credoc/sdk";
import { CREDOC_ADDRESS, chain } from "../../shared/config";
import { contractErrorMessage, humanError } from "../../shared/errors";
import { dateShort, sameAddress, shortHex, utc } from "../../shared/format";
import { Card, Empty, PageTitle, Skeleton, TxLink, When } from "../components/ui";
import { FeeNote, FileDrop, type Hashed, SignButton, daysLeft, partyName, prettyDoc } from "../components/form-kit";
import { type CreditRow, useStore } from "../lib/store";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";

type Item = { c: CreditRow; tranche: number; doc: number };
const keyOf = (i: Item) => `${i.c.id}-${i.tranche}-${i.doc}`;

/** Relayer answers with the contract error name; say it the way an attestor would. */
const RELAY_ERRORS: Record<string, string> = {
  Expired: "This credit has expired: documents can no longer be presented.",
  NotActive: "This credit is already closed.",
  AlreadySatisfied: "This document was already presented for this shipment.",
  NotRequired: "This shipment does not require that document.",
  BadSignature: "The signature does not match the nominated attestor for this document.",
  SignatureExpired: "Your signature expired before it was sent. Sign again.",
  Unauthorized: "Your wallet is not the nominated attestor for this document.",
  "relayer is not configured": "The relay service is offline. Use \"Present directly\" instead.",
};

export function Attest() {
  const { address, wallet, wrongChain } = useWallet();
  const { credits, events, now, status, refresh } = useStore();
  const { run, notify } = useTx();
  const [sel, setSel] = useState<string | null>(null);
  const [file, setFile] = useState<Hashed | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ hash: Hex; seconds: number } | null>(null);
  const [quota, setQuota] = useState(false); // the relayer's free monthly presentations are used up (HTTP 402)
  const t = now();

  const inbox: Item[] = [];
  if (address)
    for (const c of credits) {
      if (c.status !== 1 || t > Number(c.expiry)) continue;
      c.tranches.forEach((tr, ti) => {
        if (tr.settled) return;
        for (const d of tr.documents)
          if (d.required && !d.satisfied && sameAddress(c.docs[d.doc]!.attestor, address)) inbox.push({ c, tranche: ti, doc: d.doc });
      });
    }
  const groups = [...new Set(inbox.map((i) => i.c))];
  const current = inbox.find((i) => keyOf(i) === sel) ?? null;
  const done = address ? events.filter((e) => e.name === "DocumentPresented" && sameAddress(e.args.attestor as string, address)) : [];

  const titleOf = (i: Item) => `${prettyDoc(i.c.docs[i.doc]!.label)} for ${i.c.ref || `#${i.c.id}`}`;
  const deadline = BigInt(t + 3600);

  const pick = (i: Item) => {
    setSel(keyOf(i));
    setFile(null);
    setLast(null);
    setQuota(false);
  };

  const signAndRelay = async () => {
    if (!current || !file || !wallet || !CREDOC_ADDRESS) return;
    const title = titleOf(current);
    // the signature binds chain.id: a wallet on another network refuses it or signs for nothing
    if (wrongChain) return notify(title, "failed", "Your wallet is on another network. Switch to Arc first.");
    setBusy(true);
    try {
      const s = await signPresentation(wallet as never, CREDOC_ADDRESS, chain.id, {
        creditId: current.c.id,
        tranche: current.tranche,
        doc: current.doc,
        docHash: file.hash,
        deadline: BigInt(now() + 3600),
      });
      notify(title, "info", "Signed. Sending through the relayer…");
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creditId: s.creditId.toString(),
          tranche: s.tranche,
          doc: s.doc,
          docHash: s.docHash,
          deadline: s.deadline.toString(),
          signature: s.signature,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { hash?: Hex; seconds?: number; error?: string };
      if (res.ok && body.hash) {
        setLast({ hash: body.hash, seconds: body.seconds ?? 0 });
        notify(title, "confirmed", undefined, { hash: body.hash, seconds: body.seconds });
        setSel(null);
        setFile(null);
        await refresh();
      } else if (res.status === 402) {
        setQuota(true);
        notify(title, "failed", "Your free relayed presentations for this month are used.");
      } else {
        const err = body.error ?? `relay failed (${res.status})`;
        notify(title, "failed", RELAY_ERRORS[err] ?? contractErrorMessage(err) ?? err);
      }
    } catch (e) {
      notify(title, "failed", humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const presentDirect = async () => {
    if (!current || !file) return;
    setBusy(true);
    const ok = await run(titleOf(current), (c) => c.present(current.c.id, current.tranche, current.doc, file.hash));
    setBusy(false);
    if (ok) {
      setSel(null);
      setFile(null);
    }
  };

  return (
    <>
      <PageTitle title="Attest documents" subtitle="Documents you were nominated to vouch for. Sign for free, the relayer pays the network fee." />

      {last && (
        <div className="alert alert-success d-flex flex-wrap align-items-center gap-2" role="status">
          <i className="ti ti-circle-check" /> Presented and final in <span className="num fw-semibold">{last.seconds.toFixed(2)} s.</span> Transaction <TxLink hash={last.hash} />
        </div>
      )}

      <div className="row">
        <div className={current ? "col-lg-7" : "col-12"}>
          <Card title="To attest" action={<span className="fs-12 text-muted num">{inbox.length} open</span>} bodyClass={groups.length ? "p-0" : ""}>
            {status === "loading" ? (
              <Skeleton />
            ) : !address ? (
              <Empty icon="ti-signature" title="Choose your wallet to see your inbox">
                Attestors are the independent parties of a trade, such as the freight forwarder or the inspector. When a credit names you, its documents show up here. Signing costs you nothing.
              </Empty>
            ) : groups.length === 0 ? (
              <Empty icon="ti-inbox" title="Nothing to attest right now">
                When an importer names you as attestor on a credit, the document appears here. You check the real paper, drop the file, and sign: the exporter is paid the moment the last document of a shipment is in.
              </Empty>
            ) : (
              groups.map((c) => (
                <div key={String(c.id)} className="border-bottom border-dashed">
                  <div className="d-flex flex-wrap justify-content-between gap-2 px-3 pt-3 pb-2">
                    <div>
                      <Link to={`/credits/${c.id}`} className="fw-semibold text-dark">{c.ref || `Credit #${c.id}`}</Link>
                      <span className="text-muted fs-12 ms-2">#{String(c.id)} · exporter {partyName(c.beneficiary)}</span>
                    </div>
                    <span className="fs-12 text-muted">
                      Expires {dateShort(c.expiry)} · <span className="num">{daysLeft(c.expiry, t)}</span> days left
                    </span>
                  </div>
                  <div className="list-group list-group-flush">
                    {inbox
                      .filter((i) => i.c === c)
                      .map((i) => (
                        <button
                          key={keyOf(i)}
                          type="button"
                          className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center px-3 ${keyOf(i) === sel ? "bg-light fw-semibold text-dark" : ""}`}
                          onClick={() => pick(i)}
                          aria-pressed={keyOf(i) === sel}
                        >
                          <span>
                            <i className="ti ti-file-description me-2" aria-hidden="true" />
                            {prettyDoc(c.docs[i.doc]!.label)} <span className="opacity-75 fs-12">· shipment {i.tranche + 1}</span>
                          </span>
                          <i className="ti ti-chevron-right" aria-hidden="true" />
                        </button>
                      ))}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>

        {current && (
          <div className="col-lg-5">
            <Card
              title={titleOf(current)}
              action={
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setSel(null)} />
              }
            >
              <p className="text-muted fs-13">
                Shipment {current.tranche + 1} of credit #{String(current.c.id)}, exporter {partyName(current.c.beneficiary)}. Drop the document you checked.
              </p>
              <FileDrop value={file} onChange={setFile} big />

              {file && (
                <div className="mt-3">
                  <div className="micro-label mb-2">You sign exactly this</div>
                  <dl className="row fs-13 mb-2">
                    <dt className="col-4 fw-normal text-muted">Credit</dt>
                    <dd className="col-8">#{String(current.c.id)} · {current.c.ref}</dd>
                    <dt className="col-4 fw-normal text-muted">Shipment</dt>
                    <dd className="col-8 num">{current.tranche + 1}</dd>
                    <dt className="col-4 fw-normal text-muted">Document</dt>
                    <dd className="col-8">{prettyDoc(current.c.docs[current.doc]!.label)}</dd>
                    <dt className="col-4 fw-normal text-muted">Fingerprint</dt>
                    <dd className="col-8 hash text-break">{file.hash}</dd>
                    <dt className="col-4 fw-normal text-muted">Valid until</dt>
                    <dd className="col-8">{utc(deadline)} (1 hour)</dd>
                  </dl>
                  <p className="fs-12 text-muted">
                    In words: "I, the nominated attestor, confirm that this file is the {prettyDoc(current.c.docs[current.doc]!.label).toLowerCase()} for shipment {current.tranche + 1} of {current.c.ref}." Signed for the Credoc contract {CREDOC_ADDRESS ? shortHex(CREDOC_ADDRESS) : ""} on {chain.name} only.
                  </p>
                  <div className="d-grid gap-2">
                    <SignButton onClick={() => void signAndRelay()} busy={busy}>
                      <i className="ti ti-signature me-1" /> Sign (no fee)
                    </SignButton>
                    <FeeNote free />
                    {quota && (
                      <div className="alert alert-warning fs-13 mb-0" role="alert">
                        <div className="fw-semibold mb-1">Free relays used for this month</div>
                        Without a plan, the relayer pays for 5 presentations per 30 days. To keep signing for free,{" "}
                        <Link to="/plans" className="link-dark fw-medium">buy an attestor plan</Link> or ask the importer to sponsor one for your
                        address. Or present this document now from your own wallet with "Present directly" below (about 0.01 USDC).
                      </div>
                    )}
                    {address && (
                      <button type="button" className="btn btn-link btn-sm text-muted" onClick={() => void presentDirect()} disabled={busy}>
                        Present directly (you pay ~0.01 USDC)
                      </button>
                    )}
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {address && (
        <Card title="Done" action={<span className="fs-12 text-muted num">{done.length}</span>} bodyClass="p-0">
          {done.length === 0 ? (
            <p className="text-muted p-3 mb-0">Your presentations will be listed here, with their fingerprint and transaction.</p>
          ) : (
            <div className="table-responsive">
              <table className="table table-hover table-centered mb-0">
                <thead>
                  <tr>
                    <th>Credit</th>
                    <th>Document</th>
                    <th>Fingerprint</th>
                    <th>When</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {done.map((e) => {
                    const c = credits.find((x) => x.id === e.args.creditId);
                    const doc = Number(e.args.doc);
                    return (
                      <tr key={`${e.tx}-${e.logIndex}`}>
                        <td>
                          <Link to={`/credits/${String(e.args.creditId)}`} className="text-dark fw-medium">{c?.ref || `#${String(e.args.creditId)}`}</Link>
                        </td>
                        <td>
                          {c ? prettyDoc(c.docs[doc]!.label) : `Document ${doc + 1}`} <span className="text-muted fs-12">· shipment {Number(e.args.tranche) + 1}</span>
                        </td>
                        <td className="hash" title={String(e.args.docHash)}>{shortHex(String(e.args.docHash))}</td>
                        <td><When ts={e.time} now={t} /></td>
                        <td><TxLink hash={e.tx} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
