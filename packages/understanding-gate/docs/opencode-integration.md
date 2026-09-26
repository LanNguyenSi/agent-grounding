# opencode integration notes

Moved out of the package README during the README restructure; the substance is unchanged.

## Testing the opencode `transport_error` path

`transport_error` breadcrumbs (`.understanding-gate/parse-errors/`, `kind: "transport_error"`) are written when the plugin's `message.updated` handler fails to fetch the just-finished assistant message back from opencode's own client, not a network-configurable endpoint. The deterministic unit-level hooks for this already exist: `tests/opencode-plugin-integration.test.ts` (search for "transport_error") injects a rejecting / error-returning `client.session.message` and asserts the breadcrumb, in two cases. To force the same failure through a real, live opencode session instead of a unit test, wrap the `ctx` the `init`-generated plugin shim receives so `client.session.message` always throws; see the [opencode npm dogfood doc](https://github.com/LanNguyenSi/agent-grounding/blob/master/docs/testing/opencode-npm-dogfood.md), Scenario 2/Attempt C, for the exact recipe.
