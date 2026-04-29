import { describe, it, expect } from "vitest";
import {
  renderRules,
  renderGrillCommand,
} from "../src/adapters/opencode/index.js";

describe("renderRules", () => {
  it("contains the fast-confirm prompt body", () => {
    const out = renderRules();
    expect(out).toMatch(/Fast Confirm Mode/);
    expect(out).toMatch(/I understood the task as:/);
  });

  it("frames itself as a house rule and references /grill", () => {
    const out = renderRules();
    expect(out).toMatch(/house rule/);
    expect(out).toMatch(/\/grill/);
  });

  it("notes the opencode trade-off (read-only/question carve-out)", () => {
    const out = renderRules();
    expect(out).toMatch(/pure questions|read-only/);
  });
});

describe("renderGrillCommand", () => {
  it("contains the grill-me prompt body", () => {
    const out = renderGrillCommand();
    expect(out).toMatch(/Grill-Me Mode/);
    expect(out).toMatch(/Please grill me/);
  });

  it("frames itself as the /grill command", () => {
    const out = renderGrillCommand();
    expect(out).toMatch(/\/grill/);
  });
});

describe("idempotence helpers", () => {
  it("renderRules is deterministic across calls", () => {
    expect(renderRules()).toBe(renderRules());
  });

  it("renderGrillCommand is deterministic across calls", () => {
    expect(renderGrillCommand()).toBe(renderGrillCommand());
  });
});
