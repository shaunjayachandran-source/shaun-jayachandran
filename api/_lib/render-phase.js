/**
 * Draws one phase's diagram from play data (audit step 2.2). No AI involved:
 * colors, arrows, screens, dribbles, passes, handoffs and the ball are all
 * computed here, so they come out the same way every time.
 *
 * Pure string output, no DOM -- runs in Node (playbook build) and in the
 * browser (draft preview) from the same file.
 *
 * Input: a ResolvedPhase from resolvePlay() (play-model.js) plus the play.
 */

import { COURT_PLACEMENT, VIEWBOX, courtFile, rim } from "./court.js";

export const PLAYER_COLORS = {
  1: { fill: "#f0b429", stroke: "#ffd060", text: "#0d1017" },
  2: { fill: "#27ae60", stroke: "#2ecc71", text: "#ffffff" },
  3: { fill: "#2a6ae8", stroke: "#7db3ff", text: "#ffffff" },
  4: { fill: "#9b59b6", stroke: "#c39bd3", text: "#ffffff" },
  5: { fill: "#e03a2e", stroke: "#ff7b6e", text: "#ffffff" },
};

const R = 12;            // player circle radius
const GHOST_R = 11;
const BALL_R = 6;
const STEM = 12;         // screen stem length beyond the screener's circle
const BAR = 14;          // screen crossbar length
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f = (n) => Math.round(n * 10) / 10;
const unit = (dx, dy) => { const d = Math.hypot(dx, dy) || 1; return { x: dx / d, y: dy / d, d }; };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

// Closest point on segment a-b to p.
function nearestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

// Move the last point of a path back by `by` so an arrowhead meets a circle's edge.
function trimEnd(points, by) {
  const out = points.map((p) => ({ ...p }));
  const a = out[out.length - 2], b = out[out.length - 1];
  const u = unit(b.x - a.x, b.y - a.y);
  const cut = Math.min(by, u.d * 0.5);
  b.x -= u.x * cut; b.y -= u.y * cut;
  return out;
}
function trimStart(points, by) {
  const out = points.map((p) => ({ ...p }));
  const a = out[0], b = out[1];
  const u = unit(b.x - a.x, b.y - a.y);
  const cut = Math.min(by, u.d * 0.5);
  a.x += u.x * cut; a.y += u.y * cut;
  return out;
}

const polyline = (pts) => "M" + pts.map((p) => `${f(p.x)},${f(p.y)}`).join(" L");

// Tight sine-wave dribble along every leg (ported from the play editor).
function squiggle(points, amplitude = 4.5, waveLength = 14) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i], p1 = points[i + 1];
    const u = unit(p1.x - p0.x, p1.y - p0.y);
    segs.push({ p0, len: u.d, ux: u.x, uy: u.y, px: -u.y, py: u.x });
    total += u.d;
  }
  const step = waveLength / 6;
  let d = "", dist = 0, first = true;
  for (const s of segs) {
    const n = Math.max(2, Math.round(s.len / step));
    for (let k = first ? 0 : 1; k <= n; k++) {
      const t = k / n, at = dist + s.len * t;
      const fadeStart = total - waveLength * 0.8;
      const fade = at > fadeStart ? Math.max(0, 1 - (at - fadeStart) / (waveLength * 0.8)) : at < waveLength * 0.4 ? at / (waveLength * 0.4) : 1;
      const off = Math.sin((at / waveLength) * 2 * Math.PI) * amplitude * fade;
      const x = s.p0.x + s.ux * s.len * t + s.px * off, y = s.p0.y + s.uy * s.len * t + s.py * off;
      d += first ? `M${f(x)},${f(y)}` : ` L${f(x)},${f(y)}`;
      first = false;
    }
    dist += s.len;
  }
  return d;
}

/**
 * @param {object} phase  ResolvedPhase (startPos, endPos, ballStart, actions, ...)
 * @param {object} play   { courtType, basketOrientation, level }
 * @param {object} [opts] { assetBase: "https://.../assets/courts", tooltips: { [n]: {label, text} }, caption }
 * @returns {string} a complete <svg> element
 */
export function renderPhaseSvg(phase, play, opts = {}) {
  const courtType = play.courtType === "full" ? "full" : "half";
  const orient = play.basketOrientation === "up" ? "up" : "down";
  const pn = phase.phaseNumber;
  const S = phase.startPos, E = phase.endPos;
  const actions = phase.actions || [];
  const base = opts.assetBase || "/assets/courts";
  const place = COURT_PLACEMENT[courtType];
  const parts = [];
  const used = new Set();
  const marker = (n) => { used.add(n); return `url(#ct${pn}-a${n})`; };

  // Each mover's path (start -> [via] -> [through the screen] -> end).
  const moverPath = {};
  for (const a of actions) {
    if (a.type === "cut" || a.type === "dribble") {
      const n = Number(a.player);
      moverPath[n] = [S[n], ...((a.via || []).map((p) => ({ x: p.x, y: p.y }))), E[n]];
    } else if (a.type === "handoff") {
      const h = (phase.handoffs || []).find((x) => x.from === Number(a.from) && x.to === Number(a.to));
      moverPath[Number(a.from)] = [S[a.from], E[a.from]];
      // Receiver comes over the top of the handoff (farther from the basket).
      moverPath[Number(a.to)] = h ? [S[a.to], h.overTop] : [S[a.to], E[a.to]];
    }
  }

  // ---- Screens: stem + crossbar in the SCREENER's color (Shaun, Sep 30).
  const screenParts = [];
  for (const a of actions.filter((x) => x.type === "screen")) {
    const by = Number(a.by), forN = Number(a.for);
    const sp = S[by];
    const path = moverPath[forN];
    const reach = R + STEM;

    // 1. Make sure the cut actually uses the screen: if the route misses the
    //    screener, bend it past the screener's shoulder.
    if (path) {
      let best = null;
      for (let i = 0; i < path.length - 1; i++) {
        const q = nearestOnSegment(sp, path[i], path[i + 1]);
        const d = Math.hypot(q.x - sp.x, q.y - sp.y);
        if (!best || d < best.d) best = { ...q, d, seg: i };
      }
      const endsAtScreen = best.seg === path.length - 2 && best.t > 0.95;
      if (best.d > reach + 14 && !endsAtScreen) {
        const u = unit(best.x - sp.x, best.y - sp.y);
        path.splice(best.seg + 1, 0, { x: sp.x + u.x * (reach + 10), y: sp.y + u.y * (reach + 10) });
      }
    }

    // 2. Cutter's direction of travel at the screen = the route leg nearest the screener.
    let travel = null;
    if (path) {
      let best = null;
      for (let i = 0; i < path.length - 1; i++) {
        const q = nearestOnSegment(sp, path[i], path[i + 1]);
        const d = Math.hypot(q.x - sp.x, q.y - sp.y);
        if (!best || d < best.d) best = { d, i };
      }
      travel = unit(path[best.i + 1].x - path[best.i].x, path[best.i + 1].y - path[best.i].y);
    }

    // 3. Stem points from the screener toward where the cutter comes from
    //    (the screener's body faces the defender being screened). Explicit
    //    `at` overrides.
    const origin = S[forN] || { x: sp.x, y: sp.y - 40 };
    let su = a.at ? unit(a.at.x - sp.x, a.at.y - sp.y) : unit(origin.x - sp.x, origin.y - sp.y);
    if (su.d < 1) su = { x: 0, y: -1 };
    const stemEnd = a.at ? { x: a.at.x, y: a.at.y } : { x: sp.x + su.x * reach, y: sp.y + su.y * reach };
    const stemStart = { x: sp.x + su.x * R, y: sp.y + su.y * R };

    // 4. Crossbar perpendicular to the cutter's travel (or to the stem if no cutter).
    const t = travel || { x: su.x, y: su.y };
    const px = -t.y, py = t.x;

    const c = PLAYER_COLORS[by].stroke;
    screenParts.push(
      `<line x1="${f(stemStart.x)}" y1="${f(stemStart.y)}" x2="${f(stemEnd.x)}" y2="${f(stemEnd.y)}" stroke="${c}" stroke-width="2.5" stroke-linecap="round" data-player="${by}" data-role="screen-stem"/>`,
      `<line x1="${f(stemEnd.x - px * BAR / 2)}" y1="${f(stemEnd.y - py * BAR / 2)}" x2="${f(stemEnd.x + px * BAR / 2)}" y2="${f(stemEnd.y + py * BAR / 2)}" stroke="${c}" stroke-width="2.5" stroke-linecap="round" data-player="${by}" data-role="screen-bar"/>`
    );
  }

  // ---- Movement lines (cuts solid, dribbles squiggle) + ghosts.
  const dribblers = new Set(actions.filter((a) => a.type === "dribble").map((a) => Number(a.player)));
  for (const a of actions.filter((x) => x.type === "handoff")) dribblers.add(Number(a.from));
  const moveParts = [], ghostParts = [];
  for (const [nStr, pts] of Object.entries(moverPath)) {
    const n = Number(nStr);
    const c = PLAYER_COLORS[n];
    const route = trimStart(trimEnd(pts, GHOST_R + 2), R);
    const d = dribblers.has(n) ? squiggle(route) : polyline(route);
    moveParts.push(`<path d="${d}" fill="none" stroke="${c.stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" marker-end="${marker(n)}" data-player="${n}" data-role="move"/>`);
    ghostParts.push(`<circle cx="${f(E[n].x)}" cy="${f(E[n].y)}" r="${GHOST_R}" fill="${rgba(c.fill, 0.18)}" stroke="${rgba(c.fill, 0.65)}" stroke-width="1.4" stroke-dasharray="3,3" data-player="${n}" data-role="ghost"/>`);
  }

  // ---- Passes: dashed, PASSER's color, to where the receiver catches it.
  const passParts = [];
  let holder = phase.ballStart;
  for (const a of actions) {
    if (a.type === "pass") {
      const from = Number(a.from), to = Number(a.to);
      // Passer throws from where they start, unless they caught it earlier this phase.
      const src = from === Number(phase.ballStart) ? S[from] : E[from];
      const dst = E[to];
      const pts = trimStart(trimEnd([src, dst], R + 3), R + 2);
      passParts.push(`<path d="${polyline(pts)}" fill="none" stroke="${PLAYER_COLORS[from].stroke}" stroke-width="2" stroke-dasharray="7,4" marker-end="${marker(from)}" data-player="${from}" data-role="pass"/>`);
      holder = to;
    } else if (a.type === "handoff") {
      holder = Number(a.to);
    }
  }

  // ---- Handoff: ring where possession changes, then the receiver's
  // downhill look -- a live dribble if the coach gave a drive spot,
  // otherwise a faded option arrow toward the rim.
  const handoffParts = [];
  for (const h of phase.handoffs || []) {
    const c = PLAYER_COLORS[h.to];
    handoffParts.push(`<circle cx="${f(h.at.x)}" cy="${f(h.at.y)}" r="4" fill="none" stroke="#ff6b00" stroke-width="1.5" data-role="handoff-spot"/>`);
    const rr = rim(courtType, orient);
    const down = unit(rr.x - h.overTop.x, rr.y - h.overTop.y);
    if (h.drive) {
      const route = trimEnd([h.overTop, h.drive], GHOST_R + 2);
      handoffParts.push(`<path d="${squiggle(route)}" fill="none" stroke="${c.stroke}" stroke-width="2.5" marker-end="${marker(h.to)}" data-player="${h.to}" data-role="drive"/>`);
    } else {
      const tip = { x: h.overTop.x + down.x * 55, y: h.overTop.y + down.y * 55 };
      handoffParts.push(`<path d="${polyline(trimStart([h.overTop, tip], R))}" fill="none" stroke="${c.stroke}" stroke-width="1.8" stroke-dasharray="4,4" opacity="0.6" marker-end="${marker(h.to)}" data-player="${h.to}" data-role="option"/>`);
    }
  }

  // ---- Players at their start spots.
  const playerParts = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const p = S[n], c = PLAYER_COLORS[n];
    const tip = (opts.tooltips && opts.tooltips[n]) || {};
    playerParts.push(
      `<g class="pc" data-player="${n}" data-l="${esc(tip.label || `Player ${n}`)}" data-t="${esc(tip.text || "")}">` +
      `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${R}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.8" data-player="${n}" data-role="start"/>` +
      `<text x="${f(p.x)}" y="${f(p.y)}" dy="0.35em" text-anchor="middle" font-family="Bebas Neue, sans-serif" font-size="14" fill="${c.text}">${n}</text></g>`
    );
  }

  // ---- The ball: on whoever has it at the start, just off their circle toward the rim.
  let ball = "";
  const bh = S[phase.ballStart];
  if (bh) {
    const rr = rim(courtType, orient);
    const u = unit(rr.x - bh.x, rr.y - bh.y);
    const off = R + BALL_R - 1;
    ball = `<circle cx="${f(bh.x + u.x * off)}" cy="${f(bh.y + u.y * off)}" r="${BALL_R}" fill="#ff6b00" stroke="white" stroke-width="1.5" data-role="ball" data-player="${phase.ballStart}"/>`;
  }

  // ---- Caption bar.
  const capText = String(opts.caption || [phase.phaseName, phase.keyAction].filter(Boolean).join(" · "));
  const cap = capText.length > 86 ? capText.slice(0, 83).trimEnd() + "..." : capText;
  const capY = courtType === "full" ? 482 : 400;
  const caption = `<rect x="32" y="${capY}" width="456" height="14" rx="2" fill="rgba(0,0,0,.6)"/><text x="260" y="${capY + 10}" text-anchor="middle" font-family="DM Mono, monospace" font-size="9" font-weight="600" fill="#f0b429">${esc(cap)}</text>`;

  const defs = [...used].map((n) =>
    `<marker id="ct${pn}-a${n}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${PLAYER_COLORS[n].stroke}"/></marker>`
  ).join("");

  const img = `<image href="${esc(base)}/${courtFile(courtType, play.level, orient)}" x="${place.x}" y="${place.y}" width="${place.width}" height="${place.height}" preserveAspectRatio="none"/>`;

  // Order matters: court, screens (under players), movement, passes, ghosts, players, ball, caption.
  parts.push(img, ...screenParts, ...moveParts, ...passParts, ...handoffParts, ...ghostParts, ...playerParts, ball, caption);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX[courtType]}" class="court-svg" role="img" aria-label="${esc(phase.phaseName || `Phase ${pn}`)}"><defs>${defs}</defs>${parts.join("")}</svg>`;
}
