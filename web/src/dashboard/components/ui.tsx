import { useEffect, useRef, useState, type ReactNode } from "react";
import ApexCharts, { type ApexOptions } from "apexcharts";
import type { Address } from "viem";
import { ARC } from "@credoc/sdk";
import { explorerAddress, explorerTx } from "../../shared/config";
import { amountParts, sameAddress, shortHex, utc, relative } from "../../shared/format";
import type { StatusInfo } from "../lib/model";
import { useStore } from "../lib/store";
import { useTheme } from "../../shared/theme";

/** Osen page header, with the serif title shared with the landing page. */
export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-title-head d-flex align-items-sm-center flex-sm-row flex-column gap-2">
      <div className="flex-grow-1">
        <h4 className="mb-0">{title}</h4>
        {subtitle && <p className="text-muted mb-0 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="d-flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
  bodyClass = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || action) && (
        <div className="card-header d-flex justify-content-between align-items-center border-bottom border-dashed">
          <h4 className="header-title mb-0">{title}</h4>
          {action}
        </div>
      )}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </div>
  );
}

export const tokenSymbol = (token: string) =>
  sameAddress(token, ARC.usdc) ? "USDC" : sameAddress(token, ARC.eurc) ? "EURC" : "TOKEN";

/** "120,000.00 USDC": whole units prominent, cents and currency muted, tabular digits. */
export function Amount({ value, token, serif, className = "" }: { value: bigint; token?: string; serif?: boolean; className?: string }) {
  const { whole, cents } = amountParts(value);
  const ccy = token ? tokenSymbol(token) : null;
  return (
    <span className={`amount num ${serif ? "font-serif" : ""} ${className}`} title={ccy === "USDC" ? "USDC: digital dollar issued by Circle, redeemable 1:1" : ccy === "EURC" ? "EURC: digital euro issued by Circle, redeemable 1:1" : undefined}>
      {whole}
      <span className="cents">.{cents}</span>
      {ccy && <span className="ccy">{ccy}</span>}
    </span>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text: string) => {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    },
  };
}

/** Address as short hex (or "You"), with copy and explorer link. */
export function Addr({ address, me, plain }: { address: string; me?: Address | null; plain?: boolean }) {
  const { copied, copy } = useCopy();
  const you = sameAddress(address, me);
  if (plain) return <span>{you ? "You" : shortHex(address)}</span>;
  return (
    <span className="d-inline-flex align-items-center gap-1">
      <span className="fw-medium text-dark">{you ? "You" : shortHex(address)}</span>
      {you && <span className="hash text-muted">{shortHex(address)}</span>}
      <button type="button" className="btn btn-link p-0 text-muted" onClick={() => copy(address)} aria-label="Copy address" title={copied ? "Copied" : "Copy"}>
        <i className={`ti ${copied ? "ti-check" : "ti-copy"} fs-14`} />
      </button>
      <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="text-muted" aria-label="Open in explorer">
        <i className="ti ti-external-link fs-14" />
      </a>
    </span>
  );
}

export function TxLink({ hash }: { hash: string }) {
  const { copied, copy } = useCopy();
  const link = explorerTx(hash);
  return (
    <span className="hash d-inline-flex align-items-center gap-1">
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="link-dark">
          {shortHex(hash)}
        </a>
      ) : (
        <span className="text-muted">{shortHex(hash)}</span>
      )}
      <button type="button" className="btn btn-link p-0 text-muted" onClick={() => copy(hash)} aria-label="Copy transaction hash">
        <i className={`ti ${copied ? "ti-check" : "ti-copy"} fs-13`} />
      </button>
    </span>
  );
}

export function StatusBadge({ s }: { s: StatusInfo }) {
  return (
    <span className={`badge-soft tone-${s.tone}`}>
      <i className={`ti ${s.icon}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** Relative time with the exact UTC time on hover. Defaults to chain time, as the contract sees it. */
export function When({ ts, now }: { ts: number | bigint; now?: number }) {
  const store = useStore();
  return (
    <time dateTime={new Date(Number(ts) * 1000).toISOString()} title={utc(ts)} className="num">
      {relative(ts, now ?? store.now())}
    </time>
  );
}

/** Empty states say what is going on, teach the concept, and offer the next step. */
export function Empty({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <i className={`ti ${icon}`} aria-hidden="true" />
      <h5 className="mt-3 mb-1 text-dark">{title}</h5>
      {children && <p className="text-muted mx-auto mb-3" style={{ maxWidth: 420 }}>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="placeholder-glow" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="placeholder col-12 mb-2 rounded" style={{ opacity: 0.25 }} />
      ))}
    </div>
  );
}

/** Thin ApexCharts wrapper (ApexCharts 3 matches Osen's chart styles). Toolbar off, ink palette that follows the theme. */
export function Chart({ options, height = 260 }: { options: ApexOptions; height?: number }) {
  const dark = useTheme() === "dark";
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ApexCharts | null>(null);
  const json = JSON.stringify(options);
  useEffect(() => {
    if (!el.current) return;
    chart.current = new ApexCharts(el.current, {
      ...options,
      chart: {
        fontFamily: "Inter, sans-serif",
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: !window.matchMedia("(prefers-reduced-motion: reduce)").matches },
        foreColor: dark ? "#9a968f" : "#78716c",
        background: "transparent",
        ...options.chart,
        height,
      },
      theme: { mode: dark ? "dark" : "light" },
      tooltip: { theme: dark ? "dark" : "light", ...options.tooltip },
      grid: { borderColor: dark ? "#2e2d2b" : "#eceae8", strokeDashArray: 3, ...options.grid },
      colors: options.colors ?? (dark ? ["#ecebe8", "#9a968f", "#57534e"] : ["#191919", "#a8a29e", "#d6d3d1"]),
      dataLabels: { enabled: false, ...options.dataLabels },
      legend: { show: (options.series?.length ?? 0) > 1, ...options.legend },
    });
    void chart.current.render();
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
    // re-render when the serialized options change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, height, dark]);
  return <div ref={el} />;
}
