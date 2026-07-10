import { describe, expect, it, vi } from "vitest";
import {
  looksLikeReportAttempt,
  selectReportText,
} from "../src/adapters/claude-code/handle-stop.js";

const REPORT = [
  "## Understanding Report",
  "",
  "**Metadata**",
  "",
  "taskId: t-1",
  "mode: grill_me",
  "riskLevel: low",
].join("\n");

const FAST_CONFIRM = [
  "- I understood the task as: add a logout button",
  "- I will do: edit Header.tsx",
  "- I will not touch: the router",
  "- I will verify by: running the tests",
  "- Assumptions: none",
].join("\n");

const CLOSING_SENTENCE = "Done. The tests pass and the branch is pushed.";

describe("looksLikeReportAttempt", () => {
  it("recognises a heading-marked report and a fast_confirm bullet block", () => {
    expect(looksLikeReportAttempt(REPORT)).toBe(true);
    expect(looksLikeReportAttempt("# Understanding Report\n\nprose")).toBe(true);
    expect(looksLikeReportAttempt(FAST_CONFIRM)).toBe(true);
  });

  it("rejects ordinary prose, casual mentions, and empty text", () => {
    expect(looksLikeReportAttempt(CLOSING_SENTENCE)).toBe(false);
    expect(looksLikeReportAttempt("I'll write an Understanding Report next")).toBe(false);
    expect(looksLikeReportAttempt("")).toBe(false);
  });
});

describe("selectReportText (task 0a3227fe)", () => {
  // AC 1: the regression that made this whole path dead. The agent wrote
  // the report mid-turn, then kept working, so the payload's
  // last_assistant_message is the closing sentence and the report only
  // exists in the trailing assistant run of the transcript.
  it("falls back to the transcript when the payload is not a report", () => {
    const readTranscript = vi.fn(() => `${REPORT}\n\n${CLOSING_SENTENCE}`);
    const out = selectReportText(CLOSING_SENTENCE, readTranscript);
    expect(out.source).toBe("transcript");
    expect(out.text).toContain("## Understanding Report");
    expect(readTranscript).toHaveBeenCalledTimes(1);
  });

  // AC 2: the 0.2.1 race fix must survive. A report delivered as the
  // final message is taken from the payload without touching the
  // transcript, which under `claude -p` may not be flushed yet.
  it("prefers the payload when it IS the report, and never reads the transcript", () => {
    const readTranscript = vi.fn(() => "should not be read");
    const out = selectReportText(REPORT, readTranscript);
    expect(out.source).toBe("payload");
    expect(out.text).toBe(REPORT);
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it("takes a fast_confirm payload without reading the transcript", () => {
    const readTranscript = vi.fn(() => "");
    const out = selectReportText(FAST_CONFIRM, readTranscript);
    expect(out.source).toBe("payload");
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it("finds a fast_confirm block in the transcript when the payload is prose", () => {
    const out = selectReportText(CLOSING_SENTENCE, () => FAST_CONFIRM);
    expect(out.source).toBe("transcript");
    expect(out.text).toBe(FAST_CONFIRM);
  });

  it("treats an empty payload as 'not provided' and reads the transcript", () => {
    const out = selectReportText("", () => REPORT);
    expect(out.source).toBe("transcript");
    expect(out.text).toBe(REPORT);
  });

  // When no source carries a report the caller still needs text to hand
  // to its own no_report / parse-error accounting. Payload wins because
  // it is the cheaper, race-free source.
  it("returns the payload text when neither source looks like a report", () => {
    const out = selectReportText(CLOSING_SENTENCE, () => "some transcript prose");
    expect(out.source).toBe("none");
    expect(out.text).toBe(CLOSING_SENTENCE);
  });

  it("returns the transcript text when the payload is empty and neither is a report", () => {
    const out = selectReportText("", () => "some transcript prose");
    expect(out.source).toBe("none");
    expect(out.text).toBe("some transcript prose");
  });

  it("returns empty text when both sources are empty", () => {
    const out = selectReportText("", () => "");
    expect(out.source).toBe("none");
    expect(out.text).toBe("");
  });

  // A transcript read that throws (missing/unreadable file) must not
  // escape: stop.ts's extractLastAssistantText already returns "" on
  // failure, and this asserts we never call it in the payload fast path.
  it("does not read the transcript at all when the payload is a report (no IO on the hot path)", () => {
    const readTranscript = vi.fn(() => {
      throw new Error("transcript must not be touched");
    });
    expect(() => selectReportText(REPORT, readTranscript)).not.toThrow();
  });
});
