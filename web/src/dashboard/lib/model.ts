import type { Address } from "viem";
import { sameAddress } from "../../shared/format";
import type { ChainEvent, CreditRow, OfferRow } from "./store";

/** Pure view logic over indexed credits: roles, plain-language status, lifecycle steps, pending actions. */

export type Role = "importer" | "exporter" | "payee" | "attestor" | "financier";

export function rolesOf(c: CreditRow, me: Address | null | undefined, offers: OfferRow[] = []): Set<Role> {
  const r = new Set<Role>();
  if (!me) return r;
  if (sameAddress(c.applicant, me)) r.add("importer");
  if (sameAddress(c.beneficiary, me)) r.add("exporter");
  if (sameAddress(c.payee, me)) r.add("payee");
  if (c.docs.some((d) => sameAddress(d.attestor, me))) r.add("attestor");
  if (offers.some((o) => o.creditId === c.id && sameAddress(o.financier, me))) r.add("financier");
  return r;
}

export type Tone = "success" | "info" | "warning" | "secondary" | "dark";
export type StatusInfo = { label: string; tone: Tone; icon: string };

export const settledAmount = (c: CreditRow) => c.tranches.filter((t) => t.settled).reduce((s, t) => s + t.amount, 0n);
export const paidAmount = (c: CreditRow) =>
  c.events.filter((e) => e.name === "TrancheSettled").reduce((s, e) => s + (e.args.amount as bigint), 0n);
export const refundedAmount = (c: CreditRow) =>
  c.events.filter((e) => e.name === "TrancheRefunded").reduce((s, e) => s + (e.args.amount as bigint), 0n);
export const presentedCount = (c: CreditRow) =>
  c.tranches.reduce((n, t) => n + t.documents.filter((d) => d.required && d.satisfied).length, 0);
export const requiredCount = (c: CreditRow) =>
  c.tranches.reduce((n, t) => n + t.documents.filter((d) => d.required).length, 0);

export function closedAt(c: CreditRow): ChainEvent | undefined {
  return c.events.find((e) => e.name === "CreditClosed");
}

export function status(c: CreditRow, now: number): StatusInfo {
  if (c.status === 2) {
    const closed = closedAt(c);
    if (closed?.args.fullyDelivered) return { label: "Paid", tone: "success", icon: "ti-circle-check" };
    if (paidAmount(c) > 0n && refundedAmount(c) > 0n)
      return { label: "Partly paid, rest refunded", tone: "secondary", icon: "ti-circle-half-2" };
    // cancel and reclaim both close without delivery; a close before expiry can only be a cancellation
    return closed && closed.time <= Number(c.expiry)
      ? { label: "Cancelled", tone: "secondary", icon: "ti-circle-x" }
      : { label: "Expired, refunded", tone: "secondary", icon: "ti-clock-x" };
  }
  if (now > Number(c.expiry)) return { label: "Expired, refund due", tone: "warning", icon: "ti-clock-exclamation" };
  if (paidAmount(c) > 0n) return { label: "Partly paid", tone: "info", icon: "ti-progress" };
  if (presentedCount(c) > 0) return { label: "Documents in", tone: "info", icon: "ti-file-check" };
  return { label: "Awaiting shipment", tone: "dark", icon: "ti-ship" };
}

/** Lifecycle milestones for the stepper: what happened, and where the credit stands now. */
export type Step = { key: string; label: string; done: boolean; current: boolean; time?: number };

export function steps(c: CreditRow, now: number): Step[] {
  const first = (n: string) => c.events.find((e) => e.name === n)?.time;
  const lastSettle = [...c.events].reverse().find((e) => e.name === "TrancheSettled")?.time;
  const closed = closedAt(c);
  const anyDoc = first("DocumentPresented") ?? first("DocumentWaived");
  const failed = c.status === 2 && !closed?.args.fullyDelivered;
  const list: Omit<Step, "current">[] = [
    { key: "opened", label: "Funds locked", done: true, time: c.openedAt },
    { key: "docs", label: "Documents presented", done: anyDoc !== undefined, time: anyDoc },
    { key: "paid", label: "Exporter paid", done: lastSettle !== undefined, time: first("TrancheSettled") },
    failed
      ? { key: "closed", label: closed && closed.time <= Number(c.expiry) ? "Cancelled" : "Refunded", done: true, time: closed?.time }
      : { key: "closed", label: "Closed", done: c.status === 2, time: closed?.time },
  ];
  if (c.status === 1 && now > Number(c.expiry)) list.splice(3, 0, { key: "expired", label: "Expired", done: true, time: Number(c.expiry) });
  const cur = list.findIndex((s) => !s.done);
  return list.map((s, i) => ({ ...s, current: cur === -1 ? i === list.length - 1 : i === cur }));
}

/** Mirror of acceptOffer's checks: open, still valid, and priced on the credit's current outstanding and expiry. */
export function isAcceptable(o: OfferRow, c: Pick<CreditRow, "id" | "status" | "outstanding" | "expiry">, now: number): boolean {
  return (
    o.open &&
    o.creditId === c.id &&
    c.status === 1 &&
    now <= Number(o.validUntil) &&
    now <= Number(c.expiry) &&
    o.forOutstanding === c.outstanding &&
    o.expiry === c.expiry
  );
}

/** What the connected wallet can do right now, most urgent first. */
export type Action = { creditId: bigint; kind: string; label: string; urgency: number };

export function pendingActions(credits: CreditRow[], offers: OfferRow[], me: Address | null | undefined, now: number): Action[] {
  if (!me) return [];
  const out: Action[] = [];
  for (const c of credits) {
    if (c.status !== 1) continue;
    const roles = rolesOf(c, me, offers);
    const expired = now > Number(c.expiry);
    const pendingProposal = c.events.filter((e) => e.name === "ExpiryProposed" || e.name === "ExpiryAmended").at(-1);
    const proposalOpen =
      pendingProposal?.name === "ExpiryProposed" && !sameAddress(pendingProposal.args.proposer as string, me);
    if (roles.has("importer")) {
      if (expired) out.push({ creditId: c.id, kind: "reclaim", label: "Reclaim the unshipped funds", urgency: 3 });
      const partial = c.tranches.some((t) => !t.settled && t.satisfiedDocs !== 0 && t.satisfiedDocs !== t.requiredDocs);
      if (!expired && partial) out.push({ creditId: c.id, kind: "review", label: "Documents partly in: review or waive", urgency: 2 });
      if (proposalOpen) out.push({ creditId: c.id, kind: "extension", label: "Exporter asks for an extension", urgency: 2 });
    }
    if (roles.has("payee")) {
      const open = offers.filter((o) => isAcceptable(o, c, now));
      if (open.length) out.push({ creditId: c.id, kind: "offers", label: `${open.length} financing offer${open.length > 1 ? "s" : ""} to review`, urgency: 2 });
      if (proposalOpen) out.push({ creditId: c.id, kind: "extension", label: "Importer proposes a new expiry", urgency: 2 });
    }
    if (roles.has("exporter") && c.beneficiaryAgent === null)
      out.push({ creditId: c.id, kind: "identity", label: "Link your identity to build a track record", urgency: 1 });
    if (roles.has("attestor") && !expired) {
      const todo = c.tranches.reduce(
        (n, t) => n + t.documents.filter((d) => d.required && !d.satisfied && !t.settled && sameAddress(c.docs[d.doc]!.attestor, me)).length,
        0,
      );
      if (todo) out.push({ creditId: c.id, kind: "attest", label: `${todo} document${todo > 1 ? "s" : ""} to attest`, urgency: 3 });
    }
  }
  for (const o of offers) {
    const c = credits.find((x) => x.id === o.creditId);
    if (o.open && sameAddress(o.financier, me) && (c ? !isAcceptable(o, c, now) : Number(o.validUntil) < now))
      out.push({ creditId: o.creditId, kind: "withdraw", label: "Lapsed offer: withdraw your escrow", urgency: 1 });
  }
  return out.sort((a, b) => b.urgency - a.urgency);
}
