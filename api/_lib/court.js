/**
 * The ONE court definition (audit step 3, started early because 2.1 needs
 * it). Brief, renderer, preview and checker all import from here, so the
 * numbers can't drift apart again.
 *
 * Coordinates are SCREEN coordinates in the SVG viewBox. "left"/"right" in
 * anything a coach reads is relative to the ATTACKING BASKET (the offense's
 * own left as they face the basket) -- use coachSideToScreen() to convert.
 */

// Where the court art is drawn (preserveAspectRatio="none").
export const COURT_PLACEMENT = {
  half: { x: 15, y: 110, width: 489, height: 287 },
  full: { x: 8, y: 4, width: 504, height: 464 },
};

export const VIEWBOX = { half: "0 100 520 316", full: "0 0 520 500" };

export const COURT_FILES = {
  half: {
    hs: { down: "half-hs-down.png", up: "half-hs-up.png" },
    pro: { down: "half-pro-down.png", up: "half-pro-up.png" },
  },
  full: { hs: "full-hs-vertical.png", pro: "full-pro-vertical.png" },
};

export function courtLevelBucket(level) {
  return level === "college" || level === "pro" || level === "prep" ? "pro" : "hs";
}

export function courtFile(courtType, level, basketOrientation) {
  const bucket = courtLevelBucket(level);
  return courtType === "full"
    ? COURT_FILES.full[bucket]
    : COURT_FILES.half[bucket][basketOrientation === "up" ? "up" : "down"];
}

// Rim centre, for pointing the ball toward the basket.
export function rim(courtType, basketOrientation) {
  if (courtType === "full") return { x: 260, y: 472 };
  return basketOrientation === "up" ? { x: 260, y: 165 } : { x: 260, y: 342 };
}

// Inside the lines (the art includes an out-of-bounds strip past the baseline).
export function playableBounds(courtType, basketOrientation) {
  if (courtType === "full") return { minX: 17, maxX: 503, minY: 13, maxY: 459 };
  return basketOrientation === "up"
    ? { minX: 30, maxX: 490, minY: 145, maxY: 388 }
    : { minX: 30, maxX: 490, minY: 119, maxY: 362 };
}

// UP is the DOWN value mirrored about the court rectangle's centre.
const mirrorY = (y) => 507 - y;

// Half-court anchors for basket DOWN, keyed by SCREEN side. UP is derived.
const ANCHORS_DOWN = {
  top: { x: 260, y: 185 },
  freeThrow: { x: 260, y: 285 },
  slot: { screenLeft: { x: 135, y: 200 }, screenRight: { x: 385, y: 200 } },
  // Wing = free-throw line extended, clearly below/wider than the slot so
  // the two never crowd each other (Shaun, Oct 1).
  wing: { screenLeft: { x: 80, y: 285 }, screenRight: { x: 440, y: 285 } },
  corner: { screenLeft: { x: 58, y: 355 }, screenRight: { x: 462, y: 355 } },
  elbow: { screenLeft: { x: 207, y: 285 }, screenRight: { x: 313, y: 285 } },
  block: { screenLeft: { x: 207, y: 338 }, screenRight: { x: 313, y: 338 } },
  shortCorner: { screenLeft: { x: 132, y: 358 }, screenRight: { x: 388, y: 358 } },
  dunker: { screenLeft: { x: 194, y: 357 }, screenRight: { x: 326, y: 357 } },
  flexScreen: { screenLeft: { x: 182, y: 345 }, screenRight: { x: 338, y: 345 } },
  // Horns: the two bigs at the top of the key, just outside the lane lines
  // where the elbow meets the 3-pt arc (measured off Coach's Clipboard's
  // Horns set diagram, Oct 1).
  horns: { screenLeft: { x: 189, y: 242 }, screenRight: { x: 331, y: 242 } },
};

export function anchors(basketOrientation) {
  if (basketOrientation !== "up") return ANCHORS_DOWN;
  const flip = (p) => ({ x: p.x, y: mirrorY(p.y) });
  const out = {};
  for (const [k, v] of Object.entries(ANCHORS_DOWN)) {
    out[k] = v.x !== undefined ? flip(v) : { screenLeft: flip(v.screenLeft), screenRight: flip(v.screenRight) };
  }
  return out;
}

// Coach's "left"/"right" (facing the attacking basket) -> screen side.
// Basket DOWN: the offense faces down the screen, so their left is screen-right.
export function coachSideToScreen(side, basketOrientation) {
  const left = String(side).toLowerCase() === "left";
  if (basketOrientation === "up") return left ? "screenLeft" : "screenRight";
  return left ? "screenRight" : "screenLeft";
}

// The anchor table written out for an AI prompt, already in the COACH's
// left/right for this basket position -- so the AI never has to convert.
export function anchorTableForPrompt(basketOrientation) {
  const a = anchors(basketOrientation);
  const L = coachSideToScreen("left", basketOrientation);
  const R = coachSideToScreen("right", basketOrientation);
  const fmt = (p) => `x=${p.x} y=${p.y}`;
  const lines = [
    `Top of the key: ${fmt(a.top)}`,
    `Free-throw line centre: ${fmt(a.freeThrow)}`,
  ];
  const names = { slot: "Slot", wing: "Wing", corner: "Deep corner", elbow: "Elbow", block: "Block", shortCorner: "Short corner", dunker: "Dunker spot", flexScreen: "Flex screen spot (just outside the block)" };
  for (const [k, label] of Object.entries(names)) {
    lines.push(`${label}: left ${fmt(a[k][L])}, right ${fmt(a[k][R])}`);
  }
  return lines.join("\n");
}

// Named spots the AI may use instead of numbers (coach's left/right).
// e.g. "left corner", "right slot", "top", "free throw", "left flex screen".
export const SPOT_NAMES = {
  top: "top", "top of the key": "top", point: "top",
  "free throw": "freeThrow", "free-throw line": "freeThrow", nail: "freeThrow",
  slot: "slot", wing: "wing", corner: "corner", "deep corner": "corner", elbow: "elbow",
  block: "block", "short corner": "shortCorner", dunker: "dunker", "dunker spot": "dunker",
  "flex screen": "flexScreen", "flex screen spot": "flexScreen",
  horns: "horns", "horns spot": "horns",
};

export function spotList() {
  return "top, free throw, and left/right + one of: slot, wing, corner, elbow, horns, block, short corner, dunker, flex screen";
}

/** "left corner" -> {x,y} in screen coordinates (half court only); null if unknown. */
export function resolveSpot(name, basketOrientation) {
  const raw = String(name || "").toLowerCase().trim().replace(/\s+/g, " ");
  const a = anchors(basketOrientation);
  if (SPOT_NAMES[raw] && a[SPOT_NAMES[raw]] && a[SPOT_NAMES[raw]].x !== undefined) return { ...a[SPOT_NAMES[raw]] };
  const m = raw.match(/^(left|right)\s+(.+)$/);
  if (!m) return null;
  const key = SPOT_NAMES[m[2]];
  if (!key || !a[key] || a[key].x !== undefined) return null;
  return { ...a[key][coachSideToScreen(m[1], basketOrientation)] };
}
