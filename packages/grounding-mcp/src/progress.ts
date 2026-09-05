// Progress notifications for long-running tools, mirroring agent-preflight's
// convention (agent-preflight/src/mcp.ts's withProgressPings). Kept as its
// own module so the convention is easy to spot and reuse, and so tests can
// exercise it directly with an injectable `work` function instead of only
// through a full solution_evaluate MCP roundtrip.
//
// Per the MCP spec, a client that wants to avoid timing out a long-running
// call attaches a `progressToken` to the request (`_meta.progressToken`)
// and (optionally) resets its own request timeout on each
// `notifications/progress` it receives; a client that never asked for
// progress gets none ("the receiver is not obligated to provide these
// notifications"). `progress` here only ever means "still running" — a
// monotonically increasing tick count, never a fabricated percentage or a
// signal about check success.

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Matches agent-preflight's DEFAULT_PROGRESS_INTERVAL_MS (its long-running
// checks and this package's preflight-backed solution_evaluate share the
// same "avoid the SDK's 60s default request timeout" motivation).
export const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;

/**
 * Runs `work` to completion. While it is pending, if the caller attached a
 * `progressToken` (`_meta.progressToken`), pings the client with a
 * `notifications/progress` notification every `intervalMs` — otherwise this
 * is a plain passthrough to `work()`, unchanged.
 *
 * No token means no timer is ever started (not just "no notification sent"
 * — `vi.getTimerCount()` in the test suite asserts this directly).
 *
 * The timer is always cleared before this function returns or throws
 * (`finally`), and also as soon as `extra.signal` aborts (the SDK's
 * cancellation signal for this request) — a cancelled request must not
 * keep pinging a client that already gave up on it. Cancellation only stops
 * the *pings*: `work` itself (the one preflight invocation) is not killed
 * here and no retry or second producer is started — that mirrors
 * solution-verdict.ts's existing behavior, which this helper does not
 * change.
 *
 * A notification send failure (a transport hiccup, a closed connection) is
 * swallowed (`.catch(() => {})`) and pinging CONTINUES on the next tick,
 * rather than stopping the timer: the failure says nothing about whether
 * `work` itself is still healthy, so it must never turn a check into a
 * false success or otherwise change `work`'s outcome, and — since the
 * interval callback has no caller to propagate to — an unswallowed
 * rejection here would surface as an unhandled rejection. Continuing (vs.
 * stopping on first failure) keeps a single transient hiccup from
 * silently ending all further pings for what may still be a many-minute
 * run; a client that is genuinely gone simply keeps failing sends
 * harmlessly until `work` resolves.
 *
 * `intervalMs` is a parameter (not a module-level constant) so tests can
 * inject a short interval, or fake timers can drive many virtual ticks,
 * without waiting out the real ~10s default.
 */
export async function withProgressPings<T>(
  extra: ToolExtra,
  work: () => Promise<T>,
  intervalMs: number = DEFAULT_PROGRESS_INTERVAL_MS,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return work();
  }

  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    // Best-effort ping: see the failure-handling note above.
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          message: 'solution_evaluate still running',
        },
      })
      .catch(() => {});
  }, intervalMs);

  const stopOnAbort = (): void => clearInterval(timer);
  extra.signal.addEventListener('abort', stopOnAbort, { once: true });

  try {
    return await work();
  } finally {
    clearInterval(timer);
    extra.signal.removeEventListener('abort', stopOnAbort);
  }
}
