# Installing from npm

Every package is published under the `@lannguyensi/` scope and installable directly:

```bash
# Library APIs (claim-gate, evidence-ledger, grounding-wrapper, and
# review-claim-gate ship both a library and a CLI; the CLI install
# below exposes the bin, this install just adds the importable API)
npm install @lannguyensi/claim-gate
npm install @lannguyensi/evidence-ledger
npm install @lannguyensi/grounding-sdk
npm install @lannguyensi/grounding-wrapper
npm install @lannguyensi/hypothesis-tracker
npm install @lannguyensi/review-claim-gate
npm install @lannguyensi/runtime-reality-checker

# CLIs (install globally to expose the bin)
npm install -g @lannguyensi/claim-gate               # → claim-gate
npm install -g @lannguyensi/debug-playbook-engine    # → debug-playbook
npm install -g @lannguyensi/domain-router            # → domain-router
npm install -g @lannguyensi/evidence-ledger          # → ledger
npm install -g @lannguyensi/grounding-wrapper        # → grounding-wrapper
npm install -g @lannguyensi/readme-first-resolver    # → readme-first
npm install -g @lannguyensi/review-claim-gate        # → review-claim-gate
npm install -g @lannguyensi/understanding-gate       # → understanding-gate

# MCP server (install globally or invoke via npx)
npm install -g @lannguyensi/grounding-mcp            # → grounding-mcp
```

The `git clone` workflow in the root README is for hacking on the monorepo itself; downstream consumers install only what they need from npm.

## What a run looks like

Running the evidence-ledger usage example in the root README produces (punctuation normalized from the CLI's own em dash for this doc):

```
✓ Fact recorded:

  ✓ [#26] process is not running (ps aux | grep clawd-monitor)  HIGH

? Hypothesis added:

  ? [#27] OOM killer terminated the process (dmesg output)  MED


📋 Evidence Ledger, session: readme-demo
   2 entries total

✓ FACTS (1)
  ✓ [#26] process is not running (ps aux | grep clawd-monitor)  HIGH

? HYPOTHESES (1)
  ? [#27] OOM killer terminated the process (dmesg output)  MED
```

(Entry IDs autoincrement globally across sessions, so your numbers will differ.)

Same data via `ledger export --session readme-demo` produces structured JSON for hand-off to another agent or a human. Same data via `grounding-mcp`'s `ledger_summary` verb is what `harness explain --trace` and `harness audit` consume to replay policy decisions; see [the harness integration](https://github.com/LanNguyenSi/harness) for the wiring.
