/**
 * POST /api/generate-playbook
 *
 * Step 2 of the playbook builder (BUILD MODE): takes a CONFIRMED brief
 * and generates the full interactive HTML playbook.
 *
 * ARCHITECTURE NOTE: to stay within Vercel Hobby's 60s function timeout,
 * generation is split into:
 *   1. A deterministic HTML "shell" (fonts, CSS, tab-switching JS,
 *      tooltip JS, progress bar, home-link) built in code -- no LLM call,
 *      instant, and identical in structure across every play.
 *   2. One Claude call PER PHASE, run in PARALLEL via Promise.all, each
 *      writing only that phase's coaching text + tooltips. Since Oct 1,
 *      2026 the DIAGRAM is drawn by code (api/_lib/render-phase.js) from
 *      the play data in brief.play -- see
 *      claude/audit-2026-09-30-play-generation.md.
 * This keeps each individual Claude call small and fast regardless of
 * how many phases a play has, since they run concurrently rather than
 * accumulating sequentially against the 60s cap.
 *
 * Auth: requires a Supabase coach session (Authorization: Bearer
 * <access_token> header) that owns programId. Re-validated independently
 * from the brief step, same as before.
 *
 * Storage: writes a `plays` row first (so the play shows up on the coach's
 * dashboard immediately), then uploads the rendered HTML to Vercel Blob at
 * a path keyed by that row's UUID (generated/<play-id>.html) rather than by
 * human-readable program+slug -- removes the old, guessable
 * generated/<program>/<slug>.html path.
 *
 * Body (JSON):
 *   { programId: string, brief: { ...see generate-brief.js schema }, category?: string, subCategory?: string, narrationEnabled?: boolean }
 *
 *   category is one of PLAY_CATEGORIES below (offense/defense/slob/blob/special).
 *   It powers the public team directory page (public/team.html) so plays can
 *   be grouped into the right section there -- purely organizational, no
 *   effect on the generated playbook content itself. Falls back to null
 *   (shown as "Uncategorized" on the team page) if omitted or invalid.
 *
 *   subCategory confirms the Man/Zone/Press(-Break) bucket for the public
 *   Offense/Defense subpages -- required (and validated) whenever category
 *   is "offense" or "defense", per SUB_CATEGORIES_BY_CATEGORY below. There is
 *   deliberately no inferred/"Other" fallback: a coach must confirm this at
 *   build time. Ignored (stored as null) for slob/blob/special, which stay
 *   flat grids with no sub-grouping.
 *
 *   narrationEnabled (Item 2, auditory narration) is the coach's per-play
 *   opt-in, stored as plays.narration_enabled -- read later by
 *   generate-narration.js when a publish action fires. Forced to false for
 *   a youth-level play regardless of what's sent, mirroring the same
 *   "anything that isn't youth" gate generate-narration.js enforces
 *   server-side -- defense in depth, not the only place this is checked.
 *
 * Response (JSON):
 *   { url: string }   -- public Blob URL of the generated playbook
 *   or { error: string } with an appropriate status code
 */

import { put } from "@vercel/blob";
import { validateCoachSession } from "./_lib/validate-session.js";
import { resolvePlay } from "./_lib/play-model.js";
import { renderPhaseSvg } from "./_lib/render-phase.js";

export const config = { maxDuration: 180 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const PLAY_CATEGORIES = ["offense", "defense", "slob", "blob", "special"];

// Which sub_category values are valid for each category that requires one.
// Offense uses "press_break" (press-break terminology); defense uses plain
// "press". SLOB/BLOB/Special have no entry here -- they never get a
// sub_category.
const SUB_CATEGORIES_BY_CATEGORY = {
  offense: ["man", "zone", "press_break"],
  defense: ["man", "zone", "press"],
};

// Court art, served from the production site (generated plays are hosted
// on Vercel Blob, a different origin, so this must be absolute).
const COURT_ASSET_BASE = "https://chalktalk-court.vercel.app/assets/courts";

// Oct 1, 2026 rebuild (claude/audit-2026-09-30-play-generation.md): the
// diagram is drawn by code (api/_lib/render-phase.js) from the play data.
// The AI writes ONLY the coaching text and player tooltips.
const SIDEBAR_SYSTEM_PROMPT = `You are a master basketball coach and teacher writing the coaching notes for ONE phase of an interactive playbook. The diagram is already drawn -- you write words only.

Return ONLY valid JSON, no markdown fences:
{
  "sidebarHtml": "HTML fragment",
  "tooltips": { "1": {"label": "1 -- SHORT ROLE", "text": "2-4 sentences"}, "2": {...}, "3": {...}, "4": {...}, "5": {...} }
}
Use single quotes for every HTML attribute inside sidebarHtml (it is a JSON string).

Sidebar HTML rules:
- One top-level <div>. <h3> with the phase name in Title Case.
- Numbered coaching points: <div class='cp'><span class='cp-n'>N</span><span class='cp-t'>...</span></div>. Refer to players as <span class='pill p1'>1</span> (p1..p5).
- One <div class='kbox'>: level "youth" -> <strong>For Parents</strong> with an analogy for a parent in the stands; any other level -> <strong>Coach's Eye</strong> (tactical, reads-based). Never address parents above youth level.
- One <div class='bbridge'> explaining how this phase sets up the next (omit it on the final phase).
- If the phase is an OPTION (branchFrom is set), the first point says what read leads to this option instead of the other.
- Describe ONLY what the phase data says happens -- who cuts, dribbles, passes, screens or hands off, and where. Never invent extra movement.
- Left/right are the coach's (the offense facing its basket) -- use the spot names given, never "screen left".
- Voice: players get direct, spatial instructions; coaches get the read and the why. Frame errors as "what the defense wants". they/them, no he/him. Calibrate depth to the level.
- Pure ASCII: use HTML entities (&mdash; &rarr; &ldquo; &rdquo;).`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const body = req.body;

  if (!body || typeof body !== "object") {
    return sendJson(res, { error: "Invalid JSON body" }, 400);
  }

  const { programId, brief, category, subCategory, narrationEnabled } = body;

  if (!programId || !brief || !Array.isArray(brief.phases) || brief.phases.length === 0) {
    return sendJson(res, { error: "Missing or invalid brief" }, 400);
  }
  if (!brief.play || !Array.isArray(brief.play.phases)) {
    return sendJson(res, { error: "This preview is from before the Oct 2026 update -- click Analyze Play again, then build." }, 400);
  }

  // Re-work every position and the ball from the play data here, rather
  // than trusting the browser's copy. This is what gets drawn.
  const { phases: resolvedPhases, issues: playIssues } = resolvePlay(brief.play);

  const resolvedCategory = PLAY_CATEGORIES.includes(category) ? category : null;

  // subCategory is only meaningful (and required) for offense/defense. If
  // this category needs one but the value sent isn't in its allowed set,
  // reject outright rather than silently storing null and letting the play
  // fall into an inferred/"Other" bucket downstream.
  const allowedSubCategories = SUB_CATEGORIES_BY_CATEGORY[resolvedCategory];
  let resolvedSubCategory = null;
  if (allowedSubCategories) {
    if (!allowedSubCategories.includes(subCategory)) {
      return sendJson(
        res,
        { error: `subCategory must be one of: ${allowedSubCategories.join(", ")} for category "${resolvedCategory}"` },
        400
      );
    }
    resolvedSubCategory = subCategory;
  }

  // Narration (Item 2) opt-in: forced false for youth regardless of what
  // the client sent, mirroring the same "anything that isn't youth" gate
  // generate-narration.js enforces again server-side when a publish
  // action later fires -- this is a second, independent check, not the
  // only one.
  const resolvedNarrationEnabled = !!narrationEnabled && brief.level !== "youth";

  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }
  const { user, supabase } = authResult;

  const slug = slugify(brief.playName || "untitled-play");

  // Staff-submission gate: only a coach with can_publish=true on this
  // program gets their build published immediately. Everyone else's build
  // lands as 'in_review' -- visible to the whole coaching staff on the
  // dashboard, but not on the public team page (play_directory only
  // exposes status='published') -- until a publisher approves it.
  const { data: coachRow } = await supabase
    .from("program_coaches")
    .select("can_publish")
    .eq("program_id", programId)
    .eq("coach_id", user.id)
    .maybeSingle();
  const initialStatus = coachRow && coachRow.can_publish ? "published" : "in_review";

  // Everything in this handler has to finish inside Vercel's 60s function
  // limit. The per-phase Claude calls (below) are the slow part and already
  // run in parallel with each other; the plays-row write doesn't depend on
  // their output at all, so run it CONCURRENTLY with phase generation
  // instead of strictly after it -- that fully hides its latency under the
  // AI calls' own time instead of adding to the total. A single `upsert`
  // (matching the `unique (program_id, slug)` constraint) replaces the old
  // select-then-insert-or-update pattern, cutting a full round trip too.
  // Re-running a build for the same play updates that row in place rather
  // than creating a duplicate.
  let phaseResults, playRow;
  try {
    const [pr, row] = await Promise.all([
      Promise.all(
        resolvedPhases.map((phase, idx) =>
          generatePhaseContent(phase, brief.phases.find((p) => p.phaseNumber === phase.phaseNumber), brief, idx === resolvedPhases.length - 1)
        )
      ),
      supabase
        .from("plays")
        .upsert(
          {
            program_id: programId,
            slug,
            title: brief.playName || "Untitled Play",
            play_type: resolvedCategory,
            sub_category: resolvedSubCategory,
            phase_count: resolvedPhases.length,
            court_type: brief.courtType || "half",
            status: initialStatus,
            narration_enabled: resolvedNarrationEnabled,
            // Rebuilding an existing play (same program+slug) must never
            // keep serving the PREVIOUS build's narration audio against
            // new/changed phases -- clear it; generate-narration.js
            // repopulates it on the next publish.
            narration_json: null,
            created_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "program_id,slug" }
        )
        .select()
        .single()
        .then(({ data, error }) => {
          if (error) throw error;
          return data;
        }),
    ]);
    phaseResults = pr;
    playRow = row;
  } catch (err) {
    return sendJson(res, { error: `Play generation failed: ${err.message}` }, 502);
  }

  const html = buildShellHtml(brief, phaseResults, playRow.id, resolvedNarrationEnabled);
  const blobPath = `generated/${playRow.id}.html`;

  let blobResult;
  try {
    blobResult = await put(blobPath, html, {
      access: "public",
      contentType: "text/html",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentDisposition: "inline",
    });
  } catch (err) {
    return sendJson(res, { error: `Failed to save playbook: ${err.message}` }, 502);
  }

  // brief_json (Item 2, auditory narration): folds each confirmed phase's
  // brief data together with the sidebarHtml this step just generated for
  // it. This is the SAME phase data generate-narration.js later grounds
  // its narration in -- a deliberate single shared source rather than a
  // third un-synced copy of phase/anchor data, per the project's own
  // documented history of generate-brief.js/generate-playbook.js drift.
  const briefJson = {
    ...brief,
    phases: brief.phases.map((phase) => {
      const generated = phaseResults.find((p) => p.phaseNumber === phase.phaseNumber);
      return { ...phase, sidebarHtml: generated ? generated.sidebarHtml : "" };
    }),
  };

  const { error: updateErr } = await supabase
    .from("plays")
    .update({ storage_url: blobResult.url })
    .eq("id", playRow.id);
  if (updateErr) {
    // The play and the file both exist at this point -- just the DB
    // record's storage_url link didn't save. Don't fail the whole
    // request over it; the coach still gets a working URL back.
    console.log(`[generate-playbook] Failed to update storage_url for play ${playRow.id}: ${updateErr.message}`);
  }

  // Deliberately a SEPARATE write from storage_url above: view-play.js
  // 404s any play with no storage_url, so if brief_json ever fails (e.g.
  // a missing column), it must not take the core "coach can open their
  // play" path down with it. Narration just won't have data to ground in.
  const { error: briefJsonErr } = await supabase
    .from("plays")
    .update({ brief_json: briefJson })
    .eq("id", playRow.id);
  if (briefJsonErr) {
    console.log(`[generate-playbook] Failed to save brief_json for play ${playRow.id}: ${briefJsonErr.message}`);
  }

  // Narration (Item 2): only ever triggered from a publish action, and
  // only for the creation-time publish path here -- initialStatus was
  // already resolved to "published" above from the coach's own
  // can_publish grant. The OTHER trigger point (an explicit Publish click
  // on an existing in_review play) lives in dashboard.html and is
  // untouched by this file. Awaited rather than backgrounded: a plain
  // fire-and-forget fetch isn't reliably safe on Vercel (the function can
  // be frozen the instant this response is sent), and Fluid Compute
  // (needed for waitUntil) isn't confirmed enabled on this project.
  // Also skipped outright when the coach didn't opt in (or it's youth):
  // no point spending a round trip -- and build time -- just to get
  // skipped:true back.
  if (initialStatus === "published" && resolvedNarrationEnabled) {
    try {
      await triggerNarration(playRow.id, req);
    } catch (err) {
      console.log(`[generate-playbook] narration trigger failed for play ${playRow.id}: ${err.message}`);
    }
  }

  const diagramWarnings = playIssues;
  if (diagramWarnings.length) {
    console.warn(`[generate-playbook] play ${playRow.id} has ${diagramWarnings.length} diagram validation warning(s).`);
  }

  return sendJson(res, {
    url: blobResult.url,
    playId: playRow.id,
    status: initialStatus,
    diagramWarnings: diagramWarnings.length ? diagramWarnings : undefined,
  });
}

// Calls /api/generate-narration for this play, forwarding the original
// caller's own auth header so generate-narration.js's own
// validateCoachSession check passes exactly as it would for a direct
// call. Resolves the origin from the incoming request's own Host header.
async function triggerNarration(playId, req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  if (!host) {
    throw new Error("Missing Host header, cannot resolve narration endpoint origin");
  }
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const res = await fetch(`${proto}://${host}/api/generate-narration`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
    body: JSON.stringify({ playId }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`generate-narration returned ${res.status}: ${errText}`);
  }
}

// Defensive: the prompt tells the model NOT to include its own outer <svg>
// tag (the code supplies the court + real <svg> wrapper already), but if
// it does anyway, that nested tag brings its own coordinate system and
// silently rescales/mispositions everything inside it. Strip it rather
// than trusting compliance.

// Anthropic's raw SVG/HTML fields inside the phase JSON response often
// contain literal newlines (the model formats multi-line markup for
// readability), which the JSON spec forbids unescaped inside a string --
// that's the "Bad control character in string literal" parse failure.
// Walk the text and escape control characters, but ONLY while inside a
// string literal, so real structural whitespace between JSON tokens is
// left alone.
function sanitizeJsonControlChars(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = text.charCodeAt(i);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}
// Plain-words summary of a phase's actions for the sidebar writer.
function describeActions(phase) {
  const spotOf = (p) => (p ? `(${p.x},${p.y})` : "");
  return (phase.actions || []).map((a) => {
    switch (a.type) {
      case "cut": return `${a.player} cuts${a.note ? ` -- ${a.note}` : ""}`;
      case "dribble": return `${a.player} dribbles${a.note ? ` -- ${a.note}` : ""}`;
      case "pass": return `${a.from} passes to ${a.to}${a.note ? ` -- ${a.note}` : ""}`;
      case "screen": return `${a.by} screens for ${a.for}${a.note ? ` -- ${a.note}` : ""}`;
      case "handoff": return `${a.from} dribbles to ${a.to} and hands off (DHO); ${a.to} comes over the top and looks downhill${a.note ? ` -- ${a.note}` : ""}`;
      default: return "";
    }
  }).filter(Boolean).join("\n") || "No movement -- this is the alignment.";
}

async function generatePhaseContent(phase, legacyPhase, brief, isFinalPhase) {
  const userPrompt = `Write the coaching notes for this phase.

Play: ${brief.playName || "(untitled)"}
Coaching level: ${brief.level || "high-school"}
Phase ${phase.phaseNumber}: ${phase.phaseName}${phase.isOption ? ` (OPTION -- an alternative to phase ${phase.branchFrom})` : ""}
This is ${isFinalPhase ? "the FINAL phase (omit the bbridge)" : "NOT the final phase (include a bbridge)"}.
Key action: ${phase.keyAction || ""}
Teaching cue: ${phase.teachingCue || ""}
Common error: ${phase.commonError || ""}
Ball starts with: ${phase.ballStart}; ends with: ${phase.ballEnd}
What happens:
${describeActions(phase)}
Each player's job:
${(legacyPhase ? legacyPhase.players : []).map((p) => `${p.number}: ${p.action}`).join("\n")}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SIDEBAR_SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error on phase ${phase.phaseNumber}: ${await res.text()}`);

  const data = await res.json();
  console.log(`[generate-playbook] phase ${phase.phaseNumber} usage:`, data.usage);
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error(`No text response for phase ${phase.phaseNumber}`);

  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  const firstBrace = cleaned.indexOf("{"), lastBrace = cleaned.lastIndexOf("}");
  const jsonSlice = firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
  let parsed;
  try {
    parsed = JSON.parse(sanitizeJsonControlChars(jsonSlice));
  } catch (err) {
    throw new Error(`Invalid JSON for phase ${phase.phaseNumber}: ${err.message}`);
  }

  // The diagram: drawn by code from the play data, never by the AI.
  const diagramSvg = renderPhaseSvg(phase, brief.play, { assetBase: COURT_ASSET_BASE, tooltips: parsed.tooltips || {} });

  return { phaseNumber: phase.phaseNumber, phaseName: phase.phaseName, diagramSvg, sidebarHtml: parsed.sidebarHtml || "" };
}


function buildShellHtml(brief, phaseResults, playId, narrationEnabled) {
  const tabs = phaseResults
    .map(
      (p, i) =>
        `<button class="tab-btn${i === 0 ? " active" : ""}" data-phase="${p.phaseNumber}" onclick="switchPhase(${p.phaseNumber})">PHASE ${p.phaseNumber}<br><span class="tab-name">${escapeHtml(p.phaseName)}</span></button>`
    )
    .join("\n");


  const diagrams = phaseResults
    .map(
      (p, i) =>
        `<div class="phase-diagram${i === 0 ? " active" : ""}" id="pd-${p.phaseNumber}">${p.diagramSvg}</div>`
    )
    .join("\n");

  const sidebars = phaseResults
    .map(
      (p, i) =>
        `<div class="phase-sidebar${i === 0 ? " active" : ""}" id="sb-${p.phaseNumber}">${p.sidebarHtml}</div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(brief.playName || "ChalkTalk Play")}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500;700&family=DM+Sans:wght@300;400;500;700&display=swap');
  :root {
    --bg: #0d1017; --panel: #121820; --panel-2: #161e29; --border: #1e2a3a;
    --gold: #f0b429; --white: #f2ede4; --gray: #6b7a8d; --teal: #1abc9c;
    --kbox-bg: #2a2318; --kbox-border: #5c4a1f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--white); font-family: 'DM Sans', sans-serif; padding: 24px; }
  .home-link { display: inline-block; color: var(--gray); text-decoration: none; font-size: 13px; margin-bottom: 16px; }
  .home-link:hover { color: var(--gold); }
  h1 { font-family: 'Bebas Neue', sans-serif; font-size: 32px; letter-spacing: 1px; color: var(--gold); margin: 0 0 20px; }
  .progress-bar { height: 4px; background: var(--border); border-radius: 2px; margin-bottom: 20px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--gold); transition: width 0.3s; }
  .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .tab-btn { font-family: 'DM Mono', monospace; font-size: 11px; background: var(--panel-2); border: 1px solid var(--border); color: var(--gray); padding: 8px 14px; border-radius: 8px; cursor: pointer; text-align: left; }
  .tab-btn.active { border-color: var(--gold); color: var(--gold); }
  .tab-name { font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600; }
  .layout { display: grid; grid-template-columns: 1.3fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .phase-diagram, .phase-sidebar { display: none; }
  .phase-diagram.active, .phase-sidebar.active { display: block; }
  .phase-diagram svg { display: block; width: 100%; height: auto; max-height: calc(100vh - 48px); background: #0a0d12; border: 1px solid var(--border); border-radius: 8px; }
  /* Keep the court on screen while the notes scroll (desktop). */
  @media (min-width: 901px) { .diagrams { position: sticky; top: 16px; align-self: start; } }
  @media (max-width: 600px) { body { padding: 12px; } h1 { font-size: 26px; } .tab-btn { padding: 6px 10px; } }
  .phase-sidebar { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .phase-sidebar h3 { font-family: 'Bebas Neue', sans-serif; color: var(--gold); font-size: 22px; letter-spacing: 0.5px; margin-top: 0; }
  .cp { display: flex; gap: 10px; margin-bottom: 10px; font-size: 14px; line-height: 1.5; }
  .cp-n { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--panel-2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--gold); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 12px; font-weight: 700; color: #0d1017; }
  .p1 { background: #f0b429; } .p2 { background: #27ae60; } .p3 { background: #7db3ff; } .p4 { background: #c39bd3; } .p5 { background: #ff7b6e; }
  .kbox { background: var(--kbox-bg); border: 1px solid var(--kbox-border); border-radius: 8px; padding: 14px; margin-top: 16px; font-size: 13px; line-height: 1.6; }
  .bbridge { background: rgba(26,188,156,0.08); border: 1px solid var(--teal); border-radius: 8px; padding: 14px; margin-top: 16px; font-size: 13px; line-height: 1.6; }
  #tip { position: absolute; display: none; background: #1a1400; border: 1px solid var(--gold); color: var(--white); padding: 8px 12px; border-radius: 6px; font-size: 12px; max-width: 240px; z-index: 100; pointer-events: none; }
  .narration-bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .narration-play-btn { font-family: 'DM Mono', monospace; font-size: 12px; font-weight: 600; background: var(--panel-2); border: 1px solid var(--gold); color: var(--gold); padding: 8px 14px; border-radius: 8px; cursor: pointer; }
  .narration-play-btn:hover { background: rgba(240,180,41,0.12); }
  .narration-unavailable, .narration-pending { font-family: 'DM Mono', monospace; font-size: 12px; color: var(--gray); }
  /* stroke-based (not CSS filter): CSS filter functions on individual SVG
     child elements are unreliable across browsers (notably Safari/iOS),
     while animating stroke/stroke-width works everywhere. */
  @keyframes narrationPulse {
    0%, 100% { stroke-width: 1.6px; }
    50% { stroke-width: 5px; stroke: #ffffff; }
  }
  .pc.narrating-pulse { animation: narrationPulse 1s ease-in-out infinite; }
</style>
</head>
<body>

<a class="home-link" href="index.html">&larr; Return to Homepage</a>
<h1>${escapeHtml(brief.playName || "PLAY")}</h1>

<div class="progress-bar"><div class="progress-fill" id="progressFill" style="width: ${Math.round(100 / phaseResults.length)}%"></div></div>

<div class="tabs">
${tabs}
</div>

<div class="layout">
  <div class="diagrams">
${diagrams}
  </div>
  <div class="sidebars">
${sidebars}
  </div>
</div>

<div id="tip"></div>

<script>
  const totalPhases = ${phaseResults.length};
  const PLAY_ID = ${JSON.stringify(playId || null)};
  const NARRATION_ENABLED = ${narrationEnabled ? "true" : "false"};
  let currentPhaseNum = ${phaseResults[0] ? phaseResults[0].phaseNumber : 1};
  function switchPhase(n) {
    document.querySelectorAll('.phase-diagram, .phase-sidebar').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('pd-' + n).classList.add('active');
    document.getElementById('sb-' + n).classList.add('active');
    document.querySelector('.tab-btn[data-phase="' + n + '"]').classList.add('active');
    document.getElementById('progressFill').style.width = Math.round((n / totalPhases) * 100) + '%';
    currentPhaseNum = n;
    if (NARRATION_ENABLED) onPhaseSwitchedForNarration(n);
  }
  const tip = document.getElementById('tip');
  document.addEventListener('mouseover', (e) => {
    const pc = e.target.closest('.pc');
    if (!pc) return;
    tip.textContent = pc.getAttribute('data-t') || pc.getAttribute('data-l') || '';
    tip.style.display = 'block';
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.style.display === 'block') {
      tip.style.left = (e.pageX + 12) + 'px';
      tip.style.top = (e.pageY + 12) + 'px';
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.pc')) tip.style.display = 'none';
  });

  // --- Auditory narration playback (Item 2) ---
  // Narration is generated AFTER build/publish (see generate-narration.js)
  // and this page is served straight from public Blob storage with no
  // server/auth context of its own, so narration data can't be baked in
  // at build time -- it's fetched client-side, once, from a small public
  // read endpoint keyed only by playId (api/get-narration.js). Playback
  // uses one plain <audio> element (no Web Audio API) with manual volume
  // tweening for a cross-fade when switching phases mid-playback, per the
  // agreed design. Player highlighting reads the per-segment start/end
  // times ElevenLabs returned (plays.narration_json) and pulses whichever
  // .pc circle matches the currently-speaking segment's player number.
  let narrationByPhase = null; // { [phaseNumber]: { audioUrl, timings, error } }
  let audioEl = null;
  let narrationIsPlaying = false;

  // Timers for the in-flight fade and the delayed pause/source-swap.
  // Every new user action cancels both first -- otherwise a quick
  // pause-then-play (or rapid tab switching) lets a stale delayed pause
  // fire AFTER playback restarted, leaving audio silent while the button
  // still says "Pause".
  let fadeTimer = null;
  let pendingAudioTimer = null;
  function cancelPendingAudio() {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    if (pendingAudioTimer) { clearTimeout(pendingAudioTimer); pendingAudioTimer = null; }
  }

  // Narration is often still generating when this page first loads
  // (especially right after "Approve & publish"), so poll briefly instead
  // of showing a permanent "check back" message that never updates.
  const NARRATION_POLL_MS = 10000;
  const NARRATION_POLL_MAX = 18; // ~3 minutes, then give up quietly
  let narrationPollCount = 0;

  if (NARRATION_ENABLED && PLAY_ID) {
    fetchNarration();
  }

  function clearNarrationBars() {
    document.querySelectorAll('.narration-bar').forEach((el) => el.remove());
  }

  async function fetchNarration() {
    try {
      const res = await fetch('/api/get-narration?playId=' + encodeURIComponent(PLAY_ID));
      if (!res.ok) { clearNarrationBars(); return; }
      const data = await res.json();
      if (!data || !data.generated || !Array.isArray(data.narration)) {
        narrationPollCount++;
        if (narrationPollCount <= NARRATION_POLL_MAX) {
          renderNarrationPending();
          setTimeout(fetchNarration, NARRATION_POLL_MS);
        } else {
          clearNarrationBars();
        }
        return;
      }
      narrationByPhase = {};
      data.narration.forEach((p) => { narrationByPhase[p.phaseNumber] = p; });
      renderNarrationControls();
    } catch (e) {
      // Narration is additive -- a fetch failure should never break the
      // diagram/sidebar view a coach or parent actually came here for.
      clearNarrationBars();
    }
  }

  function renderNarrationPending() {
    clearNarrationBars();
    document.querySelectorAll('.phase-diagram').forEach((el) => {
      const bar = document.createElement('div');
      bar.className = 'narration-bar';
      bar.innerHTML = '<span class="narration-pending">Narration is being prepared -- it will appear here automatically.</span>';
      el.appendChild(bar);
    });
  }

  function renderNarrationControls() {
    clearNarrationBars();
    document.querySelectorAll('.phase-diagram').forEach((el) => {
      const n = parseInt(el.id.replace('pd-', ''), 10);
      const entry = narrationByPhase[n];
      const bar = document.createElement('div');
      bar.className = 'narration-bar';
      if (entry && entry.audioUrl) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'narration-play-btn';
        btn.dataset.phase = String(n);
        btn.textContent = '\u25B6 Play Narration';
        btn.addEventListener('click', () => toggleNarration(n));
        bar.appendChild(btn);
      } else {
        bar.innerHTML = '<span class="narration-unavailable">Narration unavailable for this phase.</span>';
      }
      el.appendChild(bar);
    });
  }

  function ensureAudioEl() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.addEventListener('timeupdate', onNarrationTimeUpdate);
      audioEl.addEventListener('ended', () => {
        narrationIsPlaying = false;
        clearPlayerHighlight();
        updateNarrationButtons();
      });
    }
    return audioEl;
  }

  // Note: iOS Safari ignores programmatic volume changes, so there the
  // fade is a no-op and playback simply starts/stops -- harmless.
  function fadeVolume(el, from, to, ms) {
    if (fadeTimer) clearInterval(fadeTimer);
    const steps = 10;
    const stepMs = Math.max(1, Math.round(ms / steps));
    let i = 0;
    el.volume = from;
    fadeTimer = setInterval(() => {
      i++;
      el.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps)));
      if (i >= steps) { clearInterval(fadeTimer); fadeTimer = null; }
    }, stepMs);
  }

  function toggleNarration(n) {
    const entry = narrationByPhase && narrationByPhase[n];
    if (!entry || !entry.audioUrl) return;
    const el = ensureAudioEl();
    cancelPendingAudio();
    if (narrationIsPlaying && currentPhaseNum === n) {
      fadeVolume(el, el.volume, 0, 220);
      pendingAudioTimer = setTimeout(() => { pendingAudioTimer = null; el.pause(); }, 230);
      narrationIsPlaying = false;
      clearPlayerHighlight();
    } else {
      if (n !== currentPhaseNum) switchPhase(n);
      startPhaseAudio(n, el.src === entry.audioUrl);
    }
    updateNarrationButtons();
  }

  function startPhaseAudio(n, alreadyLoaded) {
    const entry = narrationByPhase[n];
    const el = ensureAudioEl();
    cancelPendingAudio();
    if (!alreadyLoaded) {
      el.src = entry.audioUrl;
      el.currentTime = 0;
    }
    el.volume = 0;
    el.play().catch(() => {});
    fadeVolume(el, 0, 1, 220);
    narrationIsPlaying = true;
  }

  // Called on every phase-tab switch. If narration was actively playing,
  // cross-fades into the new phase's track (fade the old one out, swap
  // source, fade the new one in) instead of a hard cut or letting the old
  // phase's audio keep playing under the new diagram.
  function onPhaseSwitchedForNarration(n) {
    clearPlayerHighlight();
    if (!narrationIsPlaying) {
      updateNarrationButtons();
      return;
    }
    const el = ensureAudioEl();
    cancelPendingAudio();
    const entry = narrationByPhase && narrationByPhase[n];
    if (!entry || !entry.audioUrl) {
      fadeVolume(el, el.volume, 0, 200);
      pendingAudioTimer = setTimeout(() => { pendingAudioTimer = null; el.pause(); }, 210);
      narrationIsPlaying = false;
      updateNarrationButtons();
      return;
    }
    fadeVolume(el, el.volume, 0, 200);
    pendingAudioTimer = setTimeout(() => {
      pendingAudioTimer = null;
      el.src = entry.audioUrl;
      el.currentTime = 0;
      el.volume = 0;
      el.play().catch(() => {});
      fadeVolume(el, 0, 1, 200);
    }, 210);
    updateNarrationButtons();
  }

  function updateNarrationButtons() {
    document.querySelectorAll('.narration-play-btn').forEach((btn) => {
      const n = parseInt(btn.dataset.phase, 10);
      const playingThis = narrationIsPlaying && n === currentPhaseNum;
      btn.textContent = playingThis ? '\u23F8 Pause Narration' : '\u25B6 Play Narration';
    });
  }

  function onNarrationTimeUpdate() {
    if (!narrationByPhase || !narrationByPhase[currentPhaseNum]) return;
    const timings = narrationByPhase[currentPhaseNum].timings || [];
    const t = audioEl.currentTime;
    const active = timings.find((seg) => seg.player && t >= seg.startTime && t < seg.endTime);
    highlightPlayer(active ? active.player : null);
  }

  function highlightPlayer(playerNum) {
    document.querySelectorAll('.pc').forEach((el) => {
      if (playerNum && el.getAttribute('data-player') === String(playerNum)) {
        el.classList.add('narrating-pulse');
      } else {
        el.classList.remove('narrating-pulse');
      }
    });
  }

  function clearPlayerHighlight() {
    document.querySelectorAll('.pc.narrating-pulse').forEach((el) => el.classList.remove('narrating-pulse'));
  }
</script>

</body>
</html>`;
}

function slugify(str) {
  return (
    str
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "untitled-play"
  );
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
