import { describe, it, expect } from "vitest";
import {
  HOOK_COMMAND_NAME,
  addOurHook,
  hasOurHook,
  removeOurHook,
  type SettingsDocument,
} from "../src/cli/settings.js";

const OUR = HOOK_COMMAND_NAME;

describe("hasOurHook", () => {
  it("returns false on empty doc", () => {
    expect(hasOurHook({})).toBe(false);
  });

  it("returns false when hooks.UserPromptSubmit is missing", () => {
    expect(hasOurHook({ hooks: {} })).toBe(false);
  });

  it("returns true when our entry is nested in any matcher block", () => {
    const doc: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "memory-router-user-prompt-submit" },
              { type: "command", command: OUR },
            ],
          },
        ],
      },
    };
    expect(hasOurHook(doc)).toBe(true);
  });

  it("returns false when only foreign hooks are present", () => {
    const doc: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "memory-router-user-prompt-submit" }],
          },
        ],
      },
    };
    expect(hasOurHook(doc)).toBe(false);
  });
});

describe("addOurHook", () => {
  it("adds a new entry to an empty doc", () => {
    const { doc, added } = addOurHook({});
    expect(added).toBe(true);
    expect(hasOurHook(doc)).toBe(true);
  });

  it("is idempotent: second call is a no-op", () => {
    const first = addOurHook({});
    const second = addOurHook(first.doc);
    expect(second.added).toBe(false);
    expect(second.doc).toEqual(first.doc);
  });

  it("preserves unrelated UserPromptSubmit entries", () => {
    const before: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "memory-router-user-prompt-submit" },
            ],
          },
        ],
      },
    };
    const { doc } = addOurHook(before);
    const matchers = doc.hooks?.UserPromptSubmit ?? [];
    const allCommands = matchers.flatMap((m) => m.hooks.map((h) => h.command));
    expect(allCommands).toContain("memory-router-user-prompt-submit");
    expect(allCommands).toContain(OUR);
  });

  it("does not mutate the input doc", () => {
    const before: SettingsDocument = { hooks: { UserPromptSubmit: [] } };
    const snapshot = JSON.parse(JSON.stringify(before));
    addOurHook(before);
    expect(before).toEqual(snapshot);
  });

  it("preserves unrelated top-level fields", () => {
    const before: SettingsDocument = {
      theme: "dark",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
    } as SettingsDocument;
    const { doc } = addOurHook(before);
    expect(doc.theme).toBe("dark");
    expect(doc.hooks?.PreToolUse).toBeDefined();
    expect(hasOurHook(doc)).toBe(true);
  });
});

describe("removeOurHook", () => {
  it("returns removed:false when no entry to remove", () => {
    const { removed } = removeOurHook({});
    expect(removed).toBe(false);
  });

  it("removes only our entry, leaves siblings intact", () => {
    const before: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "memory-router-user-prompt-submit" },
              { type: "command", command: OUR },
            ],
          },
        ],
      },
    };
    const { doc, removed } = removeOurHook(before);
    expect(removed).toBe(true);
    expect(hasOurHook(doc)).toBe(false);
    const allCommands = (doc.hooks?.UserPromptSubmit ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command),
    );
    expect(allCommands).toContain("memory-router-user-prompt-submit");
  });

  it("collapses an emptied UserPromptSubmit array", () => {
    const before: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: OUR }] },
        ],
      },
    };
    const { doc, removed } = removeOurHook(before);
    expect(removed).toBe(true);
    expect(doc.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it("collapses an emptied hooks object", () => {
    const before: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: OUR }] },
        ],
      },
    };
    const { doc } = removeOurHook(before);
    expect(doc.hooks).toBeUndefined();
  });

  it("preserves unrelated hook events (PreToolUse)", () => {
    const before: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: OUR }] },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "other-hook" }],
          },
        ],
      },
    };
    const { doc } = removeOurHook(before);
    expect(doc.hooks?.UserPromptSubmit).toBeUndefined();
    expect(doc.hooks?.PreToolUse).toBeDefined();
  });

  it("does not mutate the input doc", () => {
    const before: SettingsDocument = {
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: OUR }] },
        ],
      },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    removeOurHook(before);
    expect(before).toEqual(snapshot);
  });
});

describe("round-trip add → remove", () => {
  it("returns to a doc equivalent to the starting doc", () => {
    const start: SettingsDocument = {
      theme: "light",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "x" }] },
        ],
      },
    } as SettingsDocument;
    const { doc: added } = addOurHook(start);
    const { doc: removed } = removeOurHook(added);
    expect(removed).toEqual(start);
  });
});
