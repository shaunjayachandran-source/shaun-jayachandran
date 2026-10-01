// Reference-play regression check (Oct 1, 2026 rebuild).
// Every play in tests/reference-plays/ was approved by Shaun against its
// source diagrams. This re-runs each one through the play checker and the
// renderer; any issue or crash means a change broke something that worked.
//
// Run from the repo root:  node --experimental-default-type=module tests/run-reference-plays.mjs
import fs from "fs";
import path from "path";
import { buildPlay } from "../api/_lib/play-brief.js";
import { renderPhaseSvg } from "../api/_lib/render-phase.js";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "reference-plays");
let failed = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const opts = { courtType: raw.courtType || "half", basketOrientation: raw.basketOrientation || "down", level: raw.level || "high-school" };
  try {
    const b = buildPlay(raw, opts);
    for (const ph of b.phases) {
      const svg = renderPhaseSvg(ph, b.play);
      if (!svg.includes('data-role="ball"')) b.issues.push(`Phase ${ph.phaseNumber}: no ball drawn.`);
    }
    if (b.issues.length) { failed++; console.log(`FAIL ${file}\n  - ${b.issues.join("\n  - ")}`); }
    else console.log(`ok   ${file} (${b.phases.length} phases)`);
  } catch (err) { failed++; console.log(`FAIL ${file}: ${err.message}`); }
}
console.log(failed ? `\n${failed} reference play(s) failed.` : "\nAll reference plays pass.");
process.exit(failed ? 1 : 0);
