// Mode resolution. Order: ENV → in-prompt marker → default fast_confirm.
// ENV wins because operators set it consciously; markers are user-side
// per-prompt escalation; default is the lowest-friction choice.

export type Mode = "fast_confirm" | "grill_me";

export interface ModeEnv {
  UNDERSTANDING_GATE_MODE?: string;
}

// Two markers, two boundary policies:
//
// SLASH_MARKER stays loose (matches anywhere): `/` is already a deliberate
// invocation glyph, so prompts that mention `/grill` mid-sentence ("describe
// the /grill command") are treated as actual escalations. False positives
// here are infrequent enough to accept.
//
// BARE_MARKER is strict: it only fires when `grill me` / `grill-me` /
// `grill_me` sits at the start of a line, after newline, or immediately
// after imperative punctuation (`,` `:` `;` `?` `!`). This blocks the
// common self-reference case in this very repo (commits, READMEs, tests
// that talk about the marker without invoking it).
const SLASH_MARKER = /(^|[^a-z])\/grill([\s\-_]?me)?\b/i;
const BARE_MARKER = /(^|[\n\r,:;?!]\s*)grill[\s\-_]me\b/i;

function hasMarker(prompt: string): boolean {
  return SLASH_MARKER.test(prompt) || BARE_MARKER.test(prompt);
}

export function pickMode(prompt: string, env: ModeEnv = {}): Mode {
  const envMode = env.UNDERSTANDING_GATE_MODE?.trim().toLowerCase();
  if (envMode === "fast_confirm" || envMode === "grill_me") {
    return envMode;
  }
  if (typeof prompt === "string" && hasMarker(prompt)) {
    return "grill_me";
  }
  return "fast_confirm";
}
