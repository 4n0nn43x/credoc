import { useEffect, useRef } from "react";

/**
 * Hero background, drawn in pencil on a canvas: Credoc as a seamless cycle.
 *   left:  the exporter's desk. A signed and stamped document slides into an envelope that folds into a paper plane;
 *   above: the plane flies over the headline (documents travel up and over), its trail fading like a comet's;
 *   right: the importer's funds under a padlock. The plane lands, the lock opens, a seal reads "paid · final in 0.4 s",
 *   below:  and a coin rolls back under the call to action to the exporter's desk (money travels down and back).
 * Meanwhile the next document is drawn on the desk and a new padlock closes on the funds, so the last frame is the
 * first one: the loop has no seam. Desk, coins and clouds are drawn once, at first load.
 * Reduced motion shows one still frame. Hidden below the md breakpoint.
 */

type P = { x: number; y: number };
type Seg = [P, P];

const INK = "34, 32, 30";
const BLUE = "86, 98, 214";
const INTRO = 1.6; // first load only: desk, coins, clouds and the first document are sketched in
const CYCLE = 8.6; // seconds; state(0) === state(CYCLE)
const C = {
  envelope: [0, 0.6],
  slide: [0.6, 1.4],
  flap: [1.4, 1.8],
  fold: [1.8, 2.3],
  flight: [2.3, 4.5],
  trailTail: [2.9, 4.9],
  nextDoc: [2.7, 4.8],
  unlock: [4.5, 5.0],
  lockOut: [4.9, 5.3],
  seal: [4.9, 5.6],
  coin: [5.3, 6.9],
  coinTail: [5.8, 7.3],
  sealOut: [6.8, 7.4],
  relock: [7.2, 8.3],
} as const;
const APEX_SHRINK = 0.55;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const ph = (t: number, [a, b]: readonly number[], curve = true) => {
  const v = clamp((t - a!) / (b! - a!));
  return curve ? ease(v) : v;
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpP = (a: P, b: P, k: number): P => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) });

/** Deterministic noise in [-0.5, 0.5): the wobble of a line is stable from frame to frame. */
function noise(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296 - 0.5;
}

type Pen = { seed: number; jitter: number; width?: number; alpha?: number; passes?: number; dash?: number[] };

/** A hand-drawn polyline: subdivided, wobbled per pass, broken like graphite, drawn up to `progress`. */
function sketch(ctx: CanvasRenderingContext2D, pts: P[], pen: Pen, progress = 1, fade = 1) {
  if (progress <= 0 || fade <= 0 || pts.length < 2) return;
  const passes = pen.passes ?? 2;
  for (let p = 0; p < passes; p++) {
    const sub: P[] = [];
    const dx = noise(pen.seed, p * 7 + 1) * pen.jitter;
    const dy = noise(pen.seed, p * 7 + 2) * pen.jitter;
    let idx = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 7));
      for (let k = 0; k < n; k++, idx++) {
        const q = lerpP(a, b, k / n);
        sub.push({
          x: q.x + dx + noise(pen.seed * 31 + p, idx * 2) * pen.jitter * 0.7,
          y: q.y + dy + noise(pen.seed * 31 + p, idx * 2 + 1) * pen.jitter * 0.7,
        });
      }
    }
    const last = pts[pts.length - 1]!;
    sub.push({ x: last.x + dx, y: last.y + dy });
    let total = 0;
    for (let i = 1; i < sub.length; i++) total += Math.hypot(sub[i]!.x - sub[i - 1]!.x, sub[i]!.y - sub[i - 1]!.y);
    let limit = total * progress;
    ctx.beginPath();
    ctx.moveTo(sub[0]!.x, sub[0]!.y);
    for (let i = 1; i < sub.length; i++) {
      const seg = Math.hypot(sub[i]!.x - sub[i - 1]!.x, sub[i]!.y - sub[i - 1]!.y);
      if (seg <= limit) {
        ctx.lineTo(sub[i]!.x, sub[i]!.y);
        limit -= seg;
      } else {
        const q = lerpP(sub[i - 1]!, sub[i]!, limit / seg);
        ctx.lineTo(q.x, q.y);
        break;
      }
    }
    ctx.setLineDash(pen.dash ?? [9 + (noise(pen.seed, p) + 0.5) * 9, 0.9, 5, 1.1]);
    ctx.lineWidth = (pen.width ?? 1.5) * (p === 0 ? 1 : 0.7);
    ctx.strokeStyle = `rgba(${INK}, ${(pen.alpha ?? 0.8) * fade * (p === 0 ? 1 : 0.55)})`;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

const ellipse = (c: P, rx: number, ry: number, from = 0, to = Math.PI * 2, n = 36): P[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return { x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry };
  });

function wash(ctx: CanvasRenderingContext2D, c: P, r: number, a: number) {
  if (a <= 0) return;
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
  g.addColorStop(0, `rgba(${BLUE}, ${a})`);
  g.addColorStop(1, `rgba(${BLUE}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
}

function hatch(ctx: CanvasRenderingContext2D, from: P, to: P, count: number, dir: P, seed: number, progress: number, fade: number, alpha = 0.3) {
  for (let i = 0; i < count; i++) {
    const a = lerpP(from, to, i / Math.max(1, count - 1));
    sketch(ctx, [a, { x: a.x + dir.x, y: a.y + dir.y }], { seed: seed + i, jitter: 0.8, width: 0.9, alpha, passes: 1 }, clamp(progress * count - i), fade);
  }
}

function envelopeSegs(c: P, s: number): Seg[] {
  const w = s * 0.9;
  const h = s * 0.55;
  const TL = { x: c.x - w / 2, y: c.y - h / 2 };
  const TR = { x: c.x + w / 2, y: c.y - h / 2 };
  const BR = { x: c.x + w / 2, y: c.y + h / 2 };
  const BL = { x: c.x - w / 2, y: c.y + h / 2 };
  const A = { x: c.x, y: c.y + h * 0.08 };
  const Cc = { x: c.x, y: c.y + h * 0.18 };
  return [[TL, TR], [TR, BR], [BR, BL], [BL, TL], [TL, A], [A, TR], [BL, Cc], [Cc, BR]];
}

function planeSegs(c: P, s: number, angle: number): Seg[] {
  const k = s * 0.95;
  const rot = (x: number, y: number): P => ({
    x: c.x + (x * Math.cos(angle) - y * Math.sin(angle)) * k,
    y: c.y + (x * Math.sin(angle) + y * Math.cos(angle)) * k,
  });
  const N = rot(0.5, 0);
  const Tt = rot(-0.45, -0.24);
  const F = rot(-0.28, 0.02);
  const B = rot(-0.4, 0.2);
  const K1 = rot(-0.22, 0.1);
  const K2 = rot(0.18, 0.04);
  return [[Tt, N], [N, B], [B, F], [F, Tt], [F, N], [K1, K2], [K2, N]];
}

/** A smooth path through knots (Catmull-Rom), sampled and parameterized by distance. */
type Path = { pts: P[]; lens: number[]; total: number };

function spline(knots: P[]): Path {
  const pts: P[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const p0 = knots[Math.max(0, i - 1)]!;
    const p1 = knots[i]!;
    const p2 = knots[i + 1]!;
    const p3 = knots[Math.min(knots.length - 1, i + 2)]!;
    for (let k = 0; k < 24; k++) {
      const t = k / 24;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  pts.push(knots[knots.length - 1]!);
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  return { pts, lens, total: lens[lens.length - 1]! };
}

function along(path: Path, u: number): P {
  const d = clamp(u) * path.total;
  let i = 1;
  while (i < path.lens.length - 1 && path.lens[i]! < d) i++;
  const span = path.lens[i]! - path.lens[i - 1]! || 1;
  return lerpP(path.pts[i - 1]!, path.pts[i]!, (d - path.lens[i - 1]!) / span);
}

/** The part of a path between two fractions, as points: a comet's trail. */
function slice(path: Path, from: number, to: number): P[] {
  if (to <= from) return [];
  const n = Math.max(2, Math.round((to - from) * 80));
  return Array.from({ length: n + 1 }, (_, i) => along(path, from + ((to - from) * i) / n));
}

type Layout = {
  w: number;
  h: number;
  S: number; // the unit of the drawing (a document's height)
  L: P; // exporter's desk, left
  R: P; // importer's funds, right
  flight: Path;
  roll: Path;
  clouds: { c: P; r: number }[];
};

/** What the drawing must avoid, measured in the hero. */
type Band = {
  panelLeft: number;
  panelRight: number;
  panelTop: number;
  ctaBottom: number | null;
  title: { top: number; left: number; right: number } | null;
};

function layout(w: number, h: number, band: Band | null): Layout {
  let S = Math.min(h * 0.4, w * 0.16, 340);
  let lx = Math.max(w * 0.13, S * 0.62 + 28);
  if (band) {
    // keep both vignettes clear of the panel
    const room = Math.min(band.panelLeft, w - band.panelRight) - 32;
    S = Math.max(130, Math.min(S, room / 0.95));
    lx = Math.min(lx, band.panelLeft - S * 0.5 - 24);
  }
  const cy = h * 0.5;
  const L = { x: lx, y: cy };
  const R = { x: w - lx, y: cy };

  // documents go up and over: the flight peaks between the navigation and the headline, never across it
  const start = { x: L.x, y: L.y + S * 0.38 };
  const end = { x: R.x - S * 0.05, y: R.y + S * 0.12 };
  const tt = band?.title;
  const apex = tt ? Math.max(56, tt.top - 14 - S * 0.1) : Math.max(h * 0.1, 80);
  const left = tt ? tt.left - S * 0.3 : w * 0.3;
  const right = tt ? tt.right + S * 0.3 : w * 0.7;
  const flight = spline([start, { x: left, y: apex + S * 0.14 }, { x: w / 2, y: apex }, { x: right, y: apex + S * 0.14 }, end]);

  // money comes down and back: a coin rolls under the call to action, above the panel, to the exporter's desk
  const coinTop = { x: R.x + S * 0.08, y: R.y + S * 0.62 - 6 * S * 0.075 };
  const low = band ? (band.ctaBottom !== null ? (band.ctaBottom + band.panelTop) / 2 : band.panelTop - 22) : h * 0.62;
  const roll = spline([
    coinTop,
    { x: R.x - S * 0.55, y: low },
    { x: w / 2, y: low + 4 },
    { x: L.x + S * 0.6, y: low },
    { x: L.x + S * 0.3, y: L.y + S * 0.62 },
  ]);

  const clouds = [
    { c: { x: lerp(L.x, w * 0.5, 0.45), y: apex + S * 0.18 }, r: S * 0.15 },
    { c: { x: lerp(w * 0.5, R.x, 0.58), y: apex + S * 0.3 }, r: S * 0.13 },
  ];
  return { w, h, S, L, R, flight, roll, clouds };
}

/**
 * One frame. `t` is the time in the cycle (0..CYCLE), `intro` (0..1) sketches the permanent scenery on first load.
 * Every moving part is either at rest or invisible at t = 0 and t = CYCLE, which is what makes the loop seamless.
 */
function render(ctx: CanvasRenderingContext2D, Lt: Layout, t: number, intro: number) {
  const { S, L, R } = Lt;
  const j = Math.max(1.1, S / 140);
  ctx.clearRect(0, 0, Lt.w, Lt.h);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // ---------------- permanent scenery: the exporter's desk, the importer's coins, the clouds
  wash(ctx, { x: L.x, y: L.y + S * 0.1 }, S * 0.85, 0.14 * intro);
  wash(ctx, { x: R.x, y: R.y + S * 0.15 }, S * 0.85, 0.14 * intro);
  const back = (dx: number, dy: number, rot: number, seed: number) => {
    const w = S * 0.62;
    const h = S * 0.8;
    const c = { x: L.x + dx, y: L.y - S * 0.32 + dy };
    const r = (x: number, y: number): P => ({ x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot) });
    sketch(ctx, [r(-w / 2, -h / 2), r(w / 2, -h / 2), r(w / 2, h / 2), r(-w / 2, h / 2), r(-w / 2, -h / 2)], { seed, jitter: j, alpha: 0.32, width: 1.2 }, intro);
  };
  back(-S * 0.08, S * 0.04, -0.09, 11);
  back(S * 0.06, S * 0.02, 0.06, 12);
  const pa = { x: L.x - S * 0.55, y: L.y + S * 0.86 };
  const pb = { x: L.x + S * 0.45, y: L.y + S * 0.7 };
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const nrm = { x: ((pa.y - pb.y) / len) * S * 0.035, y: ((pb.x - pa.x) / len) * S * 0.035 };
  const tip = { x: pb.x + (pb.x - pa.x) * 0.14, y: pb.y + (pb.y - pa.y) * 0.14 };
  sketch(
    ctx,
    [{ x: pa.x + nrm.x, y: pa.y + nrm.y }, { x: pb.x + nrm.x, y: pb.y + nrm.y }, tip, { x: pb.x - nrm.x, y: pb.y - nrm.y }, { x: pa.x - nrm.x, y: pa.y - nrm.y }, { x: pa.x + nrm.x, y: pa.y + nrm.y }],
    { seed: 13, jitter: j * 0.6, alpha: 0.6, width: 1.3 },
    intro,
  );
  sketch(ctx, [{ x: pb.x + nrm.x, y: pb.y + nrm.y }, { x: pb.x - nrm.x, y: pb.y - nrm.y }], { seed: 14, jitter: 0.6, alpha: 0.5 }, intro);
  hatch(ctx, { x: pa.x + nrm.x * 0.8, y: pa.y + nrm.y * 0.8 }, { x: pb.x + nrm.x * 0.8, y: pb.y + nrm.y * 0.8 }, 14, { x: -nrm.x * 1.4, y: -nrm.y * 1.4 }, 15, intro, 1, 0.22);

  const coins = 6;
  const rx = S * 0.34;
  const ry = S * 0.1;
  const th = S * 0.075;
  const base = { x: R.x + S * 0.08, y: R.y + S * 0.62 };
  for (let i = 0; i < coins; i++) {
    const y = base.y - i * th;
    const pr = clamp(intro * coins * 1.2 - i);
    sketch(ctx, ellipse({ x: base.x, y }, rx, ry, 0, Math.PI, 18), { seed: 90 + i, jitter: j * 0.6, width: 1.3, alpha: 0.7 }, pr);
    sketch(ctx, [{ x: base.x - rx, y }, { x: base.x - rx, y: y - th }], { seed: 100 + i, jitter: 0.5, alpha: 0.6, passes: 1 }, pr);
    sketch(ctx, [{ x: base.x + rx, y }, { x: base.x + rx, y: y - th }], { seed: 110 + i, jitter: 0.5, alpha: 0.6, passes: 1 }, pr);
    hatch(ctx, { x: base.x - rx * 0.8, y: y + ry * 0.55 }, { x: base.x + rx * 0.8, y: y + ry * 0.55 }, 9, { x: 0, y: -th * 0.8 }, 120 + i * 10, pr, 1, 0.22);
  }
  const topY = base.y - coins * th;
  sketch(ctx, ellipse({ x: base.x, y: topY }, rx, ry), { seed: 130, jitter: j * 0.6, width: 1.5, alpha: 0.8 }, clamp(intro * 1.4 - 0.4));
  sketch(ctx, ellipse({ x: base.x, y: topY }, rx * 0.62, ry * 0.62), { seed: 131, jitter: 0.6, width: 1, alpha: 0.45, passes: 1 }, clamp(intro * 1.4 - 0.5));

  Lt.clouds.forEach((cl, i) => {
    const pts: P[] = [];
    const bumps = 5;
    for (let b = 0; b < bumps; b++) {
      const cx = cl.c.x - cl.r * 1.6 + (b / (bumps - 1)) * cl.r * 3.2;
      const r = cl.r * (b === 0 || b === bumps - 1 ? 0.55 : b === 2 ? 1 : 0.8);
      pts.push(...ellipse({ x: cx, y: cl.c.y }, r, r, Math.PI, Math.PI * 2, 10));
    }
    sketch(ctx, pts, { seed: 80 + i, jitter: 0.8, width: 1.1, alpha: 0.38, passes: 1 }, intro);
    sketch(ctx, [{ x: cl.c.x - cl.r * 2.15, y: cl.c.y }, { x: cl.c.x + cl.r * 2.15, y: cl.c.y }], { seed: 85 + i, jitter: 0.6, width: 1, alpha: 0.3, passes: 1 }, intro);
  });

  // ---------------- the document on the desk: the current one goes into the envelope, the next one is drawn
  const envC = { x: L.x, y: L.y + S * 0.38 };
  const envTop = envC.y - S * 0.275;
  const docInEnvelope = t < C.flap[1];
  const docDraw = docInEnvelope ? intro : ph(t, C.nextDoc, false);
  const slide = docInEnvelope ? ph(t, C.slide) : 0;
  if (docDraw > 0 && (docInEnvelope || t >= C.nextDoc[0])) {
    const dw = S * 0.62;
    const dh = S * 0.8;
    const x0 = L.x - dw / 2;
    const y0 = L.y - S * 0.72 + slide * S * 0.95;
    const at = (u: number, v: number): P => ({ x: x0 + u * dw, y: y0 + v * dh });
    ctx.save();
    if (docInEnvelope && t > C.envelope[0]) {
      ctx.beginPath(); // once the envelope is there, the sheet disappears into it
      ctx.rect(0, 0, Lt.w, envTop + 1);
      ctx.clip();
    }
    ctx.fillStyle = `rgba(255,255,255,${0.92 * clamp(docDraw * 3)})`;
    ctx.fillRect(x0, y0, dw, dh);
    const f = 0.3;
    sketch(ctx, [at(0, 0), at(1 - f, 0), at(1, f * 0.78), at(1, 1), at(0, 1), at(0, 0)], { seed: 21, jitter: j, width: 1.8, alpha: 0.85, passes: 3 }, clamp(docDraw / 0.45));
    sketch(ctx, [at(1 - f, 0), at(1 - f, f * 0.78), at(1, f * 0.78)], { seed: 22, jitter: j }, clamp((docDraw - 0.4) / 0.15));
    hatch(ctx, at(1 - f, f * 0.1), at(1 - f * 0.1, f * 0.78), 7, { x: -S * 0.05, y: S * 0.04 }, 23, clamp((docDraw - 0.45) / 0.15), 1, 0.3);
    [0.36, 0.47, 0.58, 0.69].forEach((v, i) =>
      sketch(ctx, [at(0.14, v), at(0.14 + [0.62, 0.74, 0.68, 0.4][i]!, v)], { seed: 30 + i, jitter: j, width: 1.4, alpha: 0.65 }, clamp((docDraw - 0.55 - i * 0.06) / 0.14)),
    );
    const sig = Array.from({ length: 25 }, (_, i) => at(0.14 + (i / 24) * 0.34, 0.86 + Math.sin((i / 24) * Math.PI * 3.2) * 0.035 - (i / 24) * 0.02));
    sketch(ctx, sig, { seed: 40, jitter: j * 0.5, width: 1.8, alpha: 0.85 }, clamp((docDraw - 0.8) / 0.12));
    sketch(ctx, ellipse(at(0.76, 0.85), S * 0.06, S * 0.06, -Math.PI / 2, Math.PI * 1.6), { seed: 41, jitter: j * 0.5, width: 1.5, alpha: 0.75, passes: 3 }, clamp((docDraw - 0.9) / 0.1));
    ctx.restore();
  }

  // ---------------- envelope, folding into a paper plane, flying over the headline
  const envDraw = ph(t, C.envelope, false);
  const fold = ph(t, C.fold);
  const flightU = ph(t, C.flight);
  const inFlight = t >= C.fold[1];
  if (envDraw > 0 && t < C.flight[1] + 0.05) {
    const takeoff = Math.atan2(along(Lt.flight, 0.01).y - envC.y, along(Lt.flight, 0.01).x - envC.x);
    const drawSegs = (segs: Seg[], fade: number, progress: (i: number) => number) =>
      segs.forEach(([a, b], i) =>
        sketch(ctx, [a, b], { seed: 50 + i, jitter: j * (inFlight ? 0.6 : 1), width: 1.7, alpha: 0.85, passes: 2 }, progress(i), fade),
      );
    if (!inFlight) {
      const env = envelopeSegs(envC, S);
      const openA = { x: envC.x, y: envTop - S * 0.32 };
      const A = lerpP(openA, env[4]![1], ph(t, C.flap));
      env[4] = [env[4]![0], A];
      env[5] = [A, env[5]![1]];
      const k = 1 - 0.35 * fold;
      const shrink = (p: P): P => ({ x: envC.x + (p.x - envC.x) * k, y: envC.y + (p.y - envC.y) * k });
      ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - fold)})`; // paper: the desk does not show through
      ctx.fillRect(envC.x - S * 0.45 * k, envC.y - S * 0.275 * k, S * 0.9 * k, S * 0.55 * k);
      drawSegs(env.map(([a, b]) => [shrink(a), shrink(b)] as Seg), 1 - fold, (i) => clamp(envDraw * 8 - i * 0.8));
      if (fold > 0) drawSegs(planeSegs(envC, S * 0.9, takeoff), fold, () => 1);
    } else {
      const pos = along(Lt.flight, flightU);
      const ahead = along(Lt.flight, Math.min(1, flightU + 0.01));
      const angle = Math.atan2(ahead.y - pos.y, ahead.x - pos.x);
      const scale = 0.9 * (1 - Math.sin(flightU * Math.PI) * APEX_SHRINK); // smaller far away, over the headline
      drawSegs(planeSegs(pos, S * scale, angle), 1 - ph(t, [C.flight[1] - 0.15, C.flight[1] + 0.05], false), () => 1);
    }
  }
  // comet trail: drawn behind the plane, erased from its tail, gone once the plane has landed
  if (inFlight) {
    const trail = slice(Lt.flight, ph(t, C.trailTail, false), flightU);
    sketch(ctx, trail, { seed: 70, jitter: 0.6, width: 1.3, alpha: 0.5, passes: 1, dash: [3, 9] }, 1);
  }

  // ---------------- the padlock: open when the documents land, a new one closes for the next credit
  const unlock = ph(t, C.unlock);
  const reclosing = t >= C.relock[0];
  const lockDraw = reclosing ? ph(t, C.relock, false) : intro;
  const lockFade = reclosing ? 1 : 1 - ph(t, C.lockOut, false);
  const lift = reclosing ? 0 : unlock * S * 0.1;
  const lc = { x: R.x - S * 0.2, y: R.y + S * 0.38 };
  const bw = S * 0.32;
  const bh = S * 0.26;
  if (lockFade > 0 && lockDraw > 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.95 * lockFade * clamp(lockDraw * 3)})`;
    ctx.fillRect(lc.x - bw / 2, lc.y - bh / 2, bw, bh);
    sketch(
      ctx,
      [{ x: lc.x - bw / 2, y: lc.y - bh / 2 }, { x: lc.x + bw / 2, y: lc.y - bh / 2 }, { x: lc.x + bw / 2, y: lc.y + bh / 2 }, { x: lc.x - bw / 2, y: lc.y + bh / 2 }, { x: lc.x - bw / 2, y: lc.y - bh / 2 }],
      { seed: 140, jitter: j * 0.7, width: 1.8, alpha: 0.85, passes: 3 },
      clamp(lockDraw * 1.5),
      lockFade,
    );
    const sx = lc.x + (reclosing ? 0 : unlock * S * 0.05);
    const shackle = ellipse({ x: sx, y: lc.y - bh / 2 - lift }, bw * 0.32, bh * 0.75, Math.PI, Math.PI * 2, 18);
    shackle.unshift({ x: sx - bw * 0.32, y: lc.y - bh / 2 });
    shackle.push({ x: sx + bw * 0.32, y: lc.y - bh / 2 - lift }); // the right leg comes out of the body as it lifts
    sketch(ctx, shackle, { seed: 141, jitter: j * 0.5, width: 2, alpha: 0.85, passes: 2 }, clamp(lockDraw * 1.5 - 0.2), lockFade);
    sketch(ctx, [{ x: lc.x, y: lc.y - bh * 0.05 }, { x: lc.x, y: lc.y + bh * 0.22 }], { seed: 142, jitter: 0.4, width: 2.2, alpha: 0.8, passes: 1 }, clamp(lockDraw * 1.5 - 0.3), lockFade);
    hatch(ctx, { x: lc.x - bw * 0.42, y: lc.y + bh * 0.42 }, { x: lc.x + bw * 0.42, y: lc.y + bh * 0.42 }, 10, { x: bw * 0.08, y: -bh * 0.3 }, 143, clamp(lockDraw * 1.5 - 0.3), lockFade, 0.25);
  }

  // ---------------- the seal: paid, final in under a second
  const seal = ph(t, C.seal, false);
  const sealFade = 1 - ph(t, C.sealOut, false);
  if (seal > 0 && sealFade > 0) {
    const sc = { x: R.x + S * 0.12, y: R.y - S * 0.42 };
    const sr = S * 0.15;
    wash(ctx, sc, sr * 2.6, 0.22 * seal * sealFade);
    sketch(ctx, ellipse(sc, sr, sr, -Math.PI / 2, Math.PI * 1.62), { seed: 150, jitter: 0.8, width: 1.8, alpha: 0.85, passes: 3 }, clamp(seal * 1.6), sealFade);
    hatch(ctx, { x: sc.x - sr * 0.6, y: sc.y + sr * 0.5 }, { x: sc.x + sr * 0.5, y: sc.y + sr * 0.6 }, 8, { x: sr * 0.25, y: -sr * 0.9 }, 151, clamp(seal * 1.4 - 0.3), sealFade, 0.2);
    sketch(ctx, [{ x: sc.x - sr * 0.45, y: sc.y }, { x: sc.x - sr * 0.1, y: sc.y + sr * 0.35 }, { x: sc.x + sr * 0.5, y: sc.y - sr * 0.38 }], { seed: 152, jitter: 0.6, width: 2.4, alpha: 0.9 }, clamp(seal * 2 - 0.9), sealFade);
    ctx.font = `${Math.max(11, Math.round(S / 20))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(${INK}, ${0.65 * clamp(seal * 2 - 1) * sealFade})`;
    ctx.fillText("paid · final in 0.4 s", sc.x, sc.y + sr * 1.75);
  }

  // ---------------- the coin rolls back to the exporter's desk
  const coinU = ph(t, C.coin);
  if (t >= C.coin[0] && t < C.coinTail[1]) {
    sketch(ctx, slice(Lt.roll, ph(t, C.coinTail, false), coinU), { seed: 160, jitter: 0.5, width: 1.2, alpha: 0.45, passes: 1, dash: [2, 8] }, 1);
  }
  if (t >= C.coin[0] && t < C.coin[1] + 0.3) {
    const pos = along(Lt.roll, coinU);
    const r = S * 0.065;
    const fade = clamp((t - C.coin[0]) / 0.15) * (1 - clamp((t - C.coin[1]) / 0.3));
    const spin = coinU * Math.PI * 9; // rolling: the hatches turn with the distance
    ctx.fillStyle = `rgba(255,255,255,${0.95 * fade})`;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    sketch(ctx, ellipse(pos, r, r), { seed: 161, jitter: 0.5, width: 1.6, alpha: 0.85, passes: 2 }, 1, fade);
    sketch(ctx, ellipse(pos, r * 0.62, r * 0.62), { seed: 162, jitter: 0.4, width: 1, alpha: 0.5, passes: 1 }, 1, fade);
    for (let k = 0; k < 3; k++) {
      const a = spin + (k * Math.PI) / 3;
      sketch(ctx, [{ x: pos.x + Math.cos(a) * r * 0.35, y: pos.y + Math.sin(a) * r * 0.35 }, { x: pos.x - Math.cos(a) * r * 0.35, y: pos.y - Math.sin(a) * r * 0.35 }], { seed: 163 + k, jitter: 0.3, width: 0.9, alpha: 0.45, passes: 1 }, 1, fade);
    }
    // a small burst where it lands
    const burst = ph(t, [C.coin[1] - 0.05, C.coin[1] + 0.35], false);
    if (burst > 0 && burst < 1) {
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k - 2) * 0.45;
        const d0 = r * (1.3 + burst);
        const d1 = r * (1.9 + burst * 1.4);
        sketch(ctx, [{ x: pos.x + Math.cos(a) * d0, y: pos.y + Math.sin(a) * d0 }, { x: pos.x + Math.cos(a) * d1, y: pos.y + Math.sin(a) * d1 }], { seed: 170 + k, jitter: 0.3, width: 1.2, alpha: 0.6, passes: 1 }, 1, 1 - burst);
      }
    }
  }

  ctx.restore();
}

export function HeroSketch() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // a fixed moment to show instead of the animation: reduced motion shows the plane over the headline
    let still: number | null = reduced ? 3.4 : null;
    let lay: Layout | null = null;
    let raf = 0;
    let running = false;
    let start = 0;
    let pausedAt = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const section = canvas.closest("section");
      const panel = section?.querySelector("[data-hero-panel]")?.getBoundingClientRect();
      const cta = section?.querySelector("[data-hero-cta]")?.getBoundingClientRect();
      // the headline's text box, not its full-width block
      const h1 = section?.querySelector("h1");
      let title: Band["title"] = null;
      if (h1) {
        const range = document.createRange();
        range.selectNodeContents(h1);
        const r = range.getBoundingClientRect();
        title = { top: r.top - rect.top, left: r.left - rect.left, right: r.right - rect.left };
      }
      lay = layout(
        rect.width,
        rect.height,
        panel
          ? {
              panelLeft: panel.left - rect.left,
              panelRight: panel.right - rect.left,
              panelTop: panel.top - rect.top,
              ctaBottom: cta ? cta.bottom - rect.top : null,
              title,
            }
          : null,
      );
      if (still !== null) render(ctx, lay, still, 1); // resizing clears the canvas: redraw the still frame
    };

    // the scenery is sketched in once; after that the cycle repeats with no seam
    const frame = (now: number) => {
      if (!running || !lay) return;
      const e = (now - start) / 1000;
      if (e < INTRO) render(ctx, lay, 0, ease(e / INTRO));
      else render(ctx, lay, (e - INTRO) % CYCLE, 1);
      raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (running || still !== null) return;
      running = true;
      start = performance.now() - pausedAt;
      raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (!running) return;
      running = false;
      pausedAt = performance.now() - start;
      cancelAnimationFrame(raf);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    if (import.meta.env.DEV) {
      // dev only: draw a given second of the cycle (?heroAt=3.4 or window.__heroAt(3.4)) to inspect frames
      const at = (t: number) => {
        pause();
        still = t;
        if (lay) render(ctx, lay, t, 1);
      };
      (window as unknown as { __heroAt?: (t: number) => void }).__heroAt = at;
      const q = new URLSearchParams(location.search).get("heroAt");
      if (q !== null) {
        at(Number(q));
        return () => ro.disconnect();
      }
    }
    let onScreen = true;
    const io = new IntersectionObserver(([e]) => {
      onScreen = !!e?.isIntersecting;
      if (onScreen && !document.hidden) play();
      else pause();
    });
    io.observe(canvas);
    const onVisibility = () => (document.hidden || !onScreen ? pause() : play());
    document.addEventListener("visibilitychange", onVisibility);
    play();

    return () => {
      pause();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    // phones: the free space under the call to action is too narrow for the story, the hero stays text only
    <div className="absolute inset-0 z-0 overflow-hidden hidden md:block" aria-hidden="true">
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}
