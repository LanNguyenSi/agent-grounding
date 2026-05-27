// Public surface of the runtime-reality PreToolUse policy.
//
// Imported by:
// - the entrypoint binary in this package (`pre-tool-use.ts`)
// - any test or alternative wrapper that wants to plug in a custom
//   probe / trigger set without re-implementing the handler

export {
  handlePolicyPreToolUse,
  type Decision,
  type HandlerDeps,
  type HandlerResult,
  type PolicyEnv,
  type PolicyPayload,
  type Probe,
} from "./handle-pre-tool-use.js";
export {
  DEFAULT_TRIGGERS,
  extractCommand,
  matchTrigger,
  type ToolCall,
  type Trigger,
  type TriggerCategory,
} from "./triggers.js";
export {
  defaultExpectationsDir,
  expectationsPathFor,
  loadExpectations,
  parseExpectationsFile,
  type ExpectationsFile,
  type ExpectationsLoadResult,
} from "./expectations.js";
export {
  AUDIT_LOG_FILENAME,
  createJsonlAuditWriter,
  formatAuditLine,
  resolveDefaultAuditLogPath,
  type AppendAudit,
  type AuditEnvOverrides,
  type AuditEvent,
  type AuditEventKind,
  type AuditSeverity,
} from "./audit.js";
