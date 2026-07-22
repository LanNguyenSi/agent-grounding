// Parses an agent-emitted Understanding Report (markdown) into a typed,
// schema-validated object. Pure: no fs, no network. Phase 1.1.
//
// Contract:
//   parseReport(markdown, defaults?) -> { ok: true, report } | { ok: false, error }
//
// Markdown shape: ten numbered or named sections matching the keys below
// (heading level # / ## / ### all accepted, optional "1." numeric prefix).
// Body of a list-typed section is a unordered/ordered list; body of a
// paragraph-typed section is one or more lines, joined with single newlines.
//
// Metadata fields (taskId, mode, riskLevel, requiresHumanApproval, createdAt)
// usually come from the caller via `defaults`, since the v0 prompts
// (full / fast_confirm / grill_me) do not ask the agent to emit them. An
// optional `## Metadata` section in the markdown (`key: value` per line)
// overrides defaults if present, including taskId: defaults.taskId is pure
// gap-fill, used only when the markdown has no `taskid` key. To BIND the
// persisted taskId regardless of the markdown -- e.g. so an agent-authored
// `taskid` can never redirect a report onto another task's approval -- pass
// `defaults.boundTaskId` instead; it wins over both the markdown's `taskid`
// key and defaults.taskId (see the merge-order comment below,
// agent-grounding e2e065e6, and agent-tasks 2078873e, which restored the
// gap-fill contract that PR #143 / 0.4.7-0.4.8 broke). approvalStatus is
// always forced to "pending" by parseReport regardless of defaults or
// metadata; only the operator CLI approve flow (withApprovalStatus) may
// flip it.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  UNDERSTANDING_REPORT_SCHEMA,
  UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM,
} from "../schema/report-schema.js";
import type {
  RiskLevel,
  UnderstandingGateMode,
  UnderstandingReport,
} from "../schema/types.js";

// Precedence for the persisted taskId (highest wins):
//   1. boundTaskId       -- binds regardless of the markdown; use this to
//                            attribute a report to a specific task/session
//                            (both adapters do). Never agent-settable.
//   2. markdown `taskid` -- the `## Metadata` block's key, like every other
//                            metadata field.
//   3. taskId             -- gap-fill only: used when the markdown has no
//                            `taskid` key at all.
export type ParseDefaults = {
  taskId?: string;
  boundTaskId?: string;
  mode?: UnderstandingGateMode;
  riskLevel?: RiskLevel;
  requiresHumanApproval?: boolean;
  createdAt?: string;
};

// `missing` semantics by `reason`:
//   no_report_found  -> all required section keys
//   missing_sections -> the section keys that could not be located/parsed
//   schema_violation -> required-property names from the ajv errors
//   invalid_metadata -> empty
export type ParseError = {
  reason:
    | "no_report_found"
    | "missing_sections"
    | "schema_violation"
    | "invalid_metadata";
  missing: string[];
  schemaErrors: { path: string; message: string }[];
  message: string;
};

export type ParseResult =
  | { ok: true; report: UnderstandingReport }
  | { ok: false; error: ParseError };

type SectionKind = "list" | "paragraph";
type SectionKey = Exclude<
  keyof UnderstandingReport,
  | "taskId"
  | "mode"
  | "riskLevel"
  | "requiresHumanApproval"
  | "approvalStatus"
  | "createdAt"
  | "approvedAt"
  | "approvedBy"
>;

type SectionSpec = {
  key: SectionKey;
  kind: SectionKind;
  // Lower-cased title fragments that map to this section. Match is "starts
  // with" after stripping a leading numeric prefix and punctuation, so
  // "Derived todos / specs" and "Derived todos" both match.
  aliases: string[];
};

const SECTIONS: SectionSpec[] = [
  {
    key: "currentUnderstanding",
    kind: "paragraph",
    aliases: ["my current understanding", "current understanding"],
  },
  { key: "intendedOutcome", kind: "paragraph", aliases: ["intended outcome"] },
  {
    key: "derivedTodos",
    kind: "list",
    aliases: ["derived todos", "todos", "derived todos / specs"],
  },
  {
    key: "acceptanceCriteria",
    kind: "list",
    aliases: ["acceptance criteria"],
  },
  { key: "assumptions", kind: "list", aliases: ["assumptions"] },
  { key: "openQuestions", kind: "list", aliases: ["open questions"] },
  { key: "outOfScope", kind: "list", aliases: ["out of scope"] },
  { key: "risks", kind: "list", aliases: ["risks"] },
  {
    key: "verificationPlan",
    kind: "list",
    aliases: ["verification plan", "verification"],
  },
  // Section 10 (v0.4.0). The Stop-capture parser walks SECTIONS in order;
  // adding priorArt at the end keeps Section 10's numbering aligned with
  // the prompt templates. fast_confirm: the relaxed schema drops it from
  // required so a fast_confirm report (no `# Understanding Report`
  // heading, five bullets) still parses.
  { key: "priorArt", kind: "list", aliases: ["prior art"] },
];

const METADATA_ALIASES = ["metadata"];

// Pre-compiled validators. Module-level because compilation is the slow
// step and the schemas are static. Two schemas: the strict default and a
// fast_confirm variant that drops derivedTodos + acceptanceCriteria from
// `required` (agent-tasks/eaac8fe5).
let cachedValidator: ValidateFunction | null = null;
let cachedFastConfirmValidator: ValidateFunction | null = null;
function getValidator(mode: UnderstandingGateMode | undefined): ValidateFunction {
  if (mode === "fast_confirm") {
    if (cachedFastConfirmValidator) return cachedFastConfirmValidator;
    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    cachedFastConfirmValidator = ajv.compile(
      UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM,
    );
    return cachedFastConfirmValidator;
  }
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  cachedValidator = ajv.compile(UNDERSTANDING_REPORT_SCHEMA);
  return cachedValidator;
}

// Fast-confirm bullet → section mapping (agent-tasks/eaac8fe5). The
// fast_confirm prompt emits 5 single-line bullets with no
// `# Understanding Report` heading or 9-section structure. Map prefixes
// to the corresponding canonical section so the existing collector +
// validator pipeline (with the fast_confirm-relaxed schema) can persist
// a parseable Report end-to-end.
//
// "I will do:" maps to intendedOutcome (paragraph), NOT derivedTodos:
// the prompt asks for a one-line summary of intent, not a todo list.
// The fast_confirm-relaxed schema drops derivedTodos + acceptanceCriteria
// from required for exactly this reason.
//
// Match is case-insensitive, prefix-anchored after the leading "- " /
// "* " / "+ " marker (plus tolerated "1." enumeration). The remainder
// of the line after the colon is the bullet value.
const FAST_CONFIRM_BULLET_RE =
  /^\s{0,3}(?:[-*+]|\d+[.)])\s+([^:]+?)\s*:\s*(.*)$/;

type FastConfirmKey =
  | "currentUnderstanding"
  | "intendedOutcome"
  | "outOfScope"
  | "verificationPlan"
  | "assumptions";

const FAST_CONFIRM_PREFIX_MAP: Array<{ prefix: RegExp; key: FastConfirmKey }> = [
  { prefix: /^i understood the task as\b/i, key: "currentUnderstanding" },
  { prefix: /^i will do\b/i, key: "intendedOutcome" },
  { prefix: /^i will not touch\b/i, key: "outOfScope" },
  { prefix: /^i will verify by\b/i, key: "verificationPlan" },
  { prefix: /^assumptions\b/i, key: "assumptions" },
];

const FAST_CONFIRM_LIST_KEYS = new Set<FastConfirmKey>([
  "outOfScope",
  "verificationPlan",
  "assumptions",
]);

function parseFastConfirmBullets(
  markdown: string,
): Partial<UnderstandingReport> | null {
  const collected: Record<FastConfirmKey, string> = {
    currentUnderstanding: "",
    intendedOutcome: "",
    outOfScope: "",
    verificationPlan: "",
    assumptions: "",
  };
  let anyMatched = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const m = rawLine.match(FAST_CONFIRM_BULLET_RE);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2].trim();
    if (value.length === 0) continue;
    for (const { prefix, key } of FAST_CONFIRM_PREFIX_MAP) {
      if (prefix.test(label) && collected[key].length === 0) {
        collected[key] = value;
        anyMatched = true;
        break;
      }
    }
  }
  if (!anyMatched) return null;
  const out: Partial<UnderstandingReport> = {};
  for (const key of Object.keys(collected) as FastConfirmKey[]) {
    const value = collected[key];
    if (value.length === 0) continue;
    if (FAST_CONFIRM_LIST_KEYS.has(key)) {
      (out as Record<string, unknown>)[key] = [value];
    } else {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function parseReport(
  markdown: string,
  defaults: ParseDefaults = {},
): ParseResult {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    return {
      ok: false,
      error: {
        reason: "no_report_found",
        missing: SECTIONS.map((s) => s.key),
        schemaErrors: [],
        message: "Empty markdown input",
      },
    };
  }

  const sections = splitIntoSections(markdown);

  let collected: Partial<UnderstandingReport> = {};
  const missing: string[] = [];

  // Fast-confirm fallback: when the markdown has no `# Understanding Report`
  // heading or 9-section structure AND the mode is fast_confirm, attempt
  // to parse the 5-bullet shape the fast_confirm prompt emits. The
  // existing section-walk below still runs for the canonical sections;
  // this just pre-seeds `collected` so an unstructured fast_confirm
  // response persists end-to-end (agent-tasks/eaac8fe5).
  const isFastConfirm = defaults.mode === "fast_confirm";
  if (isFastConfirm && sections.length === 0) {
    const fc = parseFastConfirmBullets(markdown);
    if (fc) collected = fc;
  }

  for (const spec of SECTIONS) {
    // Skip section keys already collected from the fast_confirm fallback.
    // The canonical-section walk would otherwise mark them as missing.
    if ((collected as Record<string, unknown>)[spec.key] !== undefined) continue;
    const body = pickSection(sections, spec.aliases);
    if (body == null) {
      // In fast_confirm mode, the four sections the prompt never emits
      // (derivedTodos, acceptanceCriteria, openQuestions, risks) are
      // absent by design. The relaxed schema drops them from `required`.
      // Don't mark them missing when the markdown also doesn't carry
      // them. If a fast_confirm-mode agent DID emit them, the section
      // walk above still collects them via the `body != null` path.
      if (
        isFastConfirm &&
        (spec.key === "derivedTodos" ||
          spec.key === "acceptanceCriteria" ||
          spec.key === "openQuestions" ||
          spec.key === "risks" ||
          spec.key === "priorArt")
      ) {
        continue;
      }
      missing.push(spec.key);
      continue;
    }
    if (spec.kind === "list") {
      const items = parseList(body);
      if (items.length === 0) {
        missing.push(spec.key);
        continue;
      }
      (collected as Record<string, unknown>)[spec.key] = items;
    } else {
      const text = normalizeParagraph(body);
      if (text.length === 0) {
        missing.push(spec.key);
        continue;
      }
      (collected as Record<string, unknown>)[spec.key] = text;
    }
  }

  const metadataBody = pickSection(sections, METADATA_ALIASES);
  let metadataFromMarkdown: Partial<UnderstandingReport> = {};
  if (metadataBody != null) {
    const parsed = parseMetadataBlock(metadataBody);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          reason: "invalid_metadata",
          missing: [],
          schemaErrors: [],
          message: parsed.message,
        },
      };
    }
    metadataFromMarkdown = parsed.value;
  }

  // taskId binding (agent-grounding e2e065e6, block-direction integrity
  // finding from the adversarial review of the C1 self-approval fix,
  // agent-tasks 3a994d92; restored to gap-fill + moved to the explicit
  // boundTaskId field in agent-tasks 2078873e, see the ParseDefaults
  // docstring). When the caller supplies a boundTaskId, it must win over an
  // agent-authored `taskid` key: the Claude Code and opencode adapters
  // (handle-stop.ts / persist-report.ts) always pass boundTaskId derived
  // from UNDERSTANDING_GATE_TASK_ID or the runtime's own session id, so in
  // production this makes the persisted taskId fully adapter/session-bound.
  //
  // Without this, an agent-emitted `## Metadata\ntaskid: <other task>`
  // could park its own (always-forced-pending) report under ANOTHER task's
  // id. findLatestForTask (core/approval.ts) picks the most recently
  // created/approved entry matching a taskId, so a newer forged pending
  // entry would outrank that other task's already-approved entry and
  // downgrade it back to pending. This is a denial-of-service / integrity
  // break, never an allow-bypass: PreToolUse enforcement
  // (handle-pre-tool-use.ts) looks up the active task strictly by
  // env.UNDERSTANDING_GATE_TASK_ID || sessionId, never by a report's own
  // taskId field, so this metadata value can never grant a write it
  // shouldn't.
  //
  // The markdown's `taskid` key is left live as an override over
  // defaults.taskId ONLY when the caller supplies no boundTaskId at all
  // (defaults.boundTaskId === undefined) — that is defaults.taskId's
  // documented gap-fill role, and it's also what keeps
  // `parseReport(markdown)` — used throughout this package's own parser
  // tests with no adapter in front of it — working without having to
  // thread an explicit boundTaskId through every call site that isn't
  // testing this binding.
  // The unconditional override below (merged["taskId"] = boundTaskId) is the
  // load-bearing protection; this strip is a fail-closed backstop — if the
  // override ever regresses, a forged markdown `taskid` becomes a missing
  // taskId (schema violation, report not persisted) instead of a silent
  // victim-id persist.
  if (defaults.boundTaskId !== undefined) {
    delete (metadataFromMarkdown as Record<string, unknown>)["taskId"];
  }

  // Merge order (lowest -> highest precedence):
  //   1. baseline (requiresHumanApproval=true)
  //   2. caller-supplied defaults (taskId here is gap-fill only, see the
  //      ParseDefaults docstring)
  //   3. inline `## Metadata` block from the markdown (its `taskid` key
  //      overrides defaults.taskId — unless boundTaskId is set, in which
  //      case it was already stripped above)
  //   4. parsed section bodies
  //   5. defaults.boundTaskId, applied below: wins over everything above,
  //      including defaults.taskId itself, whenever the caller supplies it
  // Section keys (collected) and metadata keys never overlap thanks to the
  // SectionKey type-level Exclude<>, so the order is unambiguous, EXCEPT
  // taskId, whose markdown key was stripped above whenever the caller
  // supplied a boundTaskId — see the taskId binding comment above.
  const merged: Record<string, unknown> = {
    requiresHumanApproval: true,
    ...stripUndefined(defaults as Record<string, unknown>),
    ...stripUndefined(metadataFromMarkdown as Record<string, unknown>),
    ...collected,
    // parseReport output is always pending; only the operator CLI approve flow
    // (withApprovalStatus) may flip approvalStatus to "approved". This
    // hard-reset runs last so no spread above can override it.
    approvalStatus: "pending",
  };
  if (defaults.boundTaskId !== undefined) {
    merged["taskId"] = defaults.boundTaskId;
  }
  // approvedAt and approvedBy are operator-set fields; remove them
  // defensively in case a dynamic caller sneaks them through via defaults.
  // boundTaskId is a parser-input-only field, never part of the persisted
  // report shape (the schema's additionalProperties:false would reject it).
  delete merged["approvedAt"];
  delete merged["approvedBy"];
  delete merged["boundTaskId"];

  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        reason: "missing_sections",
        missing,
        schemaErrors: [],
        message: `Missing required sections: ${missing.join(", ")}`,
      },
    };
  }

  // Pick the mode-appropriate validator. fast_confirm uses a relaxed
  // schema that drops derivedTodos + acceptanceCriteria from required.
  const validator = getValidator(
    (merged["mode"] as UnderstandingGateMode | undefined) ?? defaults.mode,
  );
  if (!validator(merged)) {
    return {
      ok: false,
      error: {
        reason: "schema_violation",
        missing: missingFromAjv(validator.errors ?? []),
        schemaErrors: (validator.errors ?? []).map(formatAjvError),
        message: "Schema validation failed",
      },
    };
  }

  return { ok: true, report: merged as unknown as UnderstandingReport };
}

// --- internals ----------------------------------------------------------

type Section = { title: string; titleKey: string; body: string };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
// Match an opening or closing fence: ``` or ~~~ (CommonMark allows 3+).
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

// A line that is ONLY a bold label, e.g. `**Derived Todos:**`, with an
// optional colon inside or outside the closing `**` and nothing else after
// it. A line like `**Note:** some text` does NOT match because the trailing
// content fails `\s*$`. Used so an agent that writes sections as bold labels
// instead of `## Heading` still parses (discovery finding C1).
const BOLD_LABEL_RE = /^\s{0,3}\*\*([^*]+?):?\*\*:?\s*$/;
// All known section aliases (including the metadata block), lower-cased to
// match normalizeTitle output. A bold-label line is promoted to a section
// header ONLY when its normalized title is in this set; this guards against
// inline bold prose whose title is not a known section (e.g. `**Note:**`)
// splitting a section body.
const KNOWN_ALIASES: ReadonlySet<string> = new Set([
  ...SECTIONS.flatMap((s) => s.aliases),
  ...METADATA_ALIASES,
]);

// Recognise a bold-label section header. Returns the title + normalized key
// when the line is a bare bold label naming a known section, else null.
function matchBoldLabelHeader(
  line: string,
): { title: string; titleKey: string } | null {
  const m = line.match(BOLD_LABEL_RE);
  if (!m) return null;
  const title = m[1].replace(/:$/, "").trim();
  const titleKey = normalizeTitle(title);
  if (!KNOWN_ALIASES.has(titleKey)) return null;
  return { title, titleKey };
}

function splitIntoSections(markdown: string): Section[] {
  // Strip a UTF-8 BOM if present so the first heading isn't shadowed.
  const stripped =
    markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const lines = stripped.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { title: string; titleKey: string; body: string[] } | null =
    null;
  // CommonMark fenced-code-block tracker. Headings inside a fence are
  // verbatim content (e.g. the agent quoting the prompt template) and must
  // not be promoted to real sections.
  let fenceMarker: string | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0]; // ` or ~
      if (fenceMarker == null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = null;
      }
      if (current) current.body.push(line);
      continue;
    }
    if (fenceMarker != null) {
      if (current) current.body.push(line);
      continue;
    }
    const m = line.match(HEADING_RE);
    const boldHeader = m == null ? matchBoldLabelHeader(line) : null;
    if (m) {
      if (current) {
        sections.push({
          title: current.title,
          titleKey: current.titleKey,
          body: current.body.join("\n"),
        });
      }
      const title = m[2].trim();
      current = { title, titleKey: normalizeTitle(title), body: [] };
    } else if (boldHeader) {
      if (current) {
        sections.push({
          title: current.title,
          titleKey: current.titleKey,
          body: current.body.join("\n"),
        });
      }
      current = {
        title: boldHeader.title,
        titleKey: boldHeader.titleKey,
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    sections.push({
      title: current.title,
      titleKey: current.titleKey,
      body: current.body.join("\n"),
    });
  }
  return sections;
}

// Strip a leading numeric prefix ("1.", "1)"), lower-case, collapse internal
// whitespace. "### 1. My Current Understanding" -> "my current understanding".
function normalizeTitle(raw: string): string {
  return raw
    .replace(/^\s*\d+[.)]\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// First-match wins. With the closed alias set in SECTIONS, duplicate
// section headings in a single report are unusual and almost always
// indicate the agent retried mid-stream; the earlier draft is dropped on
// purpose by taking the first.
function pickSection(sections: Section[], aliases: string[]): string | null {
  for (const s of sections) {
    for (const alias of aliases) {
      if (s.titleKey === alias) {
        return s.body;
      }
    }
  }
  return null;
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const INDENTED_RE = /^\s+\S/;

function parseList(body: string): string[] {
  const items: string[] = [];
  let current: string | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const itemMatch = line.match(LIST_ITEM_RE);
    if (itemMatch) {
      if (current != null) items.push(current.trim());
      current = itemMatch[1];
      continue;
    }
    if (line.trim().length === 0) {
      // Blank lines between items are tolerated; we keep `current` open
      // so that an indented continuation after the blank line still
      // attaches to the previous item.
      continue;
    }
    if (current != null && INDENTED_RE.test(line)) {
      // Indented wrap of the previous item.
      current += " " + line.trim();
      continue;
    }
    // A non-blank, non-indented line that isn't a new list item ends the
    // current item and is dropped (stray prose between bullets is not
    // silently absorbed).
    if (current != null) {
      items.push(current.trim());
      current = null;
    }
  }
  if (current != null) items.push(current.trim());
  return items.filter((s) => s.length > 0);
}

function normalizeParagraph(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

const METADATA_LINE_RE = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/;
// Keys the agent may supply via an inline `## Metadata` block.
// approvalstatus is intentionally absent: parseReport always forces
// approvalStatus to "pending" (see merge below). Only the operator CLI
// approve flow (withApprovalStatus) may flip the field to "approved".
// Unrecognized keys in the block are silently ignored by parseMetadataBlock.
const METADATA_KEYS: Record<
  string,
  { target: keyof UnderstandingReport; coerce: (v: string) => unknown }
> = {
  taskid: { target: "taskId", coerce: (v) => v },
  mode: { target: "mode", coerce: (v) => v },
  risklevel: { target: "riskLevel", coerce: (v) => v },
  requireshumanapproval: {
    target: "requiresHumanApproval",
    coerce: (v) => coerceBoolean(v),
  },
  createdat: { target: "createdAt", coerce: (v) => v },
};

type MetadataResult =
  | { ok: true; value: Partial<UnderstandingReport> }
  | { ok: false; message: string };

function parseMetadataBlock(body: string): MetadataResult {
  const out: Record<string, unknown> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) continue;
    if (/^\s*```/.test(rawLine)) continue; // tolerate fenced ```yaml wrappers
    const m = rawLine.match(METADATA_LINE_RE);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/_/g, "");
    const spec = METADATA_KEYS[key];
    if (!spec) continue;
    const value = m[2];
    const coerced = spec.coerce(value);
    if (coerced instanceof Error) {
      return { ok: false, message: coerced.message };
    }
    out[spec.target] = coerced;
  }
  return { ok: true, value: out as Partial<UnderstandingReport> };
}

function coerceBoolean(raw: string): boolean | Error {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return new Error(`Cannot coerce "${raw}" to boolean`);
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function formatAjvError(err: ErrorObject): { path: string; message: string } {
  const path = err.instancePath || "/";
  return { path, message: err.message ?? String(err) };
}

function missingFromAjv(errs: ErrorObject[]): string[] {
  const out: string[] = [];
  for (const e of errs) {
    if (e.keyword === "required") {
      const prop = (e.params as { missingProperty?: string }).missingProperty;
      if (prop) out.push(prop);
    }
  }
  return out;
}
