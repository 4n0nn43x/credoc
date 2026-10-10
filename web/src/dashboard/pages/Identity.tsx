import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ARC, type Reputation } from "@credoc/sdk";
import { dateShort, sameAddress } from "../../shared/format";
import { Addr, Amount, Card, Empty, PageTitle, Skeleton } from "../components/ui";
import { FeeNote, SignButton, recordFacts } from "../components/form-kit";
import { reader } from "../lib/clients";
import { useStore } from "../lib/store";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";

type Record2 = { usdc: Reputation; eurc: Reputation };

const fetchRecord = async (id: bigint): Promise<Record2 | null> => {
  if (!reader) return null;
  const [usdc, eurc] = await Promise.all([reader.reputation(id, "USDC"), reader.reputation(id, "EURC")]);
  return { usdc, eurc };
};

function useRecord(id: bigint | null, version: number) {
  const [rec, setRec] = useState<Record2 | null | "error">(null);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    setRec(null);
    fetchRecord(id)
      .then((r) => live && setRec(r))
      .catch(() => live && setRec("error"));
    return () => {
      live = false;
    };
  }, [id, version]);
  return rec;
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-6 col-md-4">
      <div className="micro-label mb-1">{label}</div>
      <div className="font-serif fs-24 text-dark num">{children}</div>
    </div>
  );
}

/** The record, as a passport: counts written by the contract at settlement, nothing computed off chain. */
function Passport({ id, version, roles }: { id: bigint; version: number; roles?: string }) {
  const rec = useRecord(id, version);
  return (
    <div className="card mb-3" style={{ background: "var(--credoc-paper)" }}>
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-start mb-3">
          <div>
            <div className="micro-label">ERC-8004 identity</div>
            <div className="font-serif fs-24 text-dark num">#{String(id)}</div>
            {roles && <div className="fs-12 text-muted">{roles}</div>}
          </div>
          <i className="ti ti-id-badge-2 fs-24 text-muted" aria-hidden="true" />
        </div>
        {rec === null ? (
          <Skeleton lines={2} />
        ) : rec === "error" ? (
          <p className="text-muted mb-0">This identity has no record on this network.</p>
        ) : (
          <>
            <div className="row g-3">
              <Figure label="Delivered">{rec.usdc.delivered}</Figure>
              <Figure label="Waived">{rec.usdc.waived}</Figure>
              <Figure label="Expired">{rec.usdc.expired}</Figure>
              <Figure label="Cancelled">{rec.usdc.cancelled}</Figure>
              <Figure label="On time">{rec.usdc.onTimeRate === null ? "None yet" : `${Math.round(rec.usdc.onTimeRate * 100)}%`}</Figure>
              <div className="col-6 col-md-4">
                <div className="micro-label mb-1">Average shipment</div>
                <div className="d-grid">
                  {rec.usdc.averageTicket !== null && <Amount value={rec.usdc.averageTicket} token={ARC.usdc} serif className="fs-18 text-dark" />}
                  {rec.eurc.averageTicket !== null && <Amount value={rec.eurc.averageTicket} token={ARC.eurc} serif className="fs-18 text-dark" />}
                  {rec.usdc.averageTicket === null && rec.eurc.averageTicket === null && <span className="text-muted">None yet</span>}
                </div>
              </div>
            </div>
            <div className="fs-12 text-muted mt-3">
              {recordFacts(rec.usdc, true) === "No history" && (rec.usdc.averageTicket !== null || rec.eurc.averageTicket !== null)
                ? "As a buyer: shipments paid out through Credoc, at the average shown. Delivery counts are kept for exporters."
                : `In words: ${recordFacts(rec.usdc, true)}.`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function Identity() {
  const { address } = useWallet();
  const { credits, events } = useStore();
  const { run } = useTx();
  const [bump, setVersion] = useState(0);
  const version = bump + events.length; // re-read records whenever new events land
  const [created, setCreated] = useState<bigint[]>([]);
  const [uri, setUri] = useState("");
  const [lookup, setLookup] = useState("");
  const [looked, setLooked] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);

  const defaultUri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Credoc trader", role: "Trader" }))}`;
  useEffect(() => setUri(defaultUri), [defaultUri]);

  // my identities, as discovered from the credits where I am a party
  const roles = new Map<string, Set<string>>();
  const add = (id: bigint | null, role: string) => {
    if (id === null) return;
    const k = String(id);
    roles.set(k, (roles.get(k) ?? new Set()).add(role));
  };
  const mineCredits = address ? credits.filter((c) => sameAddress(c.applicant, address) || sameAddress(c.beneficiary, address)) : [];
  for (const c of mineCredits) {
    if (sameAddress(c.applicant, address)) add(c.applicantAgent, "buyer");
    if (sameAddress(c.beneficiary, address)) add(c.beneficiaryAgent, "seller");
  }
  for (const id of created) add(id, "new");
  const ids = [...roles.keys()].map(BigInt);

  // one dot per settled or refunded shipment, oldest first
  const dots = mineCredits
    .flatMap((c) => c.events.filter((e) => e.name === "TrancheSettled" || e.name === "TrancheRefunded").map((e) => ({ e, c })))
    .sort((a, b) => a.e.time - b.e.time || a.e.logIndex - b.e.logIndex);

  const unlinked = address ? credits.filter((c) => c.status === 1 && sameAddress(c.beneficiary, address) && c.beneficiaryAgent === null) : [];

  const register = async () => {
    setBusy(true);
    let id: bigint | null = null;
    const ok = await run("Register an identity", async (c) => {
      id = await c.registerAgent(uri.trim());
    });
    setBusy(false);
    if (ok && id !== null) setCreated((x) => [...x, id!]);
  };

  const doLookup = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d+$/.test(lookup.trim())) setLooked(BigInt(lookup.trim()));
  };

  return (
    <>
      <PageTitle title="Track record" subtitle="A public, verifiable history of deliveries, written by the Credoc contract at each settlement." />
      <div className="row">
        <div className="col-xl-7">
          {!address ? (
            <Card>
              <Empty icon="ti-id-badge-2" title="Choose your wallet to see your record">
                Exporters and importers link an ERC-8004 identity to their credits. Every shipment paid or refunded then adds a line to their public record.
              </Empty>
            </Card>
          ) : ids.length === 0 ? (
            <Card>
              <Empty icon="ti-id-badge-2" title="No identity linked yet">
                Register an identity below, then link it when you open a credit (importer) or on the credit page (exporter). Financiers read this record before buying your receivables.
              </Empty>
            </Card>
          ) : (
            ids.map((id) => (
              <Passport
                key={String(id)}
                id={id}
                version={version}
                roles={[...roles.get(String(id))!].map((r) => (r === "new" ? "Just registered" : `Linked as ${r}`)).join(" · ")}
              />
            ))
          )}

          {address && dots.length > 0 && (
            <Card title="My history" action={<span className="fs-12 text-muted">oldest to newest</span>}>
              <div className="d-flex flex-wrap gap-2 align-items-center" role="list">
                {dots.map(({ e, c }) => {
                  const paid = e.name === "TrancheSettled";
                  return (
                    <Link
                      key={`${e.tx}-${e.logIndex}`}
                      to={`/credits/${c.id}`}
                      role="listitem"
                      title={`${c.ref}, shipment ${Number(e.args.tranche) + 1}: ${paid ? "paid" : "refunded at expiry"}, ${dateShort(e.time)}`}
                      aria-label={`${c.ref}, shipment ${Number(e.args.tranche) + 1}, ${paid ? "paid" : "refunded"}`}
                      className="d-inline-block rounded-circle"
                      style={{ width: 14, height: 14, background: paid ? "#2f7d4f" : "transparent", border: paid ? "none" : "2px solid #b7791f" }}
                    />
                  );
                })}
              </div>
              <div className="fs-12 text-muted mt-3 d-flex gap-3">
                <span><span className="d-inline-block rounded-circle me-1" style={{ width: 8, height: 8, background: "#2f7d4f" }} />Paid</span>
                <span><span className="d-inline-block rounded-circle me-1" style={{ width: 8, height: 8, border: "2px solid #b7791f" }} />Refunded at expiry</span>
              </div>
            </Card>
          )}

          {unlinked.length > 0 && ids.length > 0 && (
            <Card title="Credits not counted yet">
              <p className="text-muted fs-13">Link your identity to these credits so their deliveries count. Once per credit.</p>
              <ul className="list-group">
                {unlinked.map((c) => (
                  <li key={String(c.id)} className="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2">
                    <Link to={`/credits/${c.id}`} className="text-dark fw-medium">{c.ref || `#${c.id}`}</Link>
                    <SignButton
                      className="btn btn-sm btn-outline-dark"
                      onClick={() => void run(`Link identity #${ids[0]} to ${c.ref}`, (x) => x.linkBeneficiaryAgent(c.id, ids[0]!)).then(() => setVersion((v) => v + 1))}
                    >
                      Link #{String(ids[0])}
                    </SignButton>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="col-xl-5">
          <Card title="Register an identity">
            <label className="form-label" htmlFor="id-uri">Public profile (agent URI)</label>
            <textarea id="id-uri" className="form-control font-monospace fs-12" rows={3} value={uri} onChange={(e) => setUri(e.target.value)} />
            <div className="form-text mb-3">A link to your company profile, or this small JSON stored as-is. Anyone can read it.</div>
            {created.length > 0 && (
              <div className="alert alert-success py-2 fs-13">
                Your new identity is <span className="font-serif fs-18 num">#{String(created.at(-1))}</span>. Use this number when you open or join a credit.
              </div>
            )}
            <div className="d-grid gap-2">
              <SignButton onClick={() => void register()} busy={busy} disabled={!uri.trim()} className="btn btn-outline-dark">
                <i className="ti ti-id-badge-2 me-1" /> Register
              </SignButton>
              <FeeNote />
            </div>
          </Card>

          <Card title="Look up an identity">
            <form onSubmit={doLookup} className="input-group mb-3">
              <span className="input-group-text">#</span>
              <input className="form-control num" inputMode="numeric" placeholder="Identity number" value={lookup} onChange={(e) => setLookup(e.target.value)} aria-label="Identity number" />
              <button className="btn btn-outline-dark" type="submit">Look up</button>
            </form>
            {looked !== null && <Passport id={looked} version={version} />}
          </Card>

          <Card title="How the record is kept">
            <ul className="list-unstyled fs-13 text-muted d-grid gap-2 mb-3">
              <li><i className="ti ti-pencil-check me-1" />Entries are written by the Credoc contract only during real settlements: paid, waived, refunded at expiry, cancelled. Nobody can type them in.</li>
              <li><i className="ti ti-filter me-1" />The registry is open, so we read only this contract's entries. Reviews written by anyone else are ignored.</li>
              <li><i className="ti ti-alert-triangle me-1" />The honest limit: two wallets of the same person can still trade with each other. Weigh a record by its volume and by who attested the documents.</li>
            </ul>
            <div className="fs-12 d-grid gap-1">
              <div><span className="text-muted">Identity registry </span><Addr address={ARC.identityRegistry} /></div>
              <div><span className="text-muted">Reputation registry </span><Addr address={ARC.reputationRegistry} /></div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
