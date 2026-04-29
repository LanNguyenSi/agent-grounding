// Mode resolution. Order: ENV → in-prompt marker → default fast_confirm.
// ENV wins because operators set it consciously; markers are user-side
// per-prompt escalation; default is the lowest-friction choice.

export type Mode = "fast_confirm" | "grill_me";

export interface ModeEnv {
  UNDERSTANDING_GATE_MODE?: string;
}

// Bare form requires a separator (`grill me`, `grill-me`, `grill_me`); the
// slash form `/grill` is allowed alone and may optionally carry `-me`/`_me`.
// Without the required separator on the bare form, "grillme" would over-fire.
const MARKER_PATTERN = /(^|[^a-z])(grill[\s\-_]me|\/grill([\s\-_]?me)?)\b/i;

export function pickMode(prompt: string, env: ModeEnv = {}): Mode {
  const envMode = env.UNDERSTANDING_GATE_MODE?.trim().toLowerCase();
  if (envMode === "fast_confirm" || envMode === "grill_me") {
    return envMode;
  }
  if (typeof prompt === "string" && MARKER_PATTERN.test(prompt)) {
    return "grill_me";
  }
  return "fast_confirm";
}
