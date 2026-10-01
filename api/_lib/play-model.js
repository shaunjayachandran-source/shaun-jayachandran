/**
 * ChalkTalk play data model (Oct 2026 rebuild, audit step 2.1).
 *
 * The AI describes a play as DATA in this shape; code does everything else
 * (positions, ball, drawing). See claude/audit-2026-09-30-play-generation.md.
 *
 * Play:
 *   { courtType: "half"|"full", basketOrientation: "down"|"up",
 *     start: { "1": {x,y}, ... "5": {x,y} },      // phase-1 spots only
 *     ballStart: 1,                                 // who has the ball first
 *     phases: [Phase, ...] }
 *
 * Phase:
 *   { phaseNumber, phaseName,
 *     branchFrom: null | phaseNumber,   // an OPTION: starts from that phase's START
 *     continuesFrom: null | phaseNumber,// follows that phase's END (default: previous)
 *     actions: [Action, ...],
 *     keyAction, teachingCue, commonError }
 *
 * Action (one movement per player per phase; passes are separate):
 *   { type: "cut",     player, to: {x,y}, via?: [{x,y}] }
 *   { type: "dribble", player, to: {x,y}, via?: [{x,y}] }   // must hold the ball
 *   { type: "pass",    from, to }                             // player numbers
 *   { type: "screen",  by, for, at?: {x,y} }                  // screener stays planted
 *   { type: "handoff", from, to, at: {x,y} }                  // DHO: from dribbles to `at`,
 *                                                             // `to` meets it there; ball changes hands
 *
 * Positions a player doesn't move to are carried forward automatically --
 * the AI never restates them, so they can't drift.
 */

import { playableBounds, rim } from "./court.js";

const PLAYERS = [1, 2, 3, 4, 5];
const TYPES = ["cut", "dribble", "pass", "screen", "handoff"];
const STACK_MIN = 18;
const SPACING_MIN = 60; // perimeter players should be ~15 ft apart
// Rough lane/paint area -- screens and post play happen close together there.
function inPaint(p, play) {
  if (play.courtType === "full") return false;
  const inX = p.x > 180 && p.x < 340;
  return play.basketOrientation === "up" ? inX && p.y < 250 : inX && p.y > 257;
}

const pt = (p) => (p && typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null);
const copy = (pos) => Object.fromEntries(PLAYERS.map((n) => [n, { ...pos[n] }]));

/**
 * Works out every phase's start/end positions and ball holder from the
 * play data. Returns { phases: [ResolvedPhase], issues: [string] } --
 * issues are problems the checker found (see checkPlay).
 *
 * ResolvedPhase = { ...phase, startPos, endPos, ballStart, ballEnd, sourcePhase, isOption }
 */
export function resolvePlay(play) {
  const issues = [];
  const out = [];
  const byNum = new Map();
  const resolvedHandoffs = {};

  const firstStart = {};
  for (const n of PLAYERS) {
    const p = pt(play.start && play.start[n]);
    if (!p) issues.push(`Player ${n} has no starting spot.`);
    firstStart[n] = p || { x: 260, y: 250 };
  }

  (play.phases || []).forEach((phase, i) => {
    // Where does this phase start?
    let startPos, ballStart, sourcePhase = null, isOption = false;
    const branch = phase.branchFrom != null ? byNum.get(Number(phase.branchFrom)) : null;
    const cont = phase.continuesFrom != null ? byNum.get(Number(phase.continuesFrom)) : null;
    if (i === 0) {
      startPos = copy(firstStart);
      ballStart = Number(play.ballStart) || 1;
    } else if (branch) {
      startPos = copy(branch.startPos); ballStart = branch.ballStart; sourcePhase = branch.phaseNumber; isOption = true;
    } else {
      const src = cont || out[i - 1];
      startPos = copy(src.endPos); ballStart = src.ballEnd; sourcePhase = src.phaseNumber;
    }
    if (phase.branchFrom != null && !branch) issues.push(`Phase ${phase.phaseNumber}: branchFrom ${phase.branchFrom} isn't an earlier phase.`);

    // Apply the actions.
    const endPos = copy(startPos);
    let ball = ballStart;
    const movers = new Map();
    const actions = phase.actions || [];

    for (const a of actions) {
      const tag = `Phase ${phase.phaseNumber} ${a.type || "?"}`;
      if (!TYPES.includes(a.type)) { issues.push(`${tag}: unknown action type.`); continue; }
      const who = a.player ?? a.by ?? a.from;
      if (!PLAYERS.includes(Number(who))) { issues.push(`${tag}: player "${who}" isn't 1-5.`); continue; }

      if (a.type === "cut" || a.type === "dribble") {
        const to = pt(a.to);
        if (!to) { issues.push(`${tag} by ${who}: missing "to".`); continue; }
        if (movers.has(who)) issues.push(`${tag}: player ${who} has more than one movement this phase.`);
        if (a.type === "dribble" && Number(who) !== ball) issues.push(`${tag}: player ${who} dribbles but doesn't have the ball (${ball} does).`);
        movers.set(who, a.type);
        endPos[who] = to;
      } else if (a.type === "pass") {
        if (Number(a.from) !== ball) issues.push(`${tag}: ${a.from} passes but doesn't have the ball (${ball} does).`);
        if (!PLAYERS.includes(Number(a.to))) { issues.push(`${tag}: receiver "${a.to}" isn't 1-5.`); continue; }
        if (Number(a.to) === Number(a.from)) issues.push(`${tag}: ${a.from} passes to themselves.`);
        ball = Number(a.to);
      } else if (a.type === "screen") {
        if (!PLAYERS.includes(Number(a.for)) || Number(a.for) === Number(a.by)) issues.push(`${tag}: screen by ${a.by} needs a different teammate in "for".`);
      } else if (a.type === "handoff") {
        const at = pt(a.at);
        if (!at) { issues.push(`${tag}: handoff needs "at".`); continue; }
        if (Number(a.from) !== ball) issues.push(`${tag}: ${a.from} hands off but doesn't have the ball (${ball} does).`);
        if (!PLAYERS.includes(Number(a.to)) || Number(a.to) === Number(a.from)) { issues.push(`${tag}: handoff needs a different receiver.`); continue; }
        // DHO (Shaun, Oct 1): the ball-handler dribbles to `at` and is the one
        // CLOSER to the basket at the handoff; the receiver comes over the top
        // (farther from the basket), takes it, and looks to go downhill.
        const rr = rim(play.courtType, play.basketOrientation);
        const away = (() => { const dx = at.x - rr.x, dy = at.y - rr.y, d = Math.hypot(dx, dy) || 1; return { x: dx / d, y: dy / d }; })();
        const overTop = { x: Math.round(at.x + away.x * 22), y: Math.round(at.y + away.y * 22) };
        const drive = pt(a.drive);
        endPos[a.from] = at;
        endPos[a.to] = drive || overTop;
        (resolvedHandoffs[phase.phaseNumber] ||= []).push({ from: Number(a.from), to: Number(a.to), at, overTop, drive });
        movers.set(Number(a.from), "handoff"); movers.set(Number(a.to), "handoff");
        ball = Number(a.to);
      }
    }

    // Screeners stay planted.
    for (const a of actions.filter((x) => x.type === "screen")) {
      if (movers.has(Number(a.by))) issues.push(`Phase ${phase.phaseNumber}: ${a.by} sets a screen and also moves -- the move belongs in the next phase.`);
    }

    const resolved = { ...phase, startPos, endPos, ballStart, ballEnd: ball, sourcePhase, isOption, handoffs: resolvedHandoffs[phase.phaseNumber] || [] };
    out.push(resolved);
    byNum.set(Number(phase.phaseNumber), resolved);
  });

  issues.push(...checkSpacing(out, play));
  return { phases: out, issues };
}

// A handoff or screen puts two players next to each other on purpose.
function actingTogether(ph, a, b) {
  // (also called with the NEXT phase: a screener arriving beside the ball
  // handler to set a ball screen is close on purpose)
  if (!ph) return false;
  return (ph.actions || []).some((x) => {
    const pair = x.type === "handoff" ? [x.from, x.to] : x.type === "screen" ? [x.by, x.for] : null;
    return pair && pair.map(Number).includes(a) && pair.map(Number).includes(b);
  });
}

// No two players on one spot; everyone inside the lines.
function checkSpacing(phases, play) {
  const issues = [];
  const b = playableBounds(play.courtType, play.basketOrientation);
  for (const ph of phases) {
    for (const [label, pos] of [["start", ph.startPos], ["end", ph.endPos]]) {
      for (const n of PLAYERS) {
        const p = pos[n];
        if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) {
          issues.push(`Phase ${ph.phaseNumber}: player ${n}'s ${label} spot (${p.x},${p.y}) is out of bounds.`);
        }
      }
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
        const a = pos[PLAYERS[i]], c = pos[PLAYERS[j]];
        const d = Math.hypot(a.x - c.x, a.y - c.y);
        if (d < STACK_MIN) {
          issues.push(`Phase ${ph.phaseNumber}: players ${PLAYERS[i]} and ${PLAYERS[j]} are stacked at the ${label} (${a.x},${a.y}).`);
        } else if (label === "end" && d < SPACING_MIN && !inPaint(a, play) && !inPaint(c, play) && !actingTogether(ph, PLAYERS[i], PLAYERS[j]) && !actingTogether(phases[phases.indexOf(ph) + 1], PLAYERS[i], PLAYERS[j])) {
          // Perimeter players (e.g. a wing and a slot on the same side) crowding each other.
          issues.push(`Phase ${ph.phaseNumber}: players ${PLAYERS[i]} and ${PLAYERS[j]} end only ${Math.round(d)} apart on the perimeter -- spacing too tight.`);
        }
      }
    }
  }
  return issues;
}
