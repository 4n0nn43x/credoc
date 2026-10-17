import { useRef, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { type Reputation, hashDocument } from "@credoc/sdk";
import { shortHex } from "../../shared/format";
import { useWallet } from "../lib/wallet";

/** Small building blocks shared by the form pages (wizard, attest, verify, market, identity). */

/** "BILL_OF_LADING" -> "Bill of lading"; an unknown label (shown as its hash) stays short. */
export const prettyDoc = (label: string) =>
  label.startsWith("0x") ? `Document ${shortHex(label)}` : label.charAt(0) + label.slice(1).toLowerCase().replace(/_/g, " ");

/** How a party is shown: short hex. */
export const partyName = (a: string) => shortHex(a);

export type Hashed = { name: string; size: number; hash: Hex };

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Drag-and-drop zone that fingerprints a file locally (keccak256). The bytes never leave the browser. */
export function FileDrop({
  value,
  onChange,
  prompt = "Drop a file here, or click to choose",
  note = "Your file never leaves this device. Only its fingerprint is recorded on Arc.",
  big,
}: {
  value: Hashed | null;
  onChange: (h: Hashed | null) => void;
  prompt?: string;
  note?: ReactNode;
  big?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const take = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const hash = hashDocument(new Uint8Array(await f.arrayBuffer()));
      onChange({ name: f.name, size: f.size, hash });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label
        className={`credoc-filedrop position-relative d-block border border-dashed rounded-3 text-center mb-0 ${over ? "bg-light" : ""}`}
        style={{ cursor: "pointer", padding: big ? "2.75rem 1rem" : "1.5rem 1rem", borderWidth: 2, transition: "background .15s" }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files[0]);
        }}
      >
        <input ref={input} type="file" className="visually-hidden" onChange={(e) => void take(e.target.files?.[0])} />
        {value ? (
          <>
            <i className="ti ti-fingerprint fs-24 text-dark" aria-hidden="true" />
            <div className="fw-medium text-dark mt-1 text-break">{value.name}</div>
            <div className="fs-12 text-muted">{kb(value.size)} · fingerprint</div>
            <div className="hash text-dark mt-1 text-break px-2" title={value.hash}>
              {value.hash}
            </div>
            <div className="fs-12 text-muted mt-2">Click or drop to replace</div>
          </>
        ) : (
          <>
            <i className={`ti ${busy ? "ti-loader-2 credoc-spin" : "ti-file-upload"} ${big ? "fs-24" : "fs-20"} text-muted`} aria-hidden="true" />
            <div className="fw-medium text-dark mt-1">{busy ? "Fingerprinting…" : prompt}</div>
            <div className="fs-12 text-muted">Any format: PDF, image, scan</div>
          </>
        )}
      </label>
      {note && (
        <div className="form-text d-flex align-items-start gap-1">
          <i className="ti ti-lock mt-1" aria-hidden="true" />
          <span>{note}</span>
        </div>
      )}
      {value && (
        <button type="button" className="btn btn-link btn-sm p-0 text-muted" onClick={() => onChange(null)}>
          Remove file
        </button>
      )}
    </div>
  );
}

/** Primary action that needs a signer. Without a wallet the content stays readable and the button says so. */
export function SignButton({
  children,
  onClick,
  busy,
  disabled,
  className = "btn btn-dark",
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const w = useWallet();
  if (!w.address)
    return (
      <button
        type="button"
        className={className}
        disabled={!w.hasInjected}
        title={w.hasInjected ? undefined : "Choose a wallet in the top bar"}
        onClick={() => void w.connect()}
      >
        <i className="ti ti-wallet me-1" aria-hidden="true" /> Connect to sign
      </button>
    );
  return (
    <button type="button" className={className} onClick={onClick} disabled={busy || disabled}>
      {busy && <i className="ti ti-loader-2 credoc-spin me-1" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** "Network fee ~0.01 USDC · Final in under a second", or the gasless variant. */
export function FeeNote({ free }: { free?: boolean }) {
  return (
    <div className="fs-12 text-muted d-flex flex-wrap gap-3">
      <span>
        <i className="ti ti-gas-station me-1" aria-hidden="true" />
        {free ? "No fee for you: the relayer pays" : "Network fee ~0.01 USDC"}
      </span>
      <span>
        <i className="ti ti-bolt me-1" aria-hidden="true" />
        Final in under a second
      </span>
    </div>
  );
}

/** Credit days left, rounded down, never negative. */
export const daysLeft = (expiry: bigint, now: number) => Math.max(0, Math.floor((Number(expiry) - now) / 86400));

/** Track record as facts, never a score. */
export function recordFacts(r: Reputation | undefined, linked: boolean): string {
  if (!linked) return "No identity linked";
  if (!r) return "Loading…";
  const parts = [`${r.delivered} delivered`, `${r.expired} expired`];
  if (r.cancelled) parts.push(`${r.cancelled} cancelled`);
  if (r.assigneeCancelled) parts.push(`${r.assigneeCancelled} cancelled by a buyer of the proceeds`);
  if (r.waived) parts.push(`${r.waived} waived`);
  if (r.skipped) parts.push(`${r.skipped} unrecorded`);
  return r.delivered + r.expired + r.cancelled + r.assigneeCancelled + r.waived + r.skipped === 0 ? "No history" : parts.join(", ");
}

