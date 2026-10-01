/**
 * The play-reading step (audit step 2.3): the AI turns a coach's
 * description into PLAY DATA (play-model.js). It never writes coordinates
 * for players who don't move, never tracks the ball, never draws anything.
 * Spots are named in the coach's own left/right; code converts them.
 */

import { resolveSpot, spotList } from "./court.js";
import { resolvePlay } from "./play-model.js";

export function buildPlayPrompt({ courtType }) {
  const spots = spotList();
  return `You are a basketball coach's assistant. Turn the coach's description of ONE play into structured play data. You do NOT draw anything and you do NOT track the ball or anyone's position -- code does that from your actions.

Return ONLY JSON, no markdown:
{
  "playName": "string",
  "start": { "1": SPOT, "2": SPOT, "3": SPOT, "4": SPOT, "5": SPOT },
  "ballStart": 1,
  "phases": [
    {
      "phaseNumber": 1,
      "phaseName": "SHORT ALL-CAPS NAME",
      "branchFrom": null,
      "continuesFrom": null,
      "actions": [ ACTION, ... ],
      "keyAction": "one sentence",
      "teachingCue": "short quotable coaching phrase",
      "commonError": "what goes wrong, framed as what the defense wants"
    }
  ]
}

SPOT = a named spot string (${spots}) or {"x":..,"y":..} only for a spot not on that list${courtType === "full" ? " (full court: viewBox 0 0 520 500, defensive basket y=28, half-court line y=252, attacking basket y=472 -- use x/y)" : ""}.
LEFT/RIGHT are ALWAYS the coach's: the offense's own left and right as they face the basket they attack. Use the coach's words directly; never mirror them.

ACTION -- exactly these shapes, one movement (cut/dribble/handoff) per player per phase, passes are separate:
- {"type":"cut","player":N,"to":SPOT,"via":[SPOT],"note":"..."}       via is optional (a curl, a baseline route)
- {"type":"dribble","player":N,"to":SPOT,"via":[SPOT],"note":"..."}   only the player who has the ball
- {"type":"pass","from":N,"to":N,"note":"..."}                        only the player who has the ball
- {"type":"screen","by":N,"for":N,"note":"..."}                       the screener does NOT move in that phase
- {"type":"handoff","from":N,"to":N,"at":SPOT,"drive":SPOT,"note":"..."}  a DHO -- see below; drive optional
"note" is a short phrase for that player's job (e.g. "cuts baseline off 4's screen").

RULES (the code checks these; a play that breaks them is sent back to you):
1. Phase 1 is the starting alignment (usually no actions). Players not mentioned stay where they are -- never list them.
2. Positions carry forward automatically from the phase before (or from continuesFrom).
3. A screener stays planted while screening. Getting to the screen spot is a cut in the PREVIOUS phase; popping/rolling after is the NEXT phase.
4. OPTIONS: when the coach gives alternatives ("if denied", "or", "the other read"), each alternative is its own phase starting from the SAME moment: set "branchFrom" to the phase it is an alternative to, and start the names with "OPTION A -- " / "OPTION B -- ". A phase that follows an option and isn't simply the next phase sets "continuesFrom".
5. DHO: the ball-handler dribbles toward a teammate and hands it off at "at"; the ball-handler is the one CLOSER to the basket there, the receiver comes over the top (farther from the basket) and looks to go downhill. A swing or reversal is a PASS, never a DHO.
6. A backdoor cut always goes toward the basket.
7. Spacing: no two players end a phase on the same spot; perimeter players stay ~15 ft apart. 4-out/5-out spots are top, slots and corners (not wings). In a 5-out, players rotate to refill the five spots -- they don't follow the ball.
8. Flex: the cutter starts in the weak-side corner and cuts baseline off the flex screen (set at the weak-side block) to the ball-side block; then a guard down-screens for the flex screener ("screen the screener"), who comes up to the slot.
9. At most 8 phases.

EXAMPLE (flex, part):
{"playName":"Flex","start":{"1":"right slot","2":"left slot","3":"right wing","4":"left flex screen","5":"left corner"},"ballStart":1,"phases":[
{"phaseNumber":1,"phaseName":"FLEX SET","actions":[],"keyAction":"...","teachingCue":"...","commonError":"..."},
{"phaseNumber":2,"phaseName":"ENTRY","actions":[{"type":"pass","from":1,"to":3,"note":"enters to the wing"}],"keyAction":"...","teachingCue":"...","commonError":"..."},
{"phaseNumber":3,"phaseName":"FLEX CUT","actions":[{"type":"screen","by":4,"for":5,"note":"flex screen"},{"type":"cut","player":5,"to":"right block","note":"baseline cut off 4's screen"}],"keyAction":"...","teachingCue":"...","commonError":"..."}]}`;
}

// A location may be a spot name, {spot}, or {x,y}. Returns {x,y} or null.
function loc(v, orient) {
  if (!v) return null;
  if (typeof v === "string") return resolveSpot(v, orient);
  if (typeof v.spot === "string") return resolveSpot(v.spot, orient);
  if (typeof v.x === "number" && typeof v.y === "number") return { x: Math.round(v.x), y: Math.round(v.y) };
  return null;
}

/** AI JSON -> play data (spots resolved). Unknown spots become issues. */
export function normalizePlay(raw, { courtType, basketOrientation, level }) {
  const issues = [];
  const orient = basketOrientation === "up" ? "up" : "down";
  const at = (v, what) => {
    const p = loc(v, orient);
    if (!p && v != null) issues.push(`Unknown spot ${JSON.stringify(v)} for ${what} -- use one of: ${spotList()}.`);
    return p;
  };
  const start = {};
  for (const n of [1, 2, 3, 4, 5]) start[n] = at(raw.start && raw.start[n], `player ${n}'s start`);
  const phases = (raw.phases || []).map((ph, i) => ({
    phaseNumber: Number(ph.phaseNumber) || i + 1,
    phaseName: String(ph.phaseName || `PHASE ${i + 1}`),
    branchFrom: ph.branchFrom ?? null,
    continuesFrom: ph.continuesFrom ?? null,
    keyAction: ph.keyAction || "",
    teachingCue: ph.teachingCue || "",
    commonError: ph.commonError || "",
    actions: (ph.actions || []).map((a) => {
      const out = { ...a };
      for (const k of ["player", "from", "to", "by", "for"]) if (out[k] != null && !(k === "to" && a.type !== "pass" && a.type !== "handoff")) out[k] = Number(out[k]);
      if (a.type === "cut" || a.type === "dribble") {
        out.to = at(a.to, `phase ${ph.phaseNumber} ${a.type} by ${a.player}`);
        out.via = (a.via || []).map((v) => at(v, `phase ${ph.phaseNumber} route`)).filter(Boolean);
      }
      if (a.type === "handoff") {
        out.at = at(a.at, `phase ${ph.phaseNumber} handoff spot`);
        out.drive = a.drive ? at(a.drive, `phase ${ph.phaseNumber} drive`) : null;
      }
      return out;
    }),
  }));
  return {
    play: { playName: raw.playName || "", courtType: courtType === "full" ? "full" : "half", basketOrientation: orient, level: level || "high-school", start, ballStart: Number(raw.ballStart) || 1, phases },
    issues,
  };
}

/**
 * The older per-player brief shape (players[] with start/end/hasBall/action)
 * that the current preview and sidebar step read. Built FROM the resolved
 * play, so it can't disagree with the diagrams.
 */
export function toLegacyBrief(play, resolved) {
  const phases = resolved.map((ph) => {
    const notes = {};
    for (const a of ph.actions || []) {
      const who = a.player ?? a.by ?? a.from;
      const text = a.note || describe(a);
      notes[who] = notes[who] ? `${notes[who]}; ${text}` : text;
      if (a.type === "pass" || a.type === "handoff") notes[a.to] = notes[a.to] || (a.type === "pass" ? `receives the pass from ${a.from}` : `takes the handoff from ${a.from}`);
      if (a.type === "screen") notes[a.for] = notes[a.for] || `uses ${a.by}'s screen`;
    }
    return {
      phaseNumber: ph.phaseNumber,
      phaseName: ph.phaseName,
      branchFrom: ph.branchFrom,
      keyAction: ph.keyAction,
      teachingCue: ph.teachingCue,
      commonError: ph.commonError,
      ballEndsWith: ph.ballEnd,
      players: [1, 2, 3, 4, 5].map((n) => ({
        number: n,
        startX: ph.startPos[n].x, startY: ph.startPos[n].y,
        endX: ph.endPos[n].x, endY: ph.endPos[n].y,
        hasBall: ph.ballStart === n,
        action: notes[n] || "holds their spot",
      })),
    };
  });
  return { playName: play.playName, courtType: play.courtType, basketOrientation: play.basketOrientation, level: play.level, phases };
}

function describe(a) {
  switch (a.type) {
    case "cut": return "cuts";
    case "dribble": return "dribbles";
    case "pass": return `passes to ${a.to}`;
    case "screen": return `screens for ${a.for}`;
    case "handoff": return `dribbles to ${a.to} and hands off`;
    default: return "";
  }
}

/** Convenience: normalize + resolve, issues combined. */
export function buildPlay(raw, opts) {
  const { play, issues: spotIssues } = normalizePlay(raw, opts);
  const { phases, issues } = resolvePlay(play);
  return { play, phases, issues: [...spotIssues, ...issues] };
}
