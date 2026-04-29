// Keyword classifier for "is this user prompt a task-like request?".
// Deterministic, no LLM. Bias: err on firing too often. False-negatives
// (gate skipped on a real task) are more expensive than false-positives
// because the v0 gate is non-blocking, just an injected snippet.

const TASK_VERBS =
  /\b(add|fix|implement|build|create|refactor|remove|change|update|migrate)\b/i;

// `\b` in JS regex is ASCII-only, so it does not anchor before "ä", "ö", "ü".
// Use Unicode-aware lookaround instead so DE verbs match at real word boundaries.
const TASK_VERBS_DE =
  /(?<![a-zäöüß])(ändern|hinzufügen|bauen|umbauen|löschen|ersetzen)(?![a-zäöüß])/i;

const FILE_HINT =
  /\.[a-z]{1,4}\b|\bsrc\/|\bpackage\b|\b(file|module|class|function|datei|modul|klasse|funktion|paket)\b/i;

const LONG_PROMPT_THRESHOLD = 200;

export function isTaskLike(prompt: string): boolean {
  if (typeof prompt !== "string" || prompt.length === 0) return false;
  const verbHit = TASK_VERBS.test(prompt) || TASK_VERBS_DE.test(prompt);
  if (!verbHit) return false;
  return FILE_HINT.test(prompt) || prompt.length > LONG_PROMPT_THRESHOLD;
}
