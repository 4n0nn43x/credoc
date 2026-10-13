// Sun / moon switch, drawn in the hero's pencil style. Plain inline styles: it renders in both the Tailwind landing
// and the Bootstrap dashboard.
import type { CSSProperties } from "react";
import { toggleTheme, useTheme } from "./theme";

const DISC = "M16 10.3c3.2-.1 5.8 2.5 5.7 5.8-.1 3.1-2.7 5.6-5.8 5.6-3.2 0-5.7-2.6-5.6-5.8.1-3 2.6-5.5 5.7-5.6z";
// rays of slightly uneven length, as if drawn by hand
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
  const a = (deg * Math.PI) / 180;
  const r0 = 8.4 + (i % 3) * 0.3;
  const r1 = 11.6 + ((i * 5) % 3) * 0.5;
  const f = (n: number) => n.toFixed(2);
  return `M${f(16 + r0 * Math.cos(a))} ${f(16 + r0 * Math.sin(a))}L${f(16 + r1 * Math.cos(a + 0.03))} ${f(16 + r1 * Math.sin(a + 0.03))}`;
});
const MOON = "M14.66 7.04A9.5 9.5 0 1 0 24.55 19.4A8 8 0 0 1 14.66 7.04Z";

const still = typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const layer = (shown: boolean, turn: number): CSSProperties => ({
  transformOrigin: "16px 16px",
  transform: shown ? "rotate(0deg) scale(1)" : `rotate(${turn}deg) scale(0.6)`,
  opacity: shown ? 1 : 0,
  transition: still ? "none" : "transform 450ms cubic-bezier(.2,.8,.2,1), opacity 300ms ease",
});

export function ThemeToggle({ className, style, size = 28 }: { className?: string; style?: CSSProperties; size?: number }) {
  const dark = useTheme() === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={`${label} (D)`}
      className={`credoc-theme-toggle ${className ?? ""}`}
      style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "inherit", lineHeight: 0, ...style }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <g style={layer(!dark, -90)}>
          <path d={DISC} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <path d={DISC} strokeWidth={0.8} opacity={0.45} vectorEffect="non-scaling-stroke" transform="rotate(9 16 16) translate(.35 -.3)" />
          <path d="M13.4 18.6l4.9-4.9M14.6 19.7l4.6-4.6M12.7 16.9l3.6-3.6" strokeWidth={0.7} opacity={0.4} vectorEffect="non-scaling-stroke" />
          {RAYS.map((d) => (
            <path key={d} d={d} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <g style={layer(dark, 90)}>
          <path d={MOON} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <path d={MOON} strokeWidth={0.8} opacity={0.45} vectorEffect="non-scaling-stroke" transform="rotate(-7 16 16) translate(-.3 .3)" />
          <path d="M10.2 19.4l3.4-3.4M10.8 22l3.9-3.9M12.9 23.4l3-3" strokeWidth={0.7} opacity={0.4} vectorEffect="non-scaling-stroke" />
          <path d="M25.6 6.2v2.6M24.3 7.5h2.6M27.4 12.4v1.6M26.6 13.2h1.6" strokeWidth={1.1} vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
    </button>
  );
}
