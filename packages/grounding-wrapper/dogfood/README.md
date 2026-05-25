# dogfood/

Captured CLI output from real `grounding-wrapper` invocations. Used as evidence in the hardening PR (agent-tasks/839b51f9) that the CLI produces the output advertised by `README.md`. Not part of the published npm artifact.

Regenerate after CLI changes:

```bash
npm run build
node dist/index.js start -k clawd-monitor -p "agent not visible in monitor" > dogfood/session-clawd-monitor.txt
node dist/index.js start -k clawd-monitor -p "agent not visible" --json    > dogfood/session-clawd-monitor.json
node dist/index.js show-phases -k arch-redesign -p "split monolith into services" > dogfood/phases-arch-redesign.txt
```
