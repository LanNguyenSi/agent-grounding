// Exercises the runtime-reality PreToolUse policy handler end-to-end
// (pure function, no real fs / no real probe). Each test injects its
// own loadExpectations and probe so the contract is clear from the
// test body, no shared fixtures, no hidden state.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handlePolicyPreToolUse,
  type HandlerDeps,
  type PolicyEnv,
  type Probe,
} from "../src/policy/handle-pre-tool-use.js";
import {
  DEFAULT_TRIGGERS,
  MAX_TRIGGERS_BYTES,
  extractCommand,
  loadTriggersFile,
  matchTrigger,
  parseTriggersFile,
  resolveTriggers,
} from "../src/policy/triggers.js";
import {
  parseExpectationsFile,
  expectationsPathFor,
} from "../src/policy/expectations.js";
import type { ExpectationsLoadResult } from "../src/policy/expectations.js";
import type { ActualProcessState, ExpectedProcess } from "../src/lib.js";

const COMPOSE_PAYLOAD = JSON.stringify({
  session_id: "gs-test",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "docker-compose -f docker-compose.prod.yml restart panel-api" },
  hook_event_name: "PreToolUse",
});

const READ_PAYLOAD = JSON.stringify({
  tool_name: "Read",
  tool_input: { file_path: "/some/file.ts" },
});

const RANDOM_BASH_PAYLOAD = JSON.stringify({
  tool_name: "Bash",
  tool_input: { command: "ls -la /tmp" },
});

function expectations(processes: ExpectedProcess[]): ExpectationsLoadResult {
  return { ok: true, file: { domain: "deploy-panel", processes } };
}

function staticProbe(actual: ActualProcessState[]): Probe {
  return () => actual;
}

let env: PolicyEnv;
let deps: HandlerDeps;

beforeEach(() => {
  env = {};
  deps = {
    loadExpectations: () => ({ ok: false, reason: "not_found" }),
    probe: null,
  };
});

describe("triggers", () => {
  it("matches docker-compose restart on Bash", () => {
    const t = matchTrigger({ toolName: "Bash", command: "docker-compose down" });
    expect(t?.category).toBe("compose-mutation");
  });

  it("matches systemctl restart", () => {
    const t = matchTrigger({ toolName: "Bash", command: "sudo systemctl restart nginx" });
    expect(t?.category).toBe("systemctl-mutation");
  });

  it("matches kill -9 <pid>", () => {
    const t = matchTrigger({ toolName: "Bash", command: "kill -9 1234" });
    expect(t?.category).toBe("process-kill");
  });

  it("matches pkill", () => {
    const t = matchTrigger({ toolName: "Bash", command: "pkill -f panel-api" });
    expect(t?.category).toBe("process-kill");
  });

  it("matches a local deploy script", () => {
    const t = matchTrigger({ toolName: "Bash", command: "./deploy-panel.sh prod" });
    expect(t?.category).toBe("deploy-script");
  });

  it("does NOT match a plain ls / read-only Bash", () => {
    expect(matchTrigger({ toolName: "Bash", command: "ls -la /tmp" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "cat /etc/hosts" })).toBeNull();
  });

  it("does NOT match docker read-only / non-mutating subcommands", () => {
    expect(matchTrigger({ toolName: "Bash", command: "docker ps" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "docker exec api ls" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "docker logs api" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "docker inspect api" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "docker-compose pull" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "docker compose pull" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "systemctl status nginx" })).toBeNull();
    expect(matchTrigger({ toolName: "Bash", command: "systemctl list-units" })).toBeNull();
  });

  it("does NOT match non-Bash tools even with matching strings", () => {
    expect(matchTrigger({ toolName: "Read", command: "docker-compose down" })).toBeNull();
  });

  it("extractCommand returns string for valid shape, '' for garbage", () => {
    expect(extractCommand({ command: "ls" })).toBe("ls");
    expect(extractCommand({ command: 42 })).toBe("");
    expect(extractCommand(null)).toBe("");
    expect(extractCommand("bare string")).toBe("");
  });

  it("DEFAULT_TRIGGERS exports a non-empty readonly set", () => {
    expect(DEFAULT_TRIGGERS.length).toBeGreaterThan(0);
  });
});

describe("expectations file", () => {
  it("parses a valid file", () => {
    const result = parseExpectationsFile(
      JSON.stringify({
        domain: "deploy-panel",
        processes: [
          { name: "api", expected_startup: "docker", expected_port: 3001 },
          { name: "fe" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.processes).toHaveLength(2);
  });

  it("rejects invalid JSON", () => {
    const r = parseExpectationsFile("{not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_json");
  });

  it("rejects missing domain", () => {
    const r = parseExpectationsFile(JSON.stringify({ processes: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
  });

  it("rejects invalid startup mode", () => {
    const r = parseExpectationsFile(
      JSON.stringify({ domain: "d", processes: [{ name: "x", expected_startup: "bogus" }] }),
    );
    expect(r.ok).toBe(false);
  });

  it("expectationsPathFor refuses keyword with path-escape chars", () => {
    expect(expectationsPathFor("../escape", "/tmp/x")).toBe("");
    expect(expectationsPathFor("foo/bar", "/tmp/x")).toBe("");
    expect(expectationsPathFor("deploy-panel", "/tmp/x")).toBe("/tmp/x/deploy-panel.json");
  });
});

describe("handler decision matrix", () => {
  it("skips when DISABLE is set", () => {
    env.RUNTIME_REALITY_DISABLE = "1";
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("skips for a malformed payload (degrade to allow)", () => {
    const r = handlePolicyPreToolUse("{not json", env, deps);
    expect(r.decision.kind).toBe("skip");
    expect(r.exitCode).toBe(0);
  });

  it("skips for a read-only tool", () => {
    const r = handlePolicyPreToolUse(READ_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
  });

  it("skips when no trigger matches the Bash command", () => {
    const r = handlePolicyPreToolUse(RANDOM_BASH_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
  });

  it("skips when keyword is not set (baseline unknown)", () => {
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
    if (r.decision.kind === "skip") expect(r.decision.reason).toMatch(/KEYWORD/);
  });

  it("skips + stderr-warns when expectations file is missing", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
    expect(r.stderr).toMatch(/expectations load failed/);
  });

  it("skips + stderr-warns when no probe is configured (default)", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    deps.loadExpectations = () => expectations([{ name: "api" }]);
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
    expect(r.stderr).toMatch(/no probe configured/);
  });

  it("BLOCKS when no probe + PROBE_FAIL_BLOCK is set, with permissionDecision envelope", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    env.RUNTIME_REALITY_PROBE_FAIL_BLOCK = "1";
    deps.loadExpectations = () => expectations([{ name: "api" }]);
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("block");
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("permissionDecision");
    expect(r.stdout).toContain("deny");
  });

  it("allows silently when expected and actual match (golden)", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    deps.loadExpectations = () =>
      expectations([{ name: "api", expected_startup: "docker", expected_port: 3001 }]);
    deps.probe = staticProbe([{ name: "api", running: true, startup_mode: "docker", port: 3001 }]);
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("allow");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("warns on warning-tier drift (port mismatch), no block", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    deps.loadExpectations = () =>
      expectations([{ name: "api", expected_startup: "docker", expected_port: 3001 }]);
    deps.probe = staticProbe([{ name: "api", running: true, startup_mode: "docker", port: 4444 }]);
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("warn");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/port 4444 but expected 3001/);
  });

  it("WARN_AS_BLOCK escalates a port-drift to block", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    env.RUNTIME_REALITY_WARN_AS_BLOCK = "1";
    deps.loadExpectations = () =>
      expectations([{ name: "api", expected_startup: "docker", expected_port: 3001 }]);
    deps.probe = staticProbe([{ name: "api", running: true, startup_mode: "docker", port: 4444 }]);
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("block");
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("permissionDecision");
  });

  it("blocks on critical drift (process not running)", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    deps.loadExpectations = () => expectations([{ name: "api" }, { name: "fe" }]);
    deps.probe = staticProbe([{ name: "api", running: true }]); // fe missing
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("block");
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("permissionDecision");
    expect(r.stdout).toContain("deny");
    expect(r.stderr).toMatch(/fe.*NOT/);
  });

  it("CRITICAL_AS_WARN degrades a critical drift to warn", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    env.RUNTIME_REALITY_CRITICAL_AS_WARN = "1";
    deps.loadExpectations = () => expectations([{ name: "api" }, { name: "fe" }]);
    deps.probe = staticProbe([{ name: "api", running: true }]);
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("warn");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/allowing because RUNTIME_REALITY_CRITICAL_AS_WARN/);
  });

  it("degrades to allow when the probe throws (default)", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    deps.loadExpectations = () => expectations([{ name: "api" }]);
    deps.probe = () => {
      throw new Error("docker-cli not on PATH");
    };
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("skip");
    expect(r.stderr).toMatch(/probe threw.*degraded to allow/);
  });

  it("blocks when probe throws AND PROBE_FAIL_BLOCK=1", () => {
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    env.RUNTIME_REALITY_PROBE_FAIL_BLOCK = "1";
    deps.loadExpectations = () => expectations([{ name: "api" }]);
    deps.probe = () => {
      throw new Error("boom");
    };
    const r = handlePolicyPreToolUse(COMPOSE_PAYLOAD, env, deps);
    expect(r.decision.kind).toBe("block");
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("permissionDecision");
  });

  it("honors an injected custom triggers set (custom trigger gates a non-default command)", () => {
    // Inject a trigger that matches a kubectl command (not in DEFAULT_TRIGGERS)
    const customTrigger = {
      category: "deploy-script" as const,
      toolNames: ["Bash"],
      commandPattern: /kubectl\s+delete/,
    };
    env.RUNTIME_REALITY_KEYWORD = "deploy-panel";
    deps.triggers = [customTrigger];
    deps.loadExpectations = () => expectations([{ name: "api" }]);
    const kubectlPayload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "kubectl delete pod api-0" },
    });
    // With no probe, it degrades to skip; the key assertion is that the trigger matched
    // (if it had not matched, the decision reason would be "no policy trigger matched")
    const r = handlePolicyPreToolUse(kubectlPayload, env, deps);
    // Trigger matched, no probe → skip with "no probe configured" reason (not "no trigger matched")
    expect(r.decision.kind).toBe("skip");
    if (r.decision.kind === "skip") {
      expect(r.decision.reason).toMatch(/no probe configured/);
    }
  });
});

// ---------------------------------------------------------------------------
// triggers file loader and resolver
// ---------------------------------------------------------------------------

let tmpDir = "";

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    tmpDir = "";
  }
});

function writeTriggerFile(name: string, content: string): string {
  if (!tmpDir) {
    tmpDir = mkdtempSync(join(tmpdir(), "rrc-triggers-test-"));
  }
  const path = join(tmpDir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const VALID_TRIGGERS_JSON = JSON.stringify([
  {
    toolNames: ["Bash"],
    commandPattern: "kubectl\\s+(delete|apply)\\b",
    category: "deploy-script",
  },
]);

describe("parseTriggersFile", () => {
  it("parses a valid triggers array", () => {
    const r = parseTriggersFile(VALID_TRIGGERS_JSON);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]!.category).toBe("deploy-script");
    expect(r.triggers[0]!.commandPattern).toBeInstanceOf(RegExp);
    expect(r.triggers[0]!.toolNames).toContain("Bash");
  });

  it("parses every element of a multi-element triggers array", () => {
    const r = parseTriggersFile(
      JSON.stringify([
        { toolNames: ["Bash"], commandPattern: "kubectl\\s+delete\\b", category: "deploy-script" },
        { toolNames: ["Bash"], commandPattern: "helm\\s+uninstall\\b", category: "process-kill" },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.triggers).toHaveLength(2);
    expect(r.triggers[1]!.category).toBe("process-kill");
    expect(r.triggers[1]!.commandPattern).toBeInstanceOf(RegExp);
  });

  it("reports the offending element index for a later invalid element", () => {
    const r = parseTriggersFile(
      JSON.stringify([
        { toolNames: ["Bash"], commandPattern: "kubectl\\s+delete\\b", category: "deploy-script" },
        { toolNames: [], commandPattern: "foo", category: "process-kill" },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
    expect(r.detail).toMatch(/\[1\]/);
  });

  it("returns invalid_json for malformed JSON", () => {
    const r = parseTriggersFile("{not json}");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_json");
  });

  it("returns invalid_shape when root is not an array", () => {
    const r = parseTriggersFile(JSON.stringify({ toolNames: ["Bash"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
  });

  it("returns invalid_shape when root is an empty array", () => {
    const r = parseTriggersFile("[]");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
    expect(r.detail).toMatch(/non-empty/);
  });

  it("returns invalid_shape when toolNames is missing", () => {
    const r = parseTriggersFile(
      JSON.stringify([{ commandPattern: "foo", category: "process-kill" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
    expect(r.detail).toMatch(/toolNames/);
  });

  it("returns invalid_shape when toolNames is empty", () => {
    const r = parseTriggersFile(
      JSON.stringify([{ toolNames: [], commandPattern: "foo", category: "process-kill" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
  });

  it("returns invalid_shape when a toolName element is not a string", () => {
    const r = parseTriggersFile(
      JSON.stringify([{ toolNames: [42], commandPattern: "foo", category: "process-kill" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
  });

  it("returns invalid_shape when commandPattern is not a string", () => {
    const r = parseTriggersFile(
      JSON.stringify([{ toolNames: ["Bash"], commandPattern: 123, category: "process-kill" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
    expect(r.detail).toMatch(/commandPattern/);
  });

  it("returns invalid_shape when category is unknown", () => {
    const r = parseTriggersFile(
      JSON.stringify([
        { toolNames: ["Bash"], commandPattern: "foo", category: "not-a-real-category" },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
    expect(r.detail).toMatch(/not-a-real-category/);
  });

  it("returns invalid_regex for an invalid regex pattern", () => {
    const r = parseTriggersFile(
      JSON.stringify([{ toolNames: ["Bash"], commandPattern: "(", category: "process-kill" }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_regex");
    expect(r.detail).toMatch(/\(/);
  });

  it("compiled commandPattern actually matches expected input", () => {
    const r = parseTriggersFile(VALID_TRIGGERS_JSON);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.triggers[0]!;
    expect(t.commandPattern.test("kubectl delete pod api-0")).toBe(true);
    expect(t.commandPattern.test("kubectl get pods")).toBe(false);
  });
});

describe("loadTriggersFile", () => {
  it("returns not_found for a non-existent path", () => {
    const r = loadTriggersFile("/tmp/__no_such_file_rrc_test__.json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
  });

  it("returns ok and a compiled trigger set for a valid file", () => {
    const path = writeTriggerFile("valid.json", VALID_TRIGGERS_JSON);
    const r = loadTriggersFile(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]!.commandPattern).toBeInstanceOf(RegExp);
    // The loaded trigger should match with matchTrigger
    const match = matchTrigger(
      { toolName: "Bash", command: "kubectl apply -f k8s/" },
      r.triggers,
    );
    expect(match).not.toBeNull();
    expect(match?.category).toBe("deploy-script");
  });

  it("returns invalid_json for a file containing bad JSON", () => {
    const path = writeTriggerFile("bad.json", "not json at all");
    const r = loadTriggersFile(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_json");
  });

  it("returns invalid_shape for a JSON file with wrong structure", () => {
    const path = writeTriggerFile("shape.json", JSON.stringify({ foo: "bar" }));
    const r = loadTriggersFile(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
  });

  it("returns invalid_shape for an unknown category", () => {
    const path = writeTriggerFile(
      "cat.json",
      JSON.stringify([{ toolNames: ["Bash"], commandPattern: "foo", category: "unknown-cat" }]),
    );
    const r = loadTriggersFile(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_shape");
  });

  it("returns invalid_regex for a file with a bad regex pattern", () => {
    const path = writeTriggerFile(
      "regex.json",
      JSON.stringify([{ toolNames: ["Bash"], commandPattern: "(", category: "process-kill" }]),
    );
    const r = loadTriggersFile(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid_regex");
  });

  it("returns io_error for a file that exceeds MAX_TRIGGERS_BYTES", () => {
    if (!tmpDir) {
      tmpDir = mkdtempSync(join(tmpdir(), "rrc-triggers-test-"));
    }
    const path = join(tmpDir, "oversize.json");
    // Write content larger than 1 MiB
    const oversize = "x".repeat(MAX_TRIGGERS_BYTES + 1);
    writeFileSync(path, oversize, "utf8");
    const r = loadTriggersFile(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("io_error");
    expect(r.detail).toMatch(/byte cap/);
  });
});

describe("resolveTriggers", () => {
  it("returns DEFAULT_TRIGGERS with no warning when path is undefined", () => {
    const result = resolveTriggers(undefined);
    expect(result.triggers).toBe(DEFAULT_TRIGGERS);
    expect(result.warning).toBeUndefined();
  });

  it("returns DEFAULT_TRIGGERS with no warning when path is an empty string", () => {
    const result = resolveTriggers("");
    expect(result.triggers).toBe(DEFAULT_TRIGGERS);
    expect(result.warning).toBeUndefined();
  });

  it("returns DEFAULT_TRIGGERS with no warning when path is whitespace only", () => {
    const result = resolveTriggers("   ");
    expect(result.triggers).toBe(DEFAULT_TRIGGERS);
    expect(result.warning).toBeUndefined();
  });

  it("returns loaded triggers with no warning for a valid file", () => {
    const path = writeTriggerFile("resolve-valid.json", VALID_TRIGGERS_JSON);
    const result = resolveTriggers(path);
    expect(result.warning).toBeUndefined();
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0]!.category).toBe("deploy-script");
  });

  it("falls back to DEFAULT_TRIGGERS with a warning when the file does not exist", () => {
    const result = resolveTriggers("/tmp/__no_such_rrc_file__.json");
    expect(result.triggers).toBe(DEFAULT_TRIGGERS);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/triggers file load failed/);
    expect(result.warning).toMatch(/not_found/);
    expect(result.warning).toMatch(/using default trigger set/);
  });

  it("falls back to DEFAULT_TRIGGERS with a warning when the file has invalid JSON", () => {
    const path = writeTriggerFile("resolve-bad.json", "{{invalid");
    const result = resolveTriggers(path);
    expect(result.triggers).toBe(DEFAULT_TRIGGERS);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/invalid_json/);
  });

  it("falls back to DEFAULT_TRIGGERS with a warning when the file has an invalid shape", () => {
    const path = writeTriggerFile(
      "resolve-shape.json",
      JSON.stringify([{ toolNames: ["Bash"], commandPattern: "foo", category: "bad-cat" }]),
    );
    const result = resolveTriggers(path);
    expect(result.triggers).toBe(DEFAULT_TRIGGERS);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/invalid_shape/);
  });
});
