// Self-test for the shared schema-rejection assertion.
//
// expectValidationError guards 16 assertions across the two MCP roundtrip
// suites. It has to tolerate two SDK message formats, and "tolerant" is
// exactly how an assertion helper gets quietly hollowed out. These tests pin
// the tolerance to what it is allowed to be.
//
// The false-positive cases below are not hypothetical. An earlier version
// matched the field with /\bat\s+<field>\b/, which also matches zod's own
// prose ("String must contain at most 4096 character(s) at evidence"), so a
// test asserting a field named "most" passed against unmutated production
// code. That hole is what the `\s*(?:\n|$)` anchor closes, and what the
// "rejects prose words" cases below keep closed.

import { describe, expect, it } from 'vitest';

import { expectValidationError } from './expect-validation-error.js';

// Real message shapes, copied from live SDK output rather than invented.
const COMPACT = (body: string) => ({
  isError: true as const,
  content: [{ type: 'text', text: `MCP error -32602: Input validation error: ${body}` }],
});

const compactSingle = COMPACT('Invalid arguments for tool grounding_start: Required at keyword');
const compactProse = COMPACT(
  'Invalid arguments for tool hypothesis_evidence: String must contain at most 4096 character(s) at evidence',
);
const compactMulti = COMPACT(
  'Invalid arguments for tool ledger_add: Required at type\nRequired at confidence',
);
const legacy = COMPACT(
  'Invalid arguments for tool grounding_start: [\n  {\n    "code": "invalid_type",\n    "path": [\n      "keyword"\n    ],\n    "message": "Required"\n  }\n]',
);
const legacyProse = COMPACT(
  'Invalid arguments for tool hypothesis_evidence: [\n  {\n    "code": "too_big",\n    "path": [\n      "evidence"\n    ],\n    "message": "String must contain at most 4096 character(s)"\n  }\n]',
);

describe('expectValidationError', () => {
  describe('accepts a genuine rejection', () => {
    it('compact format (SDK >=1.30)', () => {
      expectValidationError(compactSingle, 'grounding_start', 'keyword');
    });

    it('compact format with prose containing "at most"', () => {
      expectValidationError(compactProse, 'hypothesis_evidence', 'evidence');
    });

    it('compact format, multiple issues, matches either field', () => {
      expectValidationError(compactMulti, 'ledger_add', 'type');
      expectValidationError(compactMulti, 'ledger_add', 'confidence');
    });

    it('legacy format (SDK <=1.29)', () => {
      expectValidationError(legacy, 'grounding_start', 'keyword');
    });
  });

  describe('rejects a wrong field', () => {
    it('compact format', () => {
      expect(() => expectValidationError(compactSingle, 'grounding_start', 'problem')).toThrow();
    });

    it('legacy format', () => {
      expect(() => expectValidationError(legacy, 'grounding_start', 'problem')).toThrow();
    });

    it('legacy format: a structured wrong-field failure must propagate, not fall through to the prose match', () => {
      // This is the regression guard for the swallowed-assertion bug: the
      // JSON path says "evidence", and the message prose says "at most". If
      // the structured assertion is caught and downgraded, "most" passes.
      expect(() => expectValidationError(legacyProse, 'hypothesis_evidence', 'most')).toThrow();
    });
  });

  describe('rejects prose words that are not fields', () => {
    // These two are the exact vectors that passed against unmutated code
    // before the anchor was added. If either stops throwing, the helper has
    // been weakened back and the 16 roundtrip assertions are no longer
    // trustworthy.
    it('"most" is not a field, even though the message contains "at most"', () => {
      expect(() => expectValidationError(compactProse, 'hypothesis_evidence', 'most')).toThrow();
    });

    it('"least" is not a field', () => {
      const atLeast = COMPACT(
        'Invalid arguments for tool verify_memory_reference: Array must contain at least 1 element(s) at value',
      );
      expect(() => expectValidationError(atLeast, 'verify_memory_reference', 'least')).toThrow();
    });
  });

  describe('rejects non-rejections', () => {
    it('isError false', () => {
      expect(() =>
        expectValidationError({ ...compactSingle, isError: false }, 'grounding_start', 'keyword'),
      ).toThrow();
    });

    it('empty content', () => {
      expect(() =>
        expectValidationError({ isError: true, content: [] }, 'grounding_start', 'keyword'),
      ).toThrow();
    });

    it('a runtime error that merely mentions the field is not a schema rejection', () => {
      // Without the -32602 assertion this passes: it is what a handler throws
      // once a field stops being rejected at the schema boundary, which is
      // precisely the regression these tests exist to catch.
      const runtime = {
        isError: true as const,
        content: [
          { type: 'text', text: 'grounding-wrapper: keyword must be a string, got undefined at keyword' },
        ],
      };
      expect(() => expectValidationError(runtime, 'grounding_start', 'keyword')).toThrow();
    });

    it('a rejection from a different tool whose name shares a prefix', () => {
      const other = COMPACT('Invalid arguments for tool claim_evaluate_from_session: Required at id');
      expect(() => expectValidationError(other, 'claim_evaluate', 'id')).toThrow();
    });
  });
});
