import { useEffect, useRef } from "react";

/**
 * Hero background, drawn in pencil on a canvas: Credoc's promise as a small story.
 *   left:  a shipping document is sketched, signed and stamped, slides into an envelope that folds into a
 *          paper plane (a stack of papers and a pencil stay on the desk, so the side never goes empty);
 *   sky:   the plane flies over the headline, leaving a dotted trail between scribbled clouds;
 *   right: the importer's funds wait under a padlock; when the plane lands the lock opens and a seal reads
 *          "paid, final in 0.4 s". Then a pause, a soft fade, and the story starts again.
 * Reduced motion shows one still frame with the plane in flight. Hidden below the md breakpoint.
 */

type P = { x: number; y: number };
type Seg = [P, P];

const INK = "34, 32, 30";
const BLUE = "86, 98, 214";
const T = {
  doc: [0, 2.0],
  right: [0.3, 2.2],
  clouds: [0.8, 2.6],
  envelope: [2.1, 2.8],
  slide: [2.8, 3.6],
  flap: [3.6, 4.0],
  fold: [4.1, 4.6],
  flight: [4.6, 7.0],
  unlock: [7.0, 7.5],
  seal: [7.5, 8.3],
  fadeOut: [9.9, 10.6],
} as const;
const LOOP = 10.8;
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

/** Envelope segments (flap closed) and paper-plane segments, index for index: folding is interpolation. */
function envelopeSegs(c: P, s: number): Seg[] {
  const w = s * 0.9;
  const h = s * 0.55;
  const TL = { x: c.x - w / 2, y: c.y - h / 2 };
  const TR = { x: c.x + w / 2, y: c.y - h / 2 };
  const BR = { x: c.x + w / 2, y: c.y + h / 2 };
  const BL = { x: c.x - w / 2, y: c.y + h / 2 };
  const A = { x: c.x, y: c.y + h * 0.08 };
  const C = { x: c.x, y: c.y + h * 0.18 };
  return [[TL, TR], [TR, BR], [BR, BL], [BL, TL], [TL, A], [A, TR], [BL, C], [C, BR]];
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
  return [[Tt, N], [N, B], [B, F], [F, Tt], [F, N], [F, N], [K1, K2], [K2, N]];
}

type Layout = {
  w: number;
  h: number;
  S: number; // the unit of the drawing (a document's height)
  L: P; // left vignette center
  R: P; // right vignette center
  strength: number;
  path: Path;
  clouds: { c: P; r: number }[];
};

type Band = { panelLeft: number; panelRight: number; title: { top: number; left: number; right: number } | null };

/** A smooth flight path through knots (Catmull-Rom), sampled and parameterized by distance. */
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

function layout(w: number, h: number, band: Band | null): Layout {
  const mobile = w < 768;
  let S = mobile ? Math.min(w * 0.3, 120) : Math.min(h * 0.4, w * 0.16, 340);
  let lx = mobile ? w * 0.2 : Math.max(w * 0.13, S * 0.62 + 28);
  if (!mobile && band) {
    // keep both vignettes clear of the panel
    const room = Math.min(band.panelLeft, w - band.panelRight) - 32;
    S = Math.max(130, Math.min(S, room / 0.95));
    lx = Math.min(lx, band.panelLeft - S * 0.5 - 24);
  }
  const cy = mobile ? h * 0.62 : h * 0.5;
  const L = { x: lx, y: cy };
  const R = { x: w - lx, y: cy };
  const start = { x: L.x, y: L.y + S * 0.38 };
  const end = { x: R.x - S * 0.05, y: R.y + S * 0.12 };
  // the flight climbs beside the headline, stays above it across its whole width, then comes down past it
  // (shrunk over the headline, the plane extends about 0.1 S around its path)
  const tt = band?.title;
  const apex = tt ? Math.max(56, tt.top - 14 - S * 0.1) : mobile ? h * 0.42 : Math.max(h * 0.1, 80);
  const left = tt ? tt.left - S * 0.3 : w * 0.3;
  const right = tt ? tt.right + S * 0.3 : w * 0.7;
  const top = apex;
  const path = spline([start, { x: left, y: apex + S * 0.14 }, { x: w / 2, y: apex }, { x: right, y: apex + S * 0.14 }, end]);
  const clouds = mobile
    ? []
    : [
        { c: { x: lerp(L.x, w * 0.5, 0.45), y: top + S * 0.18 }, r: S * 0.15, dy: 0 },
        { c: { x: lerp(w * 0.5, R.x, 0.58), y: top + S * 0.3 }, r: S * 0.13, dy: 0 },
      ].map((cl) => ({ c: { x: cl.c.x, y: cl.c.y + cl.dy }, r: cl.r }));
  return { w, h, S, L, R, strength: mobile ? 0.55 : 1, path, clouds };
}

function render(ctx: CanvasRenderingContext2D, Lt: Layout, t: number) {
  const { S, L, R } = Lt;
  const j = Math.max(1.1, S / 140);
  ctx.clearRect(0, 0, Lt.w, Lt.h);
  ctx.save();
  ctx.globalAlpha = Lt.strength * (1 - ph(t, T.fadeOut));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // ---------------- left desk: papers and a pencil that always stay
  wash(ctx, { x: L.x, y: L.y + S * 0.1 }, S * 0.85, 0.14);
  const desk = ph(t, [0, 1.2]);
  const back = (dx: number, dy: number, rot: number, seed: number) => {
    const w = S * 0.62;
    const h = S * 0.8;
    const c = { x: L.x + dx, y: L.y - S * 0.32 + dy };
    const r = (x: number, y: number): P => ({ x: c.x + x * Math.cos(rot) - y * Math.sin(rot), y: c.y + x * Math.sin(rot) + y * Math.cos(rot) });
    sketch(ctx, [r(-w / 2, -h / 2), r(w / 2, -h / 2), r(w / 2, h / 2), r(-w / 2, h / 2), r(-w / 2, -h / 2)], { seed, jitter: j, alpha: 0.32, width: 1.2 }, desk);
  };
  back(-S * 0.08, S * 0.04, -0.09, 11);
  back(S * 0.06, S * 0.02, 0.06, 12);
  // the pencil, lying across the bottom of the desk
  const pa = { x: L.x - S * 0.55, y: L.y + S * 0.86 };
  const pb = { x: L.x + S * 0.45, y: L.y + S * 0.7 };
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const nrm = { x: ((pa.y - pb.y) / len) * S * 0.035, y: ((pb.x - pa.x) / len) * S * 0.035 };
  const tip = { x: pb.x + (pb.x - pa.x) * 0.14, y: pb.y + (pb.y - pa.y) * 0.14 };
  sketch(
    ctx,
    [{ x: pa.x + nrm.x, y: pa.y + nrm.y }, { x: pb.x + nrm.x, y: pb.y + nrm.y }, tip, { x: pb.x - nrm.x, y: pb.y - nrm.y }, { x: pa.x - nrm.x, y: pa.y - nrm.y }, { x: pa.x + nrm.x, y: pa.y + nrm.y }],
    { seed: 13, jitter: j * 0.6, alpha: 0.6, width: 1.3 },
    desk,
  );
  sketch(ctx, [{ x: pb.x + nrm.x, y: pb.y + nrm.y }, { x: pb.x - nrm.x, y: pb.y - nrm.y }], { seed: 14, jitter: 0.6, alpha: 0.5 }, desk);
  hatch(ctx, { x: pa.x + nrm.x * 0.8, y: pa.y + nrm.y * 0.8 }, { x: pb.x + nrm.x * 0.8, y: pb.y + nrm.y * 0.8 }, 14, { x: -nrm.x * 1.4, y: -nrm.y * 1.4 }, 15, desk, 1, 0.22);

  // ---------------- the document: drawn, signed, stamped, then slides into the envelope
  const envC = { x: L.x, y: L.y + S * 0.38 };
  const envTop = envC.y - S * 0.275;
  const slide = ph(t, T.slide);
  const docDraw = ph(t, T.doc, false);
  if (t < T.flap[1]) {
    const dw = S * 0.62;
    const dh = S * 0.8;
    const x0 = L.x - dw / 2;
    const y0 = L.y - S * 0.72 + slide * S * 0.95;
    const at = (u: number, v: number): P => ({ x: x0 + u * dw, y: y0 + v * dh });
    ctx.save();
    if (t > T.envelope[0]) {
      // once the envelope is there, the sheet disappears into it
      ctx.beginPath();
      ctx.rect(0, 0, Lt.w, envTop + 1);
      ctx.clip();
    }
    ctx.fillStyle = "rgba(255,255,255,0.92)";
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

  // ---------------- envelope (flap open, then closed), folding into a paper plane that takes off
  const envDraw = ph(t, T.envelope, false);
  const fold = ph(t, T.fold);
  const flightU = ph(t, T.flight);
  const inFlight = t >= T.fold[1];
  if (envDraw > 0 && t < T.flight[1] + 0.05) {
    const flap = ph(t, T.flap);
    const openA = { x: envC.x, y: envTop - S * 0.32 };
    const arriveFade = 1 - ph(t, [T.flight[1] - 0.15, T.flight[1] + 0.05], false);
    const takeoff = Math.atan2(along(Lt.path, 0.01).y - envC.y, along(Lt.path, 0.01).x - envC.x);
    const drawSegs = (segs: Seg[], fade: number, progress: (i: number) => number) =>
      segs.forEach(([a, b], i) =>
        sketch(ctx, [a, b], { seed: 50 + i, jitter: j * (inFlight ? 0.6 : 1), width: 1.7, alpha: 0.85, passes: 2 }, progress(i), fade),
      );
    if (!inFlight) {
      // the envelope, flap opening then closing; it shrinks and fades as the plane takes its place
      const env = envelopeSegs(envC, S);
      const A = lerpP(openA, env[4]![1], flap);
      env[4] = [env[4]![0], A];
      env[5] = [A, env[5]![1]];
      const k = 1 - 0.35 * fold;
      const shrink = (p: P): P => ({ x: envC.x + (p.x - envC.x) * k, y: envC.y + (p.y - envC.y) * k });
      ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - fold)})`; // paper: the desk sketch does not show through
      ctx.fillRect(envC.x - S * 0.45 * k, envC.y - S * 0.275 * k, S * 0.9 * k, S * 0.55 * k);
      drawSegs(env.map(([a, b]) => [shrink(a), shrink(b)] as Seg), 1 - fold, (i) => clamp(envDraw * 8 - i * 0.8));
      if (fold > 0) drawSegs(planeSegs(envC, S * 0.9, takeoff), fold, () => 1);
    } else {
      const pos = along(Lt.path, flightU);
      const ahead = along(Lt.path, Math.min(1, flightU + 0.01));
      const angle = Math.atan2(ahead.y - pos.y, ahead.x - pos.x);
      const scale = 0.9 * (1 - Math.sin(flightU * Math.PI) * APEX_SHRINK); // smaller far away, over the headline
      drawSegs(planeSegs(pos, S * scale, angle), arriveFade, () => 1);
    }
  }

  // ---------------- the trail and the clouds
  if (inFlight) {
    const pts: P[] = [];
    for (let i = 0; i <= 80; i++) pts.push(along(Lt.path, (i / 80) * flightU));
    sketch(ctx, pts, { seed: 70, jitter: 0.6, width: 1.3, alpha: 0.5, passes: 1, dash: [3, 9] }, 1);
  }
  Lt.clouds.forEach((cl, i) => {
    const pts: P[] = [];
    const bumps = 5;
    for (let b = 0; b < bumps; b++) {
      const cx = cl.c.x - cl.r * 1.6 + (b / (bumps - 1)) * cl.r * 3.2;
      const r = cl.r * (b === 0 || b === bumps - 1 ? 0.55 : b === 2 ? 1 : 0.8);
      pts.push(...ellipse({ x: cx, y: cl.c.y }, r, r, Math.PI, Math.PI * 2, 10));
    }
    sketch(ctx, pts, { seed: 80 + i, jitter: 0.8, width: 1.1, alpha: 0.38, passes: 1 }, ph(t, T.clouds, false));
    sketch(ctx, [{ x: cl.c.x - cl.r * 2.15, y: cl.c.y }, { x: cl.c.x + cl.r * 2.15, y: cl.c.y }], { seed: 85 + i, jitter: 0.6, width: 1, alpha: 0.3, passes: 1 }, ph(t, T.clouds, false));
  });

  // ---------------- right: the importer's funds under a padlock, unlocked when the documents land
  wash(ctx, { x: R.x, y: R.y + S * 0.15 }, S * 0.85, 0.14);
  const right = ph(t, T.right, false);
  const unlock = ph(t, T.unlock);
  const coins = 6;
  const rx = S * 0.34;
  const ry = S * 0.1;
  const th = S * 0.075;
  const base = { x: R.x + S * 0.08, y: R.y + S * 0.62 };
  for (let i = 0; i < coins; i++) {
    const y = base.y - i * th;
    const pr = clamp(right * coins * 1.2 - i);
    sketch(ctx, ellipse({ x: base.x, y }, rx, ry, 0, Math.PI, 18), { seed: 90 + i, jitter: j * 0.6, width: 1.3, alpha: 0.7 }, pr);
    sketch(ctx, [{ x: base.x - rx, y }, { x: base.x - rx, y: y - th }], { seed: 100 + i, jitter: 0.5, alpha: 0.6, passes: 1 }, pr);
    sketch(ctx, [{ x: base.x + rx, y }, { x: base.x + rx, y: y - th }], { seed: 110 + i, jitter: 0.5, alpha: 0.6, passes: 1 }, pr);
    hatch(ctx, { x: base.x - rx * 0.8, y: y + ry * 0.55 }, { x: base.x + rx * 0.8, y: y + ry * 0.55 }, 9, { x: 0, y: -th * 0.8 }, 120 + i * 10, pr, 1, 0.22);
  }
  const topY = base.y - coins * th;
  sketch(ctx, ellipse({ x: base.x, y: topY }, rx, ry), { seed: 130, jitter: j * 0.6, width: 1.5, alpha: 0.8 }, clamp(right * 1.4 - 0.4));
  sketch(ctx, ellipse({ x: base.x, y: topY }, rx * 0.62, ry * 0.62), { seed: 131, jitter: 0.6, width: 1, alpha: 0.45, passes: 1 }, clamp(right * 1.4 - 0.5));

  // padlock in front of the stack
  const lockFade = 1 - ph(t, [T.unlock[1] - 0.1, T.unlock[1] + 0.5], false);
  const lc = { x: R.x - S * 0.2, y: R.y + S * 0.38 };
  const bw = S * 0.32;
  const bh = S * 0.26;
  const lockDraw = clamp(right * 1.5 - 0.3);
  if (lockFade > 0 && lockDraw > 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.95 * lockFade})`;
    ctx.fillRect(lc.x - bw / 2, lc.y - bh / 2, bw, bh);
  }
  sketch(
    ctx,
    [{ x: lc.x - bw / 2, y: lc.y - bh / 2 }, { x: lc.x + bw / 2, y: lc.y - bh / 2 }, { x: lc.x + bw / 2, y: lc.y + bh / 2 }, { x: lc.x - bw / 2, y: lc.y + bh / 2 }, { x: lc.x - bw / 2, y: lc.y - bh / 2 }],
    { seed: 140, jitter: j * 0.7, width: 1.8, alpha: 0.85, passes: 3 },
    lockDraw,
    lockFade,
  );
  const lift = unlock * S * 0.1;
  const sx = lc.x + unlock * S * 0.05;
  const shackle = ellipse({ x: sx, y: lc.y - bh / 2 - lift }, bw * 0.32, bh * 0.75, Math.PI, Math.PI * 2, 18);
  shackle.unshift({ x: sx - bw * 0.32, y: lc.y - bh / 2 });
  shackle.push({ x: sx + bw * 0.32, y: lc.y - bh / 2 - lift }); // the right leg comes out of the body as it lifts
  sketch(ctx, shackle, { seed: 141, jitter: j * 0.5, width: 2, alpha: 0.85, passes: 2 }, clamp(right * 1.5 - 0.5), lockFade);
  sketch(ctx, [{ x: lc.x, y: lc.y - bh * 0.05 }, { x: lc.x, y: lc.y + bh * 0.22 }], { seed: 142, jitter: 0.4, width: 2.2, alpha: 0.8, passes: 1 }, clamp(right * 1.5 - 0.6), lockFade);
  hatch(ctx, { x: lc.x - bw * 0.42, y: lc.y + bh * 0.42 }, { x: lc.x + bw * 0.42, y: lc.y + bh * 0.42 }, 10, { x: bw * 0.08, y: -bh * 0.3 }, 143, clamp(right * 1.5 - 0.6), lockFade, 0.25);

  // the seal: paid, final in under a second
  const seal = ph(t, T.seal, false);
  if (seal > 0) {
    const sc = { x: R.x + S * 0.12, y: R.y - S * 0.42 };
    const sr = S * 0.15;
    wash(ctx, sc, sr * 2.6, 0.22 * seal);
    sketch(ctx, ellipse(sc, sr, sr, -Math.PI / 2, Math.PI * 1.62), { seed: 150, jitter: 0.8, width: 1.8, alpha: 0.85, passes: 3 }, clamp(seal * 1.6));
    hatch(ctx, { x: sc.x - sr * 0.6, y: sc.y + sr * 0.5 }, { x: sc.x + sr * 0.5, y: sc.y + sr * 0.6 }, 8, { x: sr * 0.25, y: -sr * 0.9 }, 151, clamp(seal * 1.4 - 0.3), 1, 0.2);
    sketch(ctx, [{ x: sc.x - sr * 0.45, y: sc.y }, { x: sc.x - sr * 0.1, y: sc.y + sr * 0.35 }, { x: sc.x + sr * 0.5, y: sc.y - sr * 0.38 }], { seed: 152, jitter: 0.6, width: 2.4, alpha: 0.9 }, clamp(seal * 2 - 0.9));
    ctx.font = `${Math.max(11, Math.round(S / 20))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(${INK}, ${0.65 * clamp(seal * 2 - 1)})`;
    ctx.fillText("paid · final in 0.4 s", sc.x, sc.y + sr * 1.75);
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
    // a fixed moment to show instead of the animation: reduced motion shows the plane mid-flight
    let still: number | null = reduced ? 5.9 : null;
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
      // the headline's text box, not its full-width block
      const h1 = section?.querySelector("h1");
      let title: Band["title"] = null;
      if (h1) {
        const range = document.createRange();
        range.selectNodeContents(h1);
        const r = range.getBoundingClientRect();
        title = { top: r.top - rect.top, left: r.left - rect.left, right: r.right - rect.left };
      }
      lay = layout(rect.width, rect.height, panel ? { panelLeft: panel.left - rect.left, panelRight: panel.right - rect.left, title } : null);
      if (still !== null) render(ctx, lay, still); // resizing clears the canvas: redraw the still frame
    };

    const frame = (now: number) => {
      if (!running || !lay) return;
      render(ctx, lay, ((now - start) / 1000) % LOOP);
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
      // dev only: draw a given second of the story (?heroAt=5.8 or window.__heroAt(5.8)) to inspect frames
      const at = (t: number) => {
        pause();
        still = t;
        if (lay) render(ctx, lay, t);
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
