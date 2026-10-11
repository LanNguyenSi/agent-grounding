# domain-router

Routes a keyword or problem to the correct repos, components, and documentation scope.

## Overview

Part of the agent-grounding stack. Agents often jump to random logs, processes, or services without first clarifying which system is actually meant, which repos are relevant, and which documents should be read first. domain-router answers that up front, given a keyword and a workspace root.

## Install

```bash
npm install -g @lannguyensi/domain-router
```

Requires Node.js >= 20.

## Usage

```bash
# Route a keyword to its scope
domain-router route -k clawd-monitor -w /projects

# JSON output for scripting
domain-router route -k clawd-monitor -w /projects --json

# Show which repos depend on a keyword/package (reverse lookup)
domain-router impact -k clawd-monitor -w /projects

# JSON output for scripting
domain-router impact -k clawd-monitor -w /projects --json
```

### How routing works

- Repos: the immediate subdirectories of `--workspace` that contain a `.git` entry.
- Scoring: repo name and keyword are compared after lowercasing and turning runs of `-`, `_` and whitespace into `-`. Exact match 1.0; repo name contains the keyword 0.8; keyword contains the repo name 0.7; partial word overlap 0.4 to 0.7. Up to three best matches become `primary_repos`; `confidence` is the top score plus 0.05, capped at 1.0 (shown as a percentage in text output), or 0.1 with no match.
- Priority files: the files from README.md, docs/architecture.md, AGENT_ENTRYPOINT.yaml, .env.example, docker-compose.yml and docker-compose.yaml that exist in the top repo.
- `related_components` comes from a fixed keyword table and `forbidden_initial_jumps` is a fixed list; both are heuristics.
- `impact`: lists repos whose package.json dependencies, devDependencies or peerDependencies name the keyword, or whose AGENT_ENTRYPOINT.yaml has a `related_components:` list entry containing it. JSON: `{ keyword, dependents: [{ repo, type: "npm" | "entrypoint", detail }] }`.

### Example output

```
🗂  Domain Router — "clawd-monitor"

  Domain:      clawd-monitor
  Confidence:  100%

  Primary Repos:
    📁 clawd-monitor
    📁 clawd-monitor-agent

  Related Components:
    - Web UI
    - Backend API
    - Agent process
    - OpenClaw Gateway
    - Agent runtime

  Priority Files (read first):
    📄 README.md
    📄 AGENT_ENTRYPOINT.yaml
    📄 .env.example

  ❌ Forbidden initial jumps:
    - random log search
    - unrelated service inspection
    - network diagnosis before process check
```

### API

```typescript
import { route, impact } from '@lannguyensi/domain-router';

const result = route({
  keyword: 'clawd-monitor',
  workspace: '/projects',
});
// -> { domain, primary_repos, related_components, priority_files, forbidden_initial_jumps, confidence }

const deps = impact('clawd-monitor', '/projects');
// -> { keyword, dependents: [{ repo, type, detail }] }
```

## Part of the grounding stack

1. **domain-router** (you are here)
2. [readme-first-resolver](../readme-first-resolver)
3. [debug-playbook-engine](../debug-playbook-engine)
4. [evidence-ledger](../evidence-ledger)

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
