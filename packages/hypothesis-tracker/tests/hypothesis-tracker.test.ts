import { describe, expect, it, beforeEach } from "vitest";
import {
  createStore,
  addHypothesis,
  findHypothesis,
  addEvidence,
  completeCheck,
  rejectHypothesis,
  supportHypothesis,
  getSummary,
  exportStore,
  importStore,
} from "../src/lib.js";
import type { HypothesisStore } from "../src/lib.js";

let store: HypothesisStore;

beforeEach(() => {
  store = createStore("test-session");
});

describe("createStore", () => {
  it("creates an empty store with session name", () => {
    expect(store.session).toBe("test-session");
    expect(store.hypotheses).toHaveLength(0);
  });

  it("defaults session to 'default'", () => {
    const s = createStore();
    expect(s.session).toBe("default");
  });
});

describe("addHypothesis", () => {
  it("adds a hypothesis with unverified status", () => {
    const h = addHypothesis(store, "gateway is unreachable");
    expect(h.id).toBeTruthy();
    expect(h.text).toBe("gateway is unreachable");
    expect(h.status).toBe("unverified");
    expect(h.evidence).toHaveLength(0);
    expect(h.required_checks).toHaveLength(0);
  });

  it("adds required checks", () => {
    const h = addHypothesis(store, "OOM killer", ["check dmesg", "check /proc/meminfo"]);
    expect(h.required_checks).toHaveLength(2);
    expect(h.required_checks[0]!.description).toBe("check dmesg");
    expect(h.required_checks[0]!.done).toBe(false);
  });

  it("each hypothesis gets a unique id", () => {
    const a = addHypothesis(store, "first");
    const b = addHypothesis(store, "second");
    expect(a.id).not.toBe(b.id);
  });

  it("adds to the store", () => {
    addHypothesis(store, "test");
    expect(store.hypotheses).toHaveLength(1);
  });
});

describe("findHypothesis", () => {
  it("finds a hypothesis by id", () => {
    const h = addHypothesis(store, "network issue");
    expect(findHypothesis(store, h.id)).toBe(h);
  });

  it("returns null for unknown id", () => {
    expect(findHypothesis(store, "nonexistent")).toBeNull();
  });
});

describe("addEvidence", () => {
  it("adds evidence and promotes to supported", () => {
    const h = addHypothesis(store, "process stopped");
    const updated = addEvidence(store, h.id, "ps aux shows no process", "ps aux");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("supported");
    expect(updated!.evidence).toHaveLength(1);
    expect(updated!.evidence[0]!.text).toBe("ps aux shows no process");
    expect(updated!.evidence[0]!.source).toBe("ps aux");
  });

  it("keeps supported status when adding more evidence", () => {
    const h = addHypothesis(store, "process stopped");
    addEvidence(store, h.id, "first evidence");
    const updated = addEvidence(store, h.id, "second evidence");
    expect(updated!.status).toBe("supported");
    expect(updated!.evidence).toHaveLength(2);
  });

  it("does not promote rejected hypothesis", () => {
    const h = addHypothesis(store, "network issue");
    rejectHypothesis(store, h.id, "network was fine");
    addEvidence(store, h.id, "new finding");
    // still rejected (evidence added but status not changed back)
    expect(findHypothesis(store, h.id)!.status).toBe("rejected");
  });

  it("returns null for unknown id", () => {
    expect(addEvidence(store, "bad-id", "some evidence")).toBeNull();
  });
});

describe("completeCheck", () => {
  it("marks a check as done", () => {
    const h = addHypothesis(store, "oom", ["check dmesg", "check meminfo"]);
    completeCheck(store, h.id, 0);
    expect(findHypothesis(store, h.id)!.required_checks[0]!.done).toBe(true);
    expect(findHypothesis(store, h.id)!.required_checks[1]!.done).toBe(false);
  });

  it("returns null for invalid check index", () => {
    const h = addHypothesis(store, "test", ["check one"]);
    expect(completeCheck(store, h.id, 99)).toBeNull();
  });

  it("returns null for unknown hypothesis", () => {
    expect(completeCheck(store, "bad-id", 0)).toBeNull();
  });
});

describe("rejectHypothesis", () => {
  it("sets status to rejected", () => {
    const h = addHypothesis(store, "network is root cause");
    rejectHypothesis(store, h.id, "network test passed");
    expect(findHypothesis(store, h.id)!.status).toBe("rejected");
  });

  it("appends rejection reason as evidence", () => {
    const h = addHypothesis(store, "config error");
    rejectHypothesis(store, h.id, "config was correct");
    const updated = findHypothesis(store, h.id)!;
    expect(updated.evidence[0]!.text).toContain("config was correct");
  });

  it("works without reason", () => {
    const h = addHypothesis(store, "token issue");
    const result = rejectHypothesis(store, h.id);
    expect(result!.status).toBe("rejected");
    expect(result!.evidence).toHaveLength(0);
  });

  it("returns null for unknown id", () => {
    expect(rejectHypothesis(store, "bad-id")).toBeNull();
  });
});

describe("supportHypothesis", () => {
  it("promotes unverified to supported", () => {
    const h = addHypothesis(store, "test");
    supportHypothesis(store, h.id);
    expect(findHypothesis(store, h.id)!.status).toBe("supported");
  });

  it("does not un-reject a rejected hypothesis", () => {
    const h = addHypothesis(store, "test");
    rejectHypothesis(store, h.id);
    const result = supportHypothesis(store, h.id);
    expect(result).toBeNull();
    expect(findHypothesis(store, h.id)!.status).toBe("rejected");
  });

  it("returns null for unknown id", () => {
    expect(supportHypothesis(store, "bad")).toBeNull();
  });
});

describe("getSummary", () => {
  it("counts by status correctly", () => {
    addHypothesis(store, "unverified one");
    addHypothesis(store, "unverified two");
    const h3 = addHypothesis(store, "supported one");
    supportHypothesis(store, h3.id);
    const h4 = addHypothesis(store, "rejected one");
    rejectHypothesis(store, h4.id);

    const summary = getSummary(store);
    expect(summary.total).toBe(4);
    expect(summary.unverified).toBe(2);
    expect(summary.supported).toBe(1);
    expect(summary.rejected).toBe(1);
  });

  it("counts pending checks correctly", () => {
    addHypothesis(store, "a", ["check 1", "check 2"]);
    const h = addHypothesis(store, "b", ["check 3"]);
    completeCheck(store, h.id, 0);

    const summary = getSummary(store);
    expect(summary.pending_checks).toBe(2); // 2 from first + 0 from second (done)
  });

  it("returns zeros for empty store", () => {
    const summary = getSummary(store);
    expect(summary.total).toBe(0);
    expect(summary.pending_checks).toBe(0);
  });
});

describe("exportStore / importStore", () => {
  it("round-trips correctly", () => {
    addHypothesis(store, "test hypothesis", ["check one"]);
    const json = exportStore(store);
    const imported = importStore(json);
    expect(imported.session).toBe("test-session");
    expect(imported.hypotheses).toHaveLength(1);
    expect(imported.hypotheses[0]!.text).toBe("test hypothesis");
  });
});
