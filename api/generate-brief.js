/**
 * POST /api/generate-brief
 *
 * Step 1 of the playbook builder: takes a coach's typed description
 * (and optional hand-drawn diagram image) and returns a STRUCTURED
 * BRIEF — phase-by-phase player positions and actions — WITHOUT
 * generating the final HTML yet. This is what the preview screen
 * renders so the coach can confirm player locations before the
 * expensive full build step runs.
 *
 * Auth: requires a Supabase coach session (Authorization: Bearer
 * <access_token> header) that owns the programId being built for.
 * See api/_lib/validate-session.js.
 *
 * Body (JSON):
 *   {
 *     programId: string,
 *     playName: string,
 *     courtType: "half" | "full",
 *     level: string,           // youth | high-school | prep | college | pro
 *     phaseCount: number,
 *     description: string,
 *     imageBase64?: string,    // optional hand-drawn diagram, base64 (no prefix)
 *     imageMediaType?: string  // e.g. "image/png", required if imageBase64 present
 *   }
 *
 * Response (JSON):
 *   { brief: { phases: [ ... ] } }
 *   or { error: string } with an appropriate status code
 */

import { validateCoachSession } from "./_lib/validate-session.js";
import { findMentionedSystem, getSupabase, slugify, enqueueResearchTopic } from "./_lib/knowledge-base.js";
// Synchronous in-request research fallback (added Sep 15, 2026, per Shaun's
// "Yes - build it now"): when a coach names a system the KB doesn't
// recognize, this reuses the EXACT same citation-gate / domain-restricted
// research logic the 6-hour cron worker uses (api/research-knowledge.js),
// so the two paths can't silently drift apart. See the "SYNCHRONOUS
// RESEARCH FALLBACK" block below for the full flow.
import { researchTopic, verifyCitations, buildKbEntryUpsertPayload } from "./_lib/kb-research.js";
import { buildPlayPrompt, buildPlay, toLegacyBrief } from "./_lib/play-brief.js";
import { renderPhaseSvg } from "./_lib/render-phase.js";

// Runs on Vercel's default Node.js runtime — Edge Functions have a hard
// ~25s cap that can't be extended, and open-ended play descriptions can
// take the model longer to reason through than that.
export const config = { maxDuration: 180 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// The play-reading prompt now lives in api/_lib/play-brief.js (Oct 1, 2026
// rebuild): the AI returns play DATA, code does positions and drawing.

// How long the synchronous research call is allowed to run before this
// request gives up and falls back to general model knowledge. Shaun's
// original ask was "how fast are we able to research an unknown play
// name/set in the moment" -- this is the bound we're holding it to (the
// "~20-25s" figure floated and approved), not yet validated against a real
// timed call; brief.synchronousResearchLatencyMs on the response is how
// that gets measured for real once this ships.
const SYNCHRONOUS_RESEARCH_TIMEOUT_MS = 22000;

// Deterministic (non-LLM, same philosophy as findMentionedSystem) fallback
// for detecting "the coach named a specific system" when the play-creation
// UI hasn't yet been given an explicit namedSystem field to make that
// unambiguous (see the TODO on kb_research_queue's design in
// claude/knowledge-base-architecture.md). Intentionally conservative: only
// fires on "<name> offense/defense/press/zone/series", so a coach who
// merely describes actions without naming a system correctly produces no
// match rather than a guessed one.
// Case-SENSITIVE on purpose: a real system name is almost always written
// as a proper noun ("Wheel offense", "1-4 High offense", "Read and React
// offense"), so requiring the captured phrase to start with an uppercase
// letter or digit is what keeps this from firing on generic phrasing like
// "we run our offense" or "read the defense". Known gap: this only catches
// the "<Name> offense/defense/..." word order, not "our defense is a
// Box-and-One" (name before the category word) -- acceptable for a
// heuristic that's explicitly a stopgap for the real fix (an explicit
// namedSystem field from the UI, see the destructured field above).
const NAMED_SYSTEM_PATTERN = /\b((?:[A-Z0-9][A-Za-z0-9\-\/']*|and|to)(?:\s+(?:[A-Z0-9][A-Za-z0-9\-\/']*|and|to)){0,4})\s+(offense|defense|press|zone|series)\b/;
const NAMED_SYSTEM_LEADING_STOPWORDS = new Set([
  "this", "our", "the", "we", "a", "an", "my", "your", "their", "some", "any",
  "it", "play", "run", "playing", "call", "calls", "named", "its",
]);

function extractNamedSystemCandidate(text) {
  if (!text) return null;
  const m = text.match(NAMED_SYSTEM_PATTERN);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  // Strip generic leading words a sentence-starting capital can produce
  // ("This 1-4 High offense..." -> drop "This"), and bail entirely if
  // nothing real is left ("This offense" alone, capitalized only because
  // it starts the sentence).
  while (words.length > 1 && NAMED_SYSTEM_LEADING_STOPWORDS.has(words[0].toLowerCase())) {
    words.shift();
  }
  if (words.length === 0 || NAMED_SYSTEM_LEADING_STOPWORDS.has(words[0].toLowerCase())) return null;
  return `${words.join(" ")} ${m[2]}`.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const body = req.body;

  if (!body || typeof body !== "object") {
    return sendJson(res, { error: "Invalid JSON body" }, 400);
  }

  const {
    programId,
    playName,
    courtType,
    basketOrientation,
    level,
    phaseCount,
    description,
    imageBase64,
    imageMediaType,
    // Optional, not yet sent by the UI: the clean, unambiguous signal for
    // "the coach explicitly named a real system" that
    // claude/knowledge-base-architecture.md flagged as the natural next
    // step ("Wiring that up is the very next piece of this, not yet
    // built."). When the play-creation UI grows an explicit field for this,
    // wire it through here and it will be preferred over the regex
    // heuristic below (see extractNamedSystemCandidate).
    namedSystem,
  } = body;

  // Basket orientation only applies to half court; default to "down" (the
  // original behavior) whenever it's missing or the court is full.
  const resolvedOrientation = courtType === "half" && basketOrientation === "up" ? "up" : "down";

  if (!programId || !description) {
    return sendJson(res, { error: "Missing required fields" }, 400);
  }

  // Server-side cap matching the UI's own max -- the client already limits
  // this to 8, but the API shouldn't just trust that.
  if (phaseCount !== undefined && phaseCount !== null && (phaseCount < 1 || phaseCount > 8)) {
    return sendJson(res, { error: "phaseCount must be between 1 and 8" }, 400);
  }

  // ---- Auth: require a logged-in coach who owns this program ----
  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }

  // ---- Build the Anthropic API request ----
  const userContent = [];

  if (imageBase64 && imageMediaType) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMediaType,
        data: imageBase64,
      },
    });
  }

  const textPrompt = [
    `Play name: ${playName || "(untitled)"}`,
    `Court type: ${courtType || "half"}`,
    courtType === "half" ? `Basket position: ${resolvedOrientation} (${resolvedOrientation === "up" ? "basket near the top" : "basket near the bottom, the default"})` : null,
    `Coaching level: ${level || "high-school"}`,
    phaseCount ? `Target phase count: ${phaseCount}` : null,
    `Description from coach:`,
    description,
  ]
    .filter(Boolean)
    .join("\n");

    // ---- Retrieval-first knowledge base check ----
  // Never let the model guess at a named system's structure when we
  // actually have a verified entry for it. This is a plain substring
  // match against kb_entries (see api/_lib/knowledge-base.js) -- not an
  // LLM call, not a heuristic guess at intent, just: does the coach's own
  // text literally name a system we already know. A miss here isn't
  // treated as "the coach's play is unknown to basketball" -- most plays
  // don't name a formal system at all -- it just means this specific
  // grounding step doesn't apply, and generation proceeds on general
  // model knowledge as before.
  let groundedEntry = null;
  try {
    groundedEntry = await findMentionedSystem(description);
  } catch (err) {
    console.log(`[generate-brief] knowledge base lookup failed (non-fatal): ${err.message}`);
  }

  // ---- Synchronous in-request research fallback ----
  // Approved by Shaun Sep 15, 2026 ("Yes - build it now") in response to
  // "We need a more solid approach than general basketball knowledge - as
  // that has shown to create failures at this point." When the retrieval
  // step above misses AND the coach appears to have named a real system by
  // name, this makes ONE bounded, timeboxed, citation-gated web-search call
  // (same gate, same coach-vetted allowed_domains as the background cron
  // worker -- see api/_lib/kb-research.js) inline in this same request,
  // rather than either making the coach wait indefinitely or silently
  // falling back to ungrounded general knowledge. On success the result is
  // both used to ground THIS brief and persisted to kb_entries so every
  // future request for the same system is an instant retrieval-first hit.
  // On failure/timeout, generation proceeds on general model knowledge
  // exactly as before -- but brief.groundingSource below makes that
  // previously-silent case visible instead of hidden.
  let groundingSource = groundedEntry ? "kb_entries_hit" : "ungrounded_fallback";
  let synchronousResearchLatencyMs = null;

  if (!groundedEntry) {
    const candidateSystemName = (typeof namedSystem === "string" && namedSystem.trim()) || extractNamedSystemCandidate(description);

    if (candidateSystemName) {
      const researchStart = Date.now();
      try {
        const { parsed, realCitations, searchCallCount } = await researchTopic(candidateSystemName, {
          timeoutMs: SYNCHRONOUS_RESEARCH_TIMEOUT_MS,
        });
        synchronousResearchLatencyMs = Date.now() - researchStart;
        console.log(`[generate-brief] synchronous research for "${candidateSystemName}" took ${synchronousResearchLatencyMs}ms`);

        if (searchCallCount === 0) {
          console.log(`[generate-brief] synchronous research: model never invoked web_search for "${candidateSystemName}"`);
        } else if (!parsed) {
          console.log(`[generate-brief] synchronous research: could not parse a JSON block for "${candidateSystemName}"`);
        } else if (parsed.insufficient_evidence) {
          console.log(`[generate-brief] synchronous research: insufficient evidence for "${candidateSystemName}": ${parsed.notes || "(no notes)"}`);
        } else {
          const gate = verifyCitations(parsed, realCitations);
          if (!gate.ok) {
            console.log(`[generate-brief] synchronous research: citation gate failed for "${candidateSystemName}": ${gate.reason}`);
          } else {
            const slug = slugify(parsed.system_name);
            // Use the service-role client, not the request-scoped one from
            // validateCoachSession -- kb_entries is shared reference data
            // across every program, not something scoped to this coach's
            // own program by RLS.
            const supabaseAdmin = getSupabase();
            const { data: existingSeed } = await supabaseAdmin
              .from("kb_entries")
              .select("id, confidence")
              .eq("slug", slug)
              .maybeSingle();

            if (existingSeed && existingSeed.confidence === "seed_verified") {
              // Never let a live research hit overwrite a coach-curated
              // seed row -- same rule the cron worker enforces.
              console.log(`[generate-brief] synchronous research: a seed_verified entry already exists for "${slug}", not overwriting`);
            } else {
              const upsertPayload = buildKbEntryUpsertPayload(parsed, slug);
              const { data: inserted, error: upsertError } = await supabaseAdmin
                .from("kb_entries")
                .upsert(upsertPayload, { onConflict: "slug" })
                .select("*")
                .single();

              if (upsertError) {
                console.log(`[generate-brief] synchronous research: kb_entries upsert failed for "${slug}": ${upsertError.message}`);
              } else {
                groundedEntry = inserted;
                groundingSource = "synchronous_research_hit";
                console.log(`[generate-brief] synchronous research: merged "${slug}" live and grounded this request in it`);
              }
            }
          }
        }
      } catch (err) {
        synchronousResearchLatencyMs = Date.now() - researchStart;
        if (err && err.code === "RESEARCH_TIMEOUT") {
          console.log(`[generate-brief] synchronous research timed out after ${synchronousResearchLatencyMs}ms for "${candidateSystemName}"`);
        } else {
          console.log(`[generate-brief] synchronous research failed after ${synchronousResearchLatencyMs}ms for "${candidateSystemName}": ${err.message}`);
        }
      }

      // Whether or not the synchronous attempt above succeeded, also feed
      // this named system into the background pipeline -- this is the
      // "queue fills itself from real usage" wiring
      // claude/knowledge-base-architecture.md flagged as not yet built.
      // Fire-and-forget: never let a queueing failure affect this response.
      try {
        await enqueueResearchTopic(candidateSystemName, {
          reason: "coach_requested_unknown_system",
          requestedBy: authResult.user ? authResult.user.id : null,
        });
      } catch (err) {
        console.log(`[generate-brief] failed to enqueue "${candidateSystemName}" for background research (non-fatal): ${err.message}`);
      }
    }
  }

  if (groundedEntry) {
    const kbBlock = [
      ``,
      `VERIFIED KNOWLEDGE BASE ENTRY (use these specifics as ground truth for this named system; the coach's own description still wins for anything it explicitly overrides):`,
      `System: ${groundedEntry.system_name}${groundedEntry.formation ? ` (${groundedEntry.formation})` : ""}`,
      `Summary: ${groundedEntry.summary}`,
      groundedEntry.structure && Object.keys(groundedEntry.structure).length > 0
        ? `Structure: ${JSON.stringify(groundedEntry.structure)}`
        : null,
      groundedEntry.confidence === "seed_verified"
        ? `Source: ChalkTalk coach-curated reference (not web-sourced).`
        : Array.isArray(groundedEntry.sources) && groundedEntry.sources.length > 0
        ? `Sources: ${groundedEntry.sources.map((s) => s.url).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    userContent.push({ type: "text", text: kbBlock });
  }

  userContent.push({ type: "text", text: textPrompt });

  // ---- Ask for play data; if the checker finds problems, send them back once.
  const opts = { courtType: courtType === "full" ? "full" : "half", basketOrientation: resolvedOrientation, level };
  const system = buildPlayPrompt(opts);
  const messages = [{ role: "user", content: userContent }];
  let built = null, raw = null, rawText = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const callStart = Date.now();
    let data;
    try {
      const anthropicRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 8000, system, messages }),
      });
      console.log(`[generate-brief] attempt ${attempt}: Anthropic ${anthropicRes.status} in ${Date.now() - callStart}ms`);
      if (!anthropicRes.ok) {
        if (built) break; // keep the first attempt's play
        return sendJson(res, { error: `Anthropic API error: ${await anthropicRes.text()}` }, 502);
      }
      data = await anthropicRes.json();
    } catch (err) {
      if (built) break;
      return sendJson(res, { error: "Failed to reach Anthropic API" }, 502);
    }
    const textBlock = (data.content || []).find((blk) => blk.type === "text");
    rawText = textBlock ? textBlock.text : "";
    let parsed;
    try {
      const cleaned = rawText.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
      const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
      parsed = JSON.parse(first !== -1 && last > first ? cleaned.slice(first, last + 1) : cleaned);
    } catch (err) {
      if (built) break;
      const truncated = data.stop_reason === "max_tokens";
      return sendJson(res, {
        error: truncated
          ? "The response was too long and got cut off before finishing. Try a shorter description, specify a lower phase count, or split this into two separate plays."
          : "Model did not return valid JSON",
        raw: rawText,
      }, 502);
    }
    raw = parsed;
    built = buildPlay(parsed, opts);
    if (built.issues.length === 0) break;
    console.warn(`[generate-brief] attempt ${attempt}: ${built.issues.length} play issue(s):`, built.issues);
    messages.push({ role: "assistant", content: rawText });
    messages.push({ role: "user", content: `The play data has these problems:\n- ${built.issues.join("\n- ")}\nReturn the corrected full JSON only.` });
  }

  const brief = toLegacyBrief(built.play, built.phases);
  if (playName) brief.playName = brief.playName || playName;
  // The play data itself -- what the renderer draws from (step 2.4).
  brief.play = built.play;
  // Anything the checker still flags after the retry -- shown to the coach
  // on the preview rather than silently shipped.
  brief.playIssues = built.issues;
  // Preview diagrams drawn by the SAME renderer as the final playbook, so
  // what the coach approves is exactly what gets built.
  built.phases.forEach((ph, i) => {
    if (brief.phases[i]) brief.phases[i].previewSvg = renderPhaseSvg(ph, built.play, { assetBase: "/assets/courts" });
  });

  brief.groundedInKb = Boolean(groundedEntry);
  brief.groundedSystemSlug = groundedEntry ? groundedEntry.slug : null;
  brief.groundingSource = groundingSource; // "kb_entries_hit" | "synchronous_research_hit" | "ungrounded_fallback"
  if (synchronousResearchLatencyMs !== null) {
    brief.synchronousResearchLatencyMs = synchronousResearchLatencyMs;
  }

  return sendJson(res, { brief });
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
