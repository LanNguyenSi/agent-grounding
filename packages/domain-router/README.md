# domain-router

Routes a keyword or problem to the correct repos, components, and documentation scope. Part of the agent-grounding stack.

## Problem

Agents often jump to random logs, processes, or services without first clarifying:
- Which system is actually meant?
- Which repos are relevant?
- Which documents should be read first?

## Install

```bash
npm install -g @lannguyensi/domain-router
```

## Usage

```bash
# Route a keyword to its scope
domain-router route -k clawd-monitor -w /projects

# JSON output for scripting
domain-router route -k clawd-monitor -w /projects --json
```

## Example Output

```
🗂  Domain Router — "clawd-monitor"

  Domain:      clawd-monitor
  Confidence:  92%

  Primary Repos:
    📁 clawd-monitor
    📁 clawd-monitor-agent

  Related Components:
    - Web UI
    - Backend API
    - OpenClaw Gateway

  Priority Files (read first):
    📄 README.md
    📄 AGENT_ENTRYPOINT.yaml
    📄 .env.example

  ❌ Forbidden initial jumps:
    - random log search
    - unrelated service inspection
    - network diagnosis before process check
```

## API

```typescript
import { route } from '@lannguyensi/domain-router';

const result = route({
  keyword: 'clawd-monitor',
  workspace: '/projects',
  context: { host: 'vps-01', problem_hint: 'agent not visible' }
});
// → { domain, primary_repos, related_components, priority_files, forbidden_initial_jumps, confidence }
```

## Part of the grounding stack

1. **domain-router** ← you are here
2. [readme-first-resolver](../readme-first-resolver)
3. [debug-playbook-engine](../debug-playbook-engine)
4. [evidence-ledger](../evidence-ledger)
