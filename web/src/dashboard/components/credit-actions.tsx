import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { netProceeds } from "@credoc/sdk";
import { sameAddress } from "../../shared/format";
import { isAcceptable, rolesOf } from "../lib/model";
import type { CreditRow } from "../lib/store";
import { useStore } from "../lib/store";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";
import { Addr, Amount, When } from "./ui";
import { prettyDoc, who } from "./credit-kit";

const DAY = 86400;
const MAX_TENOR = 730 * DAY;

/** Latest expiry proposal still binding: the contract drops a proposal when its proposer sells the proceeds. */
export function pendingExpiry(c: CreditRow) {
  const last = c.events.filter((e) => e.name === "ExpiryProposed" || e.name === "ExpiryAmended").at(-1);
  if (last?.name !== "ExpiryProposed") return null;
  const proposer = last.args.proposer as string;
  const value = last.args.newExpiry as bigint;
  if (!(sameAddress(proposer, c.applicant) || sameAddress(proposer, c.payee)) || value <= c.expiry) return null;
  return { proposer, value, time: last.time };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-3 border-bottom border-dashed">
      <div className="fw-semibold text-dark mb-1">{title}</div>
      {children}
    </div>
  );
}

/** Two-step confirmation inline, with the explanation the action deserves. */
function Confirm({
  label,
  cls,
  explain,
  onConfirm,
  disabled,
}: {
  label: string;
  cls: string;
  explain: ReactNode;
  onConfirm: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" className={`btn btn-sm ${cls}`} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div className="border rounded p-3 bg-light bg-opacity-50 fs-13">
      <div className="mb-2">{explain}</div>
      <div className="d-flex gap-2">
        <button
          type="button"
          className={`btn btn-sm ${cls.includes("danger") ? "btn-danger" : "btn-dark"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
            setBusy(false);
            setOpen(false);
          }}
        >
          {busy && <i className="ti ti-loader-2 credoc-spin me-1" />}Confirm
        </button>
        <button type="button" className="btn btn-sm btn-light" onClick={() => setOpen(false)} disabled={busy}>
          Back
        </button>
      </div>
    </div>
  );
}

/** One card, one black button: what the connected wallet can do on this credit right now. */
export function ActionCard({ c, now }: { c: CreditRow; now: number }) {
  const { offers } = useStore();
  const { address: me } = useWallet();
  const { run } = useTx();
  const roles = rolesOf(c, me, offers);
  const active = c.status === 1;
  const expired = now > Number(c.expiry);
  const pending = active && !expired ? pendingExpiry(c) : null;
  const canAmend = roles.has("importer") || roles.has("payee");
  const proposalForMe = pending && canAmend && !sameAddress(pending.proposer, me);

  const missing = active && !expired
    ? c.tranches.flatMap((t, ti) =>
        t.settled ? [] : t.documents.filter((d) => d.required && !d.satisfied).map((d) => ({ ti, doc: d.doc, partial: t.satisfiedDocs !== 0 })),
      )
    : [];
  const openOffers = offers.filter((o) => isAcceptable(o, c, now));
  const myOffers = offers.filter((o) => o.creditId === c.id && o.open && sameAddress(o.financier, me));

  // the most urgent available action gets the single solid button
  const primary =
    active && expired
      ? "reclaim"
      : roles.has("payee") && active && openOffers.length
        ? "offers"
        : proposalForMe
          ? "extension"
          : roles.has("importer") && missing.some((m) => m.partial)
            ? "waive"
            : roles.has("exporter") && active && c.beneficiaryAgent === null
              ? "identity"
              : myOffers.some((o) => !isAcceptable(o, c, now))
                ? "withdraw"
                : null;
  const btn = (key: string) => (primary === key ? "btn-dark" : "btn-outline-dark");
  const id = c.id;
  const signHint = !me ? "Connect a wallet in the top bar." : undefined;

  const firstPartial = missing.find((m) => m.partial);
  const [waiveKey, setWaiveKey] = useState(firstPartial ? `${firstPartial.ti}-${firstPartial.doc}` : "");
  const [agentId, setAgentId] = useState("");
  const [date, setDate] = useState("");
  // one action in flight at a time: its button spins, the others wait
  const [busy, setBusy] = useState<string | null>(null);
  const act = (key: string, title: string, action: Parameters<typeof run>[1]) => {
    setBusy(key);
    void run(title, action).finally(() => setBusy(null));
  };
  const spin = (key: string) => busy === key && <i className="ti ti-loader-2 credoc-spin me-1" aria-hidden="true" />;

  const sections: ReactNode[] = [];

  if (active && expired)
    sections.push(
      <Section key="reclaim" title={roles.has("importer") ? "Reclaim the unshipped funds" : "Close this expired credit"}>
        <p className="fs-13 text-muted mb-2">
          The credit expired <When ts={c.expiry} now={now} />. Anyone can close an expired credit: the remaining{" "}
          <Amount value={c.outstanding} token={c.token} /> goes back to the importer, never to the caller.
        </p>
        <button type="button" className={`btn btn-sm ${btn("reclaim")}`} disabled={!me || busy !== null} title={signHint} onClick={() => act("reclaim", "Close and refund", (x) => x.reclaim(id))}>
          {spin("reclaim")}{me ? "Refund the importer" : "Connect to sign"}
        </button>
      </Section>,
    );

  if (roles.has("payee") && active && !expired)
    sections.push(
      <Section key="offers" title="Financing offers">
        {openOffers.length === 0 ? (
          <p className="fs-13 text-muted mb-0">
            No open offer. Financiers can bid on the <Link to="/market">receivables market</Link> to pay you now for the{" "}
            <Amount value={c.outstanding} token={c.token} /> still to come.
          </p>
        ) : (
          <ul className="list-unstyled mb-0">
            {openOffers.map((o) => {
              const discount = c.outstanding - o.price;
              const days = Math.max(1, (Number(c.expiry) - now) / DAY);
              // annualized against what you would collect yourself, net of the settlement fees (no plan discount assumed)
              const rate = (Number(netProceeds(c) - o.price) / Number(o.price)) * (365 / days);
              return (
                <li key={o.id.toString()} className="d-flex flex-wrap gap-2 align-items-center justify-content-between py-2">
                  <div className="fs-13">
                    <Addr address={o.financier} me={me} plain /> pays <Amount value={o.price} token={c.token} /> now
                    <div className="fs-12 text-muted num">
                      {((Number(discount) / Number(c.outstanding)) * 100).toFixed(2)}% discount, {(rate * 100).toFixed(1)}% annualized, valid{" "}
                      <When ts={o.validUntil} now={now} />
                    </div>
                  </div>
                  <Confirm
                    label="Accept"
                    cls={btn("offers")}
                    explain={
                      <>
                        You receive <Amount value={o.price} token={c.token} /> now. Every later shipment payment (
                        <Amount value={c.outstanding} token={c.token} />) goes to {who(o.financier)} instead of you. You still ship and
                        the attestors still present (UCP 600 art. 39, assignment of proceeds).
                      </>
                    }
                    onConfirm={() => run("Sell the proceeds", (x) => x.acceptOffer(o.id))}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2">
          <Confirm
            label="Cancel the credit"
            cls="btn-outline-danger"
            explain={
              <>
                This is irrevocable. As the payee you renounce the remaining <Amount value={c.outstanding} token={c.token} />: it
                is refunded to the importer now, and the credit closes. Shipments already paid are not affected.
              </>
            }
            onConfirm={() => run("Cancel the credit", (x) => x.cancel(id))}
          />
        </div>
      </Section>,
    );

  if (canAmend && active && !expired)
    sections.push(
      <Section key="extension" title="Expiry">
        {pending && (
          <p className="fs-13 mb-2">
            {who(pending.proposer, me)} proposed{" "}
            <span className="num fw-medium">{new Date(Number(pending.value) * 1000).toUTCString().slice(5, 22)} UTC</span>{" "}
            (<When ts={pending.time} now={now} />).{" "}
            {proposalForMe ? "It applies once you accept the same date." : "Waiting for the other side to accept."}
          </p>
        )}
        {proposalForMe && (
          <button type="button" className={`btn btn-sm ${btn("extension")} me-2 mb-2`} disabled={busy !== null} onClick={() => act("accept-expiry", "Accept the new expiry", (x) => x.amendExpiry(id, pending!.value))}>
            {spin("accept-expiry")}Accept new expiry
          </button>
        )}
        <div className="d-flex gap-2 align-items-center flex-wrap">
          <input
            type="date"
            className="form-control form-control-sm"
            style={{ maxWidth: 170 }}
            value={date}
            min={new Date((Number(c.expiry) + DAY) * 1000).toISOString().slice(0, 10)}
            max={new Date((now + MAX_TENOR) * 1000).toISOString().slice(0, 10)}
            onChange={(e) => setDate(e.target.value)}
            aria-label="New expiry date"
          />
          <button
            type="button"
            className="btn btn-sm btn-outline-dark"
            disabled={!date || busy !== null}
            onClick={() => {
              const ts = BigInt(Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000));
              act("propose", "Propose a new expiry", (x) => x.amendExpiry(id, ts));
            }}
          >
            {spin("propose")}Propose
          </button>
        </div>
        <div className="fs-12 text-muted mt-1">
          Extensions only, both sides must agree (UCP 600 art. 10). Currently expires <When ts={c.expiry} now={now} />.
        </div>
      </Section>,
    );

  if (roles.has("importer") && missing.length)
    sections.push(
      <Section key="waive" title="Accept a missing document">
        <div className="d-flex gap-2 flex-wrap mb-2">
          <select className="form-select form-select-sm" style={{ maxWidth: 320 }} value={waiveKey} onChange={(e) => setWaiveKey(e.target.value)} aria-label="Document to waive">
            <option value="">Choose a document…</option>
            {missing.map((m) => (
              <option key={`${m.ti}-${m.doc}`} value={`${m.ti}-${m.doc}`}>
                Shipment {m.ti + 1}: {prettyDoc(c.docs[m.doc]!.label)}
                {m.partial ? " (others are in)" : ""}
              </option>
            ))}
          </select>
        </div>
        {waiveKey && (
          <Confirm
            label="Waive this document"
            cls={btn("waive")}
            explain={(() => {
              const [ti, doc] = waiveKey.split("-").map(Number) as [number, number];
              const t = c.tranches[ti]!;
              const last = t.documents.filter((d) => d.required && !d.satisfied).length === 1;
              return (
                <>
                  Under UCP 600 article 16 the buyer may waive a discrepancy. You accept shipment {ti + 1} without the{" "}
                  {prettyDoc(c.docs[doc]!.label)}.{" "}
                  {last ? (
                    <>
                      It is the last missing document: <Amount value={t.amount} token={c.token} /> is paid to {who(c.payee, me)} at once,
                      irreversibly.
                    </>
                  ) : (
                    "Payment still waits for the other documents."
                  )}{" "}
                  The exporter's track record counts this shipment as waived, not delivered.
                </>
              );
            })()}
            onConfirm={() => {
              const [ti, doc] = waiveKey.split("-").map(Number) as [number, number];
              return run("Waive a document", (x) => x.waive(id, ti, doc)).then((ok) => ok && setWaiveKey(""));
            }}
          />
        )}
        {!waiveKey && <div className="fs-12 text-muted">Only if the goods arrived fine and the document is late or flawed.</div>}
      </Section>,
    );

  if (roles.has("exporter") && active && c.beneficiaryAgent === null)
    sections.push(
      <Section key="identity" title="Link your ERC-8004 identity">
        <p className="fs-13 text-muted mb-2">
          Once for your address: every credit where you are the exporter, this one included, then writes verifiable entries to your
          track record, which financiers use to price your receivables. No identity yet?{" "}
          <Link to="/identity">Create one on the Track record page</Link>.
        </p>
        <div className="d-flex gap-2">
          <input className="form-control form-control-sm num" style={{ maxWidth: 140 }} inputMode="numeric" placeholder="Agent id" value={agentId} onChange={(e) => setAgentId(e.target.value.replace(/\D/g, ""))} aria-label="ERC-8004 agent id" />
          <button type="button" className={`btn btn-sm ${btn("identity")}`} disabled={!agentId || busy !== null} onClick={() => act("link", "Link identity", (x) => x.linkAgent(BigInt(agentId)))}>
            {spin("link")}Link
          </button>
        </div>
      </Section>,
    );

  if (myOffers.length)
    sections.push(
      <Section key="withdraw" title="Your offers">
        {myOffers.map((o) => {
          const lapsed = !isAcceptable(o, c, now);
          return (
            <div key={o.id.toString()} className="d-flex justify-content-between align-items-center gap-2 py-1">
              <div className="fs-13">
                <Amount value={o.price} token={c.token} /> escrowed{" "}
                <span className="text-muted fs-12">{lapsed ? "(can no longer be accepted)" : <>valid <When ts={o.validUntil} now={now} /></>}</span>
              </div>
              <button type="button" className={`btn btn-sm ${lapsed ? btn("withdraw") : "btn-outline-dark"}`} disabled={busy !== null} onClick={() => act(`withdraw-${o.id}`, "Withdraw the offer", (x) => x.withdrawOffer(o.id))}>
                {spin(`withdraw-${o.id}`)}Withdraw
              </button>
            </div>
          );
        })}
      </Section>,
    );

  if (roles.has("attestor") && active && !expired)
    sections.push(
      <Section key="attest" title="Attest documents">
        <p className="fs-13 text-muted mb-2">You are a nominated attestor. Sign presentations for free: the relayer pays the gas.</p>
        <Link to="/attest" className="btn btn-sm btn-outline-dark">
          Open the attest queue
        </Link>
      </Section>,
    );

  if (!me)
    return (
      <div className="card">
        <div className="card-body">
          <div className="micro-label mb-2">Action required</div>
          <p className="fs-13 text-muted mb-2">You are viewing this credit read-only. Pick a wallet to see what you can do on it.</p>
          <button type="button" className="btn btn-sm btn-dark" disabled title="Connect a wallet in the top bar.">
            Connect to sign
          </button>
          <div className="fs-12 text-muted mt-1">Sign in with your wallet from the top bar.</div>
        </div>
      </div>
    );
  if (!sections.length) return null;
  sections.sort((a, b) => Number((b as { key?: string }).key === primary) - Number((a as { key?: string }).key === primary));
  return (
    <div className="card">
      <div className="card-body py-2">
        <div className="micro-label pt-2">{primary ? "Action required" : "What you can do"}</div>
        <div className="credit-actions">{sections}</div>
      </div>
    </div>
  );
}
