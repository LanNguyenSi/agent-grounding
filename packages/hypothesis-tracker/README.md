# hypothesis-tracker

Track competing hypotheses during debugging. Prevents agents from silently replacing one wrong guess with another by requiring explicit evidence and verification steps.

## Usage

```typescript
import {
  createStore,
  addHypothesis,
  addEvidence,
  completeCheck,
  rejectHypothesis,
  supportHypothesis,
  getSummary,
} from "hypothesis-tracker";

// Create a session store
const store = createStore("debug-session-1");

// Add competing hypotheses with required checks
addHypothesis(store, "DNS resolution is failing", [
  "Run dig/nslookup",
  "Check /etc/resolv.conf",
]);

addHypothesis(store, "Firewall is blocking port 443", [
  "Check iptables rules",
  "Test with curl from host",
]);

// Record evidence (auto-promotes hypothesis from unverified to supported)
const h = store.hypotheses[0];
addEvidence(store, h.id, "dig example.com returns NXDOMAIN", "terminal");

// Complete verification checks
completeCheck(store, h.id, 0); // Mark first check as done

// Reject the other hypothesis with a reason
rejectHypothesis(store, store.hypotheses[1].id, "Firewall rules allow 443");

// Get summary
const summary = getSummary(store);
// { total: 2, supported: 1, rejected: 1, unverified: 0, pending_checks: 3 }
```

## API

| Function | Description |
|----------|-------------|
| `createStore(session?)` | Create new hypothesis store |
| `addHypothesis(store, text, checks)` | Add hypothesis with required verification steps |
| `findHypothesis(store, id)` | Find hypothesis by ID |
| `addEvidence(store, id, text, source?)` | Add evidence to a hypothesis |
| `completeCheck(store, id, index)` | Mark a verification check as done |
| `supportHypothesis(store, id)` | Mark hypothesis as supported |
| `rejectHypothesis(store, id, reason?)` | Mark hypothesis as rejected |
| `getSummary(store)` | Get counts by status |
| `exportStore(store)` | Serialize store to JSON string |
| `importStore(json)` | Deserialize store from JSON string |

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```
