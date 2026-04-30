export { isTaskLike } from "./classifier.js";
export { pickMode, type Mode, type ModeEnv } from "./mode.js";
export {
  getPromptSnippet,
  FAST_CONFIRM_PROMPT,
  GRILL_ME_PROMPT,
  FULL_PROMPT,
} from "./prompts.js";
export { UNDERSTANDING_REPORT_SCHEMA } from "./schema/report-schema.js";
export type {
  UnderstandingReport,
  UnderstandingGateMode,
  RiskLevel,
  ApprovalStatus,
} from "./schema/types.js";
export { parseReport } from "./core/parser.js";
export type {
  ParseResult,
  ParseError,
  ParseDefaults,
} from "./core/parser.js";
export {
  saveReport,
  listReports,
  loadReport,
  resolveReportDir,
  DEFAULT_REPORT_DIR,
  REPORT_DIR_ENV,
} from "./core/persistence.js";
export type {
  SaveOptions,
  SaveResult,
  ReportEntry,
  ListOptions,
  LoadResult,
  LoadError,
} from "./core/persistence.js";
export {
  persistReportPlugin,
  default as opencodePersistReportPlugin,
} from "./adapters/opencode/persist-report-plugin.js";
export {
  registerReportHypotheses,
  findHypothesesForReport,
  PREFIX_RE as HYPOTHESIS_BRIDGE_PREFIX_RE,
} from "./core/hypothesis-bridge.js";
export type {
  RegisterResult,
  HypothesisKind,
} from "./core/hypothesis-bridge.js";
