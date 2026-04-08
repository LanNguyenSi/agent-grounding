/**
 * Claim Gate — Policy Engine for Agent Diagnoses
 *
 * Prevents premature strong claims without verified prerequisites.
 * Based on lan-tools/05-claim-gate.md
 */

export type ClaimType =
  | "root_cause"
  | "architecture"
  | "security"
  | "network"
  | "configuration"
  | "process"
  | "availability"
  | "token"
  | "generic";

export interface ClaimContext {
  /** Agent has read primary documentation (README, entrypoint) */
  readme_read?: boolean;
  /** Agent has verified the relevant process is running or not */
  process_checked?: boolean;
  /** Agent has verified the authoritative configuration source */
  config_checked?: boolean;
  /** Agent has performed a health/port/status check */
  health_checked?: boolean;
  /** Agent has at least one supporting evidence entry */
  has_evidence?: boolean;
  /** Agent has rejected at least one alternative hypothesis */
  alternatives_considered?: boolean;
}

export interface ClaimResult {
  claim: string;
  type: ClaimType;
  allowed: boolean;
  reasons: string[];
  next_steps: string[];
  score: number; // 0–100 readiness score
}

export interface ClaimPolicy {
  type: ClaimType;
  requires: (keyof ClaimContext)[];
  description: string;
}

/** Policies per claim type — which context flags must be true */
export const POLICIES: ClaimPolicy[] = [
  {
    type: "architecture",
    requires: ["readme_read", "process_checked", "config_checked", "alternatives_considered"],
    description: "Architecture diagnosis requires full system understanding",
  },
  {
    type: "root_cause",
    requires: ["readme_read", "process_checked", "config_checked", "has_evidence", "alternatives_considered"],
    description: "Root cause requires evidence + rejected alternatives",
  },
  {
    type: "security",
    requires: ["readme_read", "config_checked", "has_evidence"],
    description: "Security claims require configuration verification + evidence",
  },
  {
    type: "network",
    requires: ["health_checked", "process_checked"],
    description: "Network claims require health + process checks",
  },
  {
    type: "configuration",
    requires: ["readme_read", "config_checked"],
    description: "Configuration claims require doc reading + config verification",
  },
  {
    type: "process",
    requires: ["process_checked"],
    description: "Process claims require process verification",
  },
  {
    type: "availability",
    requires: ["health_checked", "process_checked"],
    description: "Availability claims require health and process checks",
  },
  {
    type: "token",
    requires: ["config_checked", "has_evidence"],
    description: "Token claims require verified config source + evidence",
  },
  {
    type: "generic",
    requires: ["has_evidence"],
    description: "All claims require at least some evidence",
  },
];

const STEP_DESCRIPTIONS: Record<keyof ClaimContext, string> = {
  readme_read: "Read primary documentation (README, AGENT_ENTRYPOINT)",
  process_checked: "Verify runtime process state (ps, systemctl, docker ps)",
  config_checked: "Identify and verify the authoritative configuration source",
  health_checked: "Run health/port/status check (curl, netstat, ping)",
  has_evidence: "Collect at least one supporting evidence entry",
  alternatives_considered: "Document and reject at least one alternative hypothesis",
};

/** Detect claim type from free-text claim */
export function detectClaimType(claim: string): ClaimType {
  const lower = claim.toLowerCase();
  if (/architektur|architecture|design flaw|system design/.test(lower)) return "architecture";
  if (/root.?cause|root cause|eigentliche ursache|grundursache/.test(lower)) return "root_cause";
  if (/security|sicherheit|cve|injection|exploit|auth/.test(lower)) return "security";
  if (/network|netzwerk|firewall|port|dns|tcp|udp/.test(lower)) return "network";
  if (/config|konfiguration|env|environment|setting/.test(lower)) return "configuration";
  if (/process|prozess|service läuft|not running|stopped/.test(lower)) return "process";
  if (/verfügbar|available|down|unreachable|offline/.test(lower)) return "availability";
  if (/token|key|secret|credential|api.?key/.test(lower)) return "token";
  return "generic";
}

/** Evaluate a claim against context — returns gate result */
export function evaluateClaim(claim: string, context: ClaimContext, type?: ClaimType): ClaimResult {
  const claimType = type ?? detectClaimType(claim);
  const policy = POLICIES.find((p) => p.type === claimType) ?? POLICIES.find((p) => p.type === "generic")!;

  const missing = policy.requires.filter((req) => !context[req]);
  const satisfied = policy.requires.filter((req) => context[req]);

  const score =
    policy.requires.length === 0
      ? 100
      : Math.round((satisfied.length / policy.requires.length) * 100);

  const allowed = missing.length === 0;
  const reasons = missing.map((req) => `prerequisite not met: ${STEP_DESCRIPTIONS[req]}`);
  const next_steps = missing.map((req) => STEP_DESCRIPTIONS[req]);

  return { claim, type: claimType, allowed, reasons, next_steps, score };
}

/** Quick check: is this claim allowed? */
export function isAllowed(claim: string, context: ClaimContext, type?: ClaimType): boolean {
  return evaluateClaim(claim, context, type).allowed;
}
