import { Link } from "react-router-dom";
import type { Address, Hex } from "viem";
import { docLabel } from "@credoc/sdk";
import { amount, sameAddress, shortHex } from "../../shared/format";
import type { Step } from "../lib/model";
import type { ChainEvent, CreditRow, OfferRow } from "../lib/store";
import { TxLink, When, tokenSymbol } from "./ui";

/** Shared plain-English rendering of credits and their events (Overview, Credits, CreditDetail, Activity). */

/** "BILL_OF_LADING" -> "Bill of lading"; an unknown label (raw hash) stays short. */
export function prettyDoc(label: string): string {
  if (label.startsWith("0x")) return `Document ${shortHex(label)}`;
  const s = label.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const docName = (docTypeHash: unknown) => prettyDoc(docLabel(docTypeHash as Hex));

/** "You" or a short address. */
export function who(address: unknown, me?: Address | null): string {
  const a = String(address ?? "");
  if (sameAddress(a, me)) return "You";
  return shortHex(a);
}

export const creditTitle = (c: CreditRow | undefined, id: unknown) => c?.ref || `credit #${String(id)}`;

export type EventCategory = "opened" | "documents" | "payments" | "financing" | "closures";

export type Described = { text: string; icon: string; category: EventCategory; actor?: string; creditId?: bigint };

// sub-cent amounts (a 0.25% fee on a small tranche) keep 4 decimals instead of reading 0.00
const money = (v: unknown, c?: CreditRow) =>
  `${amount(v as bigint, 6, (v as bigint) > 0n && (v as bigint) < 10_000n ? 4 : 2)} ${c ? tokenSymbol(c.token) : ""}`.trim();

/** One event in a sentence. `credits` resolves refs and tokens; `offers` resolves offer ids. Returns null for internal noise. */
export function describe(
  e: ChainEvent,
  byId: Map<string, CreditRow>,
  offers: OfferRow[],
  me?: Address | null,
): Described | null {
  const a = e.args;
  const offer = typeof a.offerId === "bigint" ? offers.find((o) => o.id === a.offerId) : undefined;
  const creditId = (a.creditId as bigint | undefined) ?? offer?.creditId;
  const c = creditId !== undefined ? byId.get(creditId.toString()) : undefined;
  const ref = creditTitle(c, creditId);
  const ship = typeof a.tranche === "number" ? `shipment ${a.tranche + 1}` : "";
  switch (e.name) {
    case "CreditOpened":
      return {
        text: `${who(a.applicant, me)} opened ${a.ref || ref} for ${money(a.total, c)} in favour of ${who(a.beneficiary, me)}`,
        icon: "ti-lock",
        category: "opened",
        actor: a.applicant as string,
        creditId,
      };
    case "DocumentPresented":
      return {
        text: `${who(a.attestor, me)} presented the ${docName(a.docType)} for ${ref}, ${ship}`,
        icon: "ti-file-check",
        category: "documents",
        actor: a.attestor as string,
        creditId,
      };
    case "DocumentWaived":
      return {
        text: `${c ? who(c.applicant, me) : "The importer"} accepted ${ref}, ${ship} without the ${docName(a.docType)}`,
        icon: "ti-file-like",
        category: "documents",
        actor: c?.applicant,
        creditId,
      };
    case "TrancheSettled":
      return {
        text: `${money((a.amount as bigint) - ((a.fee as bigint | undefined) ?? 0n), c)} paid to ${who(a.payee, me)} for ${ref}, ${ship}${a.fee ? ` (Credoc fee ${money(a.fee, c)})` : ""}`,
        icon: "ti-arrow-down-left",
        category: "payments",
        actor: a.payee as string,
        creditId,
      };
    case "TrancheRefunded":
      return {
        text: `${money(a.amount, c)} refunded to ${c ? who(c.applicant, me) : "the importer"} for ${ref}, ${ship}`,
        icon: "ti-arrow-back-up",
        category: "payments",
        actor: c?.applicant,
        creditId,
      };
    case "CreditClosed":
      return {
        text: a.fullyDelivered ? `${ref} closed: every shipment paid` : `${ref} closed without full delivery`,
        icon: a.fullyDelivered ? "ti-circle-check" : "ti-circle-x",
        category: "closures",
        creditId,
      };
    case "ExpiryProposed":
      return {
        text: `${who(a.proposer, me)} proposed moving the expiry of ${ref} to ${new Date(Number(a.newExpiry) * 1000).toUTCString().slice(5, 16)}`,
        icon: "ti-calendar-plus",
        category: "opened",
        actor: a.proposer as string,
        creditId,
      };
    case "ExpiryAmended":
      return {
        text: `Both sides agreed: ${ref} now expires ${new Date(Number(a.newExpiry) * 1000).toUTCString().slice(5, 16)}`,
        icon: "ti-calendar-check",
        category: "opened",
        creditId,
      };
    case "ExpiryProposalWithdrawn":
      return {
        text: `The expiry proposal on ${ref} was withdrawn`,
        icon: "ti-calendar-x",
        category: "opened",
        creditId,
      };
    case "OfferMade":
      return {
        text: `${who(a.financier, me)} offered ${money(a.price, c)} now for the proceeds of ${ref}`,
        icon: "ti-building-bank",
        category: "financing",
        actor: a.financier as string,
        creditId,
      };
    case "OfferWithdrawn":
      return {
        text: `${offer ? who(offer.financier, me) : "A financier"} withdrew an offer on ${ref}`,
        icon: "ti-arrow-back",
        category: "financing",
        actor: offer?.financier,
        creditId,
      };
    case "ProceedsAssigned":
      return {
        text: `${who(a.from, me)} sold the proceeds of ${ref} to ${who(a.to, me)} for ${money(a.price, c)}`,
        icon: "ti-transfer",
        category: "financing",
        actor: a.from as string,
        creditId,
      };
    case "PaymentDeferred":
      return {
        text: `A payment of ${amount(a.amount as bigint)} ${tokenSymbol(a.token as string)} to ${who(a.to, me)} is held for withdrawal`,
        icon: "ti-clock-pause",
        category: "payments",
        actor: a.to as string,
      };
    default:
      return null; // ReputationSkipped and future internals
  }
}

/** A compact feed line: icon, sentence, credit link, tx, time. */
export function EventLine({ e, d, now, showCredit = true }: { e: ChainEvent; d: Described; now: number; showCredit?: boolean }) {
  return (
    <li className="list-group-item px-0 d-flex gap-3 align-items-start">
      <span className="credit-ev-icon">
        <i className={`ti ${d.icon}`} aria-hidden="true" />
      </span>
      <div className="flex-grow-1 min-w-0">
        <div className="text-dark">{d.text}</div>
        <div className="fs-12 text-muted d-flex flex-wrap gap-2 align-items-center mt-1">
          <When ts={e.time} now={now} />
          <TxLink hash={e.tx} />
          {showCredit && d.creditId !== undefined && (
            <Link to={`/credits/${d.creditId}`} className="link-dark">
              Credit #{d.creditId.toString()}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

/** Horizontal lifecycle stepper. `reveal` limits how many steps show as done (Replay). */
export function Stepper({ steps, reveal, now }: { steps: Step[]; reveal?: number; now: number }) {
  return (
    <ol className="credit-stepper list-unstyled mb-0">
      {steps.map((s, i) => {
        const shown = reveal === undefined || i < reveal;
        const done = s.done && shown;
        const current = reveal === undefined ? s.current : i === reveal;
        return (
          <li key={s.key} className={`${done ? "done" : ""} ${current && !done ? "current" : ""}`}>
            <span className="dot">{done ? <i className="ti ti-check" /> : i + 1}</span>
            <div className="mt-2">
              <div className="fw-medium text-dark fs-13">{s.label}</div>
              <div className="fs-12 text-muted num">{done && s.time ? <When ts={s.time} now={now} /> : current ? "Now" : " "}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Styles shared by these pages, kept beside the components (dashboard.css is owned elsewhere). */
export function CreditStyles() {
  return (
    <style>{`
.credit-ev-icon { width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--credoc-paper); display: inline-flex; align-items: center; justify-content: center; color: var(--credoc-ink); font-size: 15px; }
.credit-stepper { display: flex; gap: 0; }
.credit-stepper li { flex: 1; position: relative; min-width: 0; padding-right: 8px; }
.credit-stepper li::before { content: ""; position: absolute; top: 13px; left: 30px; right: 4px; height: 1px; background: var(--osen-border-color); }
.credit-stepper li.done::before { background: var(--credoc-ink); }
.credit-stepper li:last-child::before { display: none; }
.credit-stepper .dot { position: relative; z-index: 1; width: 27px; height: 27px; border-radius: 50%; border: 1px dashed #a8a29e; background: var(--osen-secondary-bg); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: #78716c; transition: all .3s; }
.credit-stepper li.done .dot { background: var(--credoc-ink); border: 1px solid var(--credoc-ink); color: var(--osen-secondary-bg); }
.credit-stepper li.current .dot { border: 1px solid var(--credoc-ink); color: var(--credoc-ink); box-shadow: 0 0 0 4px rgba(25,25,25,.06); }
@media (max-width: 575.98px) {
  .credit-stepper { flex-direction: column; gap: 12px; }
  .credit-stepper li { display: flex; gap: 12px; align-items: center; }
  .credit-stepper li > div { margin-top: 0 !important; }
  .credit-stepper li::before { display: none; }
}
.credit-cell { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; font-size: 12px; white-space: nowrap; }
.credit-cell.waiting { border: 1px dashed #c8c4c0; color: #78716c; }
.credit-cell.presented { background: var(--credoc-ink); color: var(--osen-secondary-bg); }
.credit-cell.waived { background: var(--credoc-paper); color: var(--credoc-ink); border: 1px solid #e7e5e4; }
.credit-cell.na { color: #c8c4c0; }
.credit-timeline { list-style: none; padding: 0; margin: 0; position: relative; }
.credit-timeline li { position: relative; padding: 0 0 18px 40px; transition: opacity .35s; }
.credit-timeline li::before { content: ""; position: absolute; left: 13px; top: 28px; bottom: 0; width: 1px; background: var(--osen-border-color); }
.credit-timeline li:last-child::before { display: none; }
.credit-timeline .credit-ev-icon { position: absolute; left: 0; top: 0; }
.credit-timeline li.hidden-step { opacity: .15; }
.credit-gantt-row { display: grid; grid-template-columns: minmax(90px, 140px) 1fr; gap: 12px; align-items: center; padding: 6px 0; }
.credit-gantt-track { position: relative; height: 10px; background: var(--credoc-paper); border-radius: 5px; }
.credit-gantt-bar { position: absolute; top: 0; bottom: 0; background: var(--credoc-ink); border-radius: 5px; min-width: 4px; }
.credit-gantt-bar.late { background: #b7791f; }
.credit-gantt-today { position: absolute; top: -4px; bottom: -4px; width: 1px; background: #b7791f; }
.credit-progress { height: 3px; background: var(--credoc-paper); border-radius: 2px; overflow: hidden; width: 120px; }
.credit-progress > span { display: block; height: 100%; background: var(--credoc-ink); }
.kpi-figure { font-size: 1.9rem; line-height: 1.1; }
.hero-amount { font-size: clamp(2.2rem, 6vw, 3rem); line-height: 1; }
.min-w-0 { min-width: 0; }
.credit-actions > div:last-child { border-bottom: 0 !important; }
@media (prefers-reduced-motion: reduce) { .credit-stepper .dot, .credit-timeline li { transition: none; } }
`}</style>
  );
}
