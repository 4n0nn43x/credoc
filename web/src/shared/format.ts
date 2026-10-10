import { formatUnits } from "viem";

/** "120,000.00" with exactly two decimals, grouping, tabular-friendly. Token units are 6 decimals. */
export function amount(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const [int, frac = ""] = formatUnits(abs, decimals).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}.${(frac + "00").slice(0, 2)}`;
}

/** Split for display: integer part prominent, cents and currency muted. */
export function amountParts(units: bigint): { whole: string; cents: string } {
  const [whole, cents] = amount(units).split(".");
  return { whole: whole!, cents: cents! };
}

export const shortHex = (h: string, head = 6, tail = 4) =>
  h.length <= head + tail + 2 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "in 23 days", "3 hours ago". Seconds-based (onchain timestamps). */
export function relative(ts: bigint | number, now = Math.floor(Date.now() / 1000)): string {
  const d = Number(ts) - now;
  for (const [unit, s] of UNITS) {
    if (Math.abs(d) >= s || unit === "second") return rtf.format(Math.round(d / s), unit);
  }
  return "";
}

export const utc = (ts: bigint | number) => new Date(Number(ts) * 1000).toUTCString().replace(" GMT", " UTC");

export const dateShort = (ts: bigint | number) =>
  new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
