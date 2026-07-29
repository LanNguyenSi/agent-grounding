// Shared assertion for MCP tool-input schema rejections.
//
// Used by grounding-gate-mcp-roundtrip.test.ts and
// hypothesis-mcp-roundtrip.test.ts to assert that a tool call was rejected
// by zod schema validation before any handler code ran.
//
// The MCP SDK's validation-error message format changed between
// @modelcontextprotocol/sdk 1.29 (a JSON array of zod issues, each with a
// `.path`) and 1.30 (a compact "<zod message> at <dotted.path>" string per
// issue, newline-joined — see the SDK's zod-compat.ts:getParseErrorMessage).
// That bump (GHSA-frvp-7c67-39w9, closing an advisory in the transitive
// @hono/node-server) did not change validation behavior, only how the
// rejection is rendered as text.
//
// This helper accepts EITHER message shape and asserts what actually carries
// meaning for a schema-rejection test, so it does not re-flake on the next SDK
// message-format tweak:
//   1. result.isError === true
//   2. the message is a JSON-RPC InvalidParams (-32602) rejection, which is
//      what distinguishes a schema rejection from any other kind of error
//   3. the message identifies the failing tool
//   4. the message names the offending field
//
// On matching the field name, note what does NOT work. An earlier version of
// this helper used /\bat\s+<field>\b/ and described it as a "whole path
// segment" match. It is not: zod's own prose contains "at most" and "at
// least" (e.g. "String must contain at most 4096 character(s) at evidence"),
// so asserting a field named "most" or "least" passed against completely
// unmutated code. The compact format always puts the path LAST in an issue
// line and joins issues with newlines, so anchoring to end-of-line is what
// actually pins the match to the path rather than to the message prose.
//
// expect-validation-error.self.test.ts pins all of this, including the
// false-positive vectors, so the property is enforced rather than merely
// asserted in a comment.

import { expect } from 'vitest';

export interface ToolTextResponse {
  content?: { type: string; text: string }[];
  isError?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches the field only where the compact format actually puts the path:
// at the end of an issue line. "... at most 4096 character(s) at evidence"
// therefore matches `evidence` and not `most`.
export function compactFieldPattern(field: string): RegExp {
  return new RegExp(`\\bat\\s+${escapeRegExp(field)}\\s*(?:\\n|$)`);
}

export function expectValidationError(raw: unknown, toolName: string, field: string): void {
  const result = raw as ToolTextResponse;
  expect(result.isError).toBe(true);
  const text = result.content?.[0]?.text ?? '';

  // A schema rejection is specifically InvalidParams. Without this, any
  // runtime error that happened to mention the field would satisfy the
  // assertion.
  expect(text).toContain('-32602');
  // Include the trailing colon: this server registers both `claim_evaluate`
  // and `claim_evaluate_from_session`, so a bare substring match on the
  // shorter name would also accept a rejection from the longer one.
  expect(text).toContain(`Invalid arguments for tool ${toolName}:`);

  // Legacy format (SDK <=1.29): a JSON array of zod issues, each carrying a
  // `.path` array. Only the JSON.parse is guarded — an assertion failure here
  // is a genuine wrong-field result and must propagate, not silently fall
  // through to the weaker prose match.
  const jsonStart = text.indexOf('[');
  if (jsonStart > -1) {
    let errors: { path: (string | number)[] }[] | undefined;
    try {
      errors = JSON.parse(text.slice(jsonStart)) as { path: (string | number)[] }[];
    } catch {
      // Not actually a JSON array (e.g. a literal '[' inside an enum message).
      errors = undefined;
    }
    if (Array.isArray(errors) && errors.every((e) => Array.isArray(e?.path))) {
      expect(errors.some((e) => e.path.includes(field))).toBe(true);
      return;
    }
  }

  // Compact format (SDK >=1.30).
  expect(text).toMatch(compactFieldPattern(field));
}
