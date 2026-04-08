# domain-router

Routes a keyword or problem to the correct repos, components, and documentation scope. Part of the [lan-tools](https://github.com/LanNguyenSi/lava-ice-logs/tree/main/lan-tools) agent grounding stack.

## Problem

Agents often jump to random logs, processes, or services without first clarifying:
- Which system is actually meant?
- Which repos are relevant?
- Which documents should be read first?

## Usage

```bash
npm install
npm run build
npm link

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
import { route } from 'domain-router';

const result = route({
  keyword: 'clawd-monitor',
  workspace: '/projects',
  context: { host: 'ice-vps', problem_hint: 'agent not visible' }
});
// → { domain, primary_repos, related_components, priority_files, forbidden_initial_jumps, confidence }
```

## Part of the grounding stack

1. **domain-router** ← you are here
2. [readme-first-resolver](https://github.com/LanNguyenSi/readme-first-resolver)
3. [debug-playbook-engine](https://github.com/LanNguyenSi/debug-playbook-engine)
4. [evidence-ledger](https://github.com/LanNguyenSi/evidence-ledger)
5. [agent-entrypoint](https://github.com/LanNguyenSi/agent-entrypoint)
