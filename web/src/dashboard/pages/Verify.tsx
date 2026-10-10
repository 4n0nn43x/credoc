import { useState } from "react";
import { Link } from "react-router-dom";
import { dateShort, utc } from "../../shared/format";
import { PageTitle, Skeleton, TxLink, When } from "../components/ui";
import { FileDrop, type Hashed, partyName, prettyDoc } from "../components/form-kit";
import { useStore } from "../lib/store";

/** Public checker: is this exact file the one presented (or agreed) on a Credoc credit? No wallet needed. */
export function Verify() {
  const { credits, byId, events, now, status } = useStore();
  const [file, setFile] = useState<Hashed | null>(null);
  const t = now();

  const h = file?.hash.toLowerCase();
  const presented = h ? events.filter((e) => e.name === "DocumentPresented" && String(e.args.docHash).toLowerCase() === h) : [];
  const terms = h ? credits.filter((c) => c.terms.toLowerCase() === h) : [];
  const found = presented.length + terms.length > 0;

  return (
    <>
      <PageTitle title="Verify a document" subtitle="Check that a bill of lading, certificate or contract is exactly the one recorded on Arc. No wallet, no upload." />
      <div className="row justify-content-center">
        <div className="col-xl-8 col-lg-10">
          <div className="card">
            <div className="card-body p-4">
              <FileDrop
                value={file}
                onChange={setFile}
                big
                prompt="Drop the document you received"
                note="The file is fingerprinted in your browser and never sent anywhere. We compare its fingerprint with the ones recorded on Arc."
              />
            </div>
          </div>

          {file && status === "loading" && (
            <div className="card">
              <div className="card-body"><Skeleton /></div>
            </div>
          )}

          {file && status !== "loading" && found && (
            <div className="card border-success-subtle" role="status">
              <div className="card-body p-4">
                <div className="d-flex align-items-center gap-2 mb-3">
                  <span className="badge-soft tone-success fs-13"><i className="ti ti-rosette-discount-check" /> Authentic</span>
                  <span className="text-muted fs-13">This exact file is on record.</span>
                </div>
                <div className="d-grid gap-3">
                  {presented.map((e) => {
                    const c = byId.get(String(e.args.creditId));
                    const doc = Number(e.args.doc);
                    const name = c ? prettyDoc(c.docs[doc]!.label).toLowerCase() : "document";
                    return (
                      <div key={`${e.tx}-${e.logIndex}`} className="border-start border-2 border-dark ps-3">
                        <p className="fs-16 text-dark mb-1">
                          Matches the {name} presented by <strong>{partyName(String(e.args.attestor))}</strong> for{" "}
                          <Link to={`/credits/${String(e.args.creditId)}`} className="link-dark fw-semibold">{c?.ref || `credit #${String(e.args.creditId)}`}</Link>, shipment {Number(e.args.tranche) + 1},{" "}
                          <When ts={e.time} now={t} />.
                        </p>
                        <div className="fs-12 text-muted d-flex flex-wrap gap-2 align-items-center">
                          <span title={utc(e.time)}>{utc(e.time)}</span>·<span>Transaction</span> <TxLink hash={e.tx} />
                        </div>
                      </div>
                    );
                  })}
                  {terms.map((c) => (
                    <div key={String(c.id)} className="border-start border-2 border-dark ps-3">
                      <p className="fs-16 text-dark mb-1">
                        Matches the contract terms agreed for{" "}
                        <Link to={`/credits/${c.id}`} className="link-dark fw-semibold">{c.ref || `credit #${c.id}`}</Link> between {partyName(c.applicant)} and {partyName(c.beneficiary)}, locked on {dateShort(c.openedAt)}.
                      </p>
                      <div className="fs-12 text-muted d-flex flex-wrap gap-2 align-items-center">
                        <span>Transaction</span> <TxLink hash={c.openTx} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {file && status !== "loading" && !found && (
            <div className="card" role="status">
              <div className="card-body p-4">
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="badge-soft tone-warning fs-13"><i className="ti ti-alert-triangle" /> No match</span>
                </div>
                <p className="fs-16 text-dark mb-2">No match: this exact file was never presented through Credoc.</p>
                <p className="text-muted mb-0">
                  A fingerprint changes completely if a single byte of the file changes: a re-saved PDF, a new scan or an edited date all give a different one. Ask the sender for the original file, the one the attestor signed.
                </p>
              </div>
            </div>
          )}

          {!file && (
            <div className="row g-3 text-center text-muted fs-13 mt-1">
              {[
                ["ti-fingerprint", "Fingerprinted here", "Your browser computes the file's keccak-256 fingerprint."],
                ["ti-search", "Compared on Arc", "Against every document presented and every contract locked through Credoc."],
                ["ti-shield-check", "Same file or not", "One changed byte and the fingerprint no longer matches."],
              ].map(([icon, title, body]) => (
                <div key={title} className="col-md-4">
                  <i className={`ti ${icon} fs-24 text-dark`} aria-hidden="true" />
                  <div className="fw-medium text-dark mt-1">{title}</div>
                  <div>{body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
