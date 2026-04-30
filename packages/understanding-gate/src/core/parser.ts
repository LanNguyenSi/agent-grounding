// Parses an agent-emitted Understanding Report (markdown) into a typed,
// schema-validated object. Pure: no fs, no network. Phase 1.1.
//
// Contract:
//   parseReport(markdown, defaults?) -> { ok: true, report } | { ok: false, error }
//
// Markdown shape: nine numbered or named sections matching the keys below
// (heading level # / ## / ### all accepted, optional "1." numeric prefix).
// Body of a list-typed section is a unordered/ordered list; body of a
// paragraph-typed section is one or more lines, joined with single newlines.
//
// Metadata fields (taskId, mode, riskLevel, requiresHumanApproval,
// approvalStatus, createdAt) usually come from the caller via `defaults`,
// since the v0 prompts (full / fast_confirm / grill_me) do not ask the agent
// to emit them. An optional `## Metadata` section in the markdown — `key: value`
// per line — overrides defaults if present.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { UNDERSTANDING_REPORT_SCHEMA } from "../schema/report-schema.js";
import type {
  ApprovalStatus,
  RiskLevel,
  UnderstandingGateMode,
  UnderstandingReport,
} from "../schema/types.js";

export type ParseDefaults = {
  taskId?: string;
  mode?: UnderstandingGateMode;
  riskLevel?: RiskLevel;
  requiresHumanApproval?: boolean;
  approvalStatus?: ApprovalStatus;
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
];

const METADATA_ALIASES = ["metadata"];

// Pre-compiled validator. Module-level because compilation is the slow step
// and the schema is static.
let cachedValidator: ValidateFunction | null = null;
function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  cachedValidator = ajv.compile(UNDERSTANDING_REPORT_SCHEMA);
  return cachedValidator;
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

  const collected: Partial<UnderstandingReport> = {};
  const missing: string[] = [];

  for (const spec of SECTIONS) {
    const body = pickSection(sections, spec.aliases);
    if (body == null) {
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

  // Merge order (lowest -> highest precedence):
  //   1. baseline (requiresHumanApproval=true, approvalStatus=pending)
  //   2. caller-supplied defaults
  //   3. inline `## Metadata` block from the markdown
  //   4. parsed section bodies
  // Section keys (collected) and metadata keys never overlap thanks to the
  // SectionKey type-level Exclude<>, so the order is unambiguous.
  const merged: Record<string, unknown> = {
    requiresHumanApproval: true,
    approvalStatus: "pending",
    ...stripUndefined(defaults as Record<string, unknown>),
    ...stripUndefined(metadataFromMarkdown as Record<string, unknown>),
    ...collected,
  };

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

  const validator = getValidator();
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
  approvalstatus: { target: "approvalStatus", coerce: (v) => v },
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
