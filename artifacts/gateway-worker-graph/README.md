# Gateway worker graph handoff

This source-only adapter supplies reported FLUJO flow/node/model/MCP metadata for
the authenticated World swarm view. Root owns route integration, browser behavior,
runtime configuration and deployment. It requires Node22 or24 and no npm packages.
Copy both `collect-worker-graphs.mjs` and `project-inventory.mjs` together.

```js
import { collectGatewayWorkerGraphs } from './collect-worker-graphs.mjs';

// Inside an authenticated, server-side GET handler. Config stays private/in RAM.
const report = await collectGatewayWorkerGraphs(runtimeGatewayConfig, {
  timeoutMs: 10_000,
  includeUiLinks: false,
});
// Return JSON with Cache-Control: no-store. Do not log/export private observations.
```

The caller passes its existing `workers` array (one or two configured developer /
reviewer entries) and optional `codeWorker`. Each entry needs only `origin`, `token`
and `workspace`; model/process values and other configuration are ignored. Origins
must be HTTPS roots without credentials, query strings, fragments or extra paths.
Tokens remain server-side and must never be placed in a browser bundle. An identical
origin/workspace/token for code and text is collected once, with both role labels.
Entries are configured HTTP targets, not an independently verified Machine count.

The module makes only authenticated GETs to `/api/worker/status`, `/api/flow`,
`/api/model` and `/api/mcp/servers`. It sets both the workspace query and header,
refuses redirects and performs no retries. Inventory is collected only after a
worker-mode status reports the exact configured workspace and `ready`. Responses
are bounded to128KiB status,8MiB flows and2MiB each for models/MCP servers. A shared
HTTP deadline covers all targets and body reads: default10seconds, accepted range
1–30seconds. Refusal, malformed data, timeout and oversized bodies retain explicit
unavailable markers and fixed error codes; raw remote errors are never returned.

This direct HTTP adapter does not inherit `ManagedCloud.inspect`'s private journal,
Fly ownership, Machine-specific proxy, immutable image or archive-hash verification.
No Fly CLI or ownership credentials are needed or read. It performs no inference,
POST, worker start, provisioning, configuration change, clone or lifecycle action.

Report v1 has this envelope; the example is schematic, not a live receipt:

```json
{
  "format": "flujo-gateway-worker-graphs",
  "version": 1,
  "observedAt": "2026-10-04T12:00:00.000Z",
  "source": {
    "kind": "configured-worker-http",
    "sample": false,
    "ownershipVerified": false,
    "machineRouting": "configured-app-origin"
  },
  "observation": { "consistency": "sequential", "qualification": false },
  "workers": [{
    "id": "worker-1",
    "roles": ["developer", "code-developer"],
    "workspace": "example-dev",
    "observedAt": "2026-10-04T12:00:00.000Z",
    "status": { "available": true, "state": "ready" },
    "collections": {
      "flows": { "available": true, "truncated": false },
      "models": { "available": false, "truncated": false },
      "servers": { "available": true, "truncated": false }
    },
    "flows": [], "models": [], "servers": [],
    "errors": { "models": "HTTP_UNAVAILABLE" }
  }]
}
```

Injected fixture transport is labelled `kind:"injected-http"`; this is distinct
from real configured-worker HTTP observations and from a separate sample sky.
Neither marker grants production acceptance. World should show the observation
timestamp, sequential/report-only scope, unavailable collections and truncation.
HTTP200 with an empty flow array is only a reported empty inventory: native flow
loading can return `[]` after storage errors. It does not prove a healthy empty
workspace. MCP `statusSource:"bootstrap-reported"` is saved startup metadata.
Subflow targets are configured possibilities; runtime/dynamic selection is not
resolved by these GETs. Do not represent a singular child as the executed target.

Projection caps match PR6:100flows,200models,200servers,256nodes/512edges per flow,
2048nodes/4096edges total,128-character IDs,160-character printable labels and
finite bounded positions. Matched model/MCP/subflow bindings are retained.
Prompts, conversations, raw model configuration, credentials, MCP arguments/env/
headers/URLs and raw errors are omitted. Known configured worker-token values in
retained labels refuse the target inventory. Flow/server/model names may still be
private; authenticated reports stay outside Git and portable artifacts.

`includeUiLinks:true` adds only each configured HTTPS root as a `flujo-ui` link,
without tokens, queries or conversation links. Native UI authentication remains
its own host's responsibility. No iframe authentication bypass is supplied.

Focused source/fixture checks:

```powershell
node --test --test-concurrency=1 artifacts/gateway-worker-graph/project-inventory.test.mjs artifacts/gateway-worker-graph/collect-worker-graphs.test.mjs
```

These checks use fictional data and injected transport. Actual worker GETs,
gateway route adoption, authenticated World graph rendering and voice remain
separate Root-owned acceptance work.

Source validation on October4 used bundled Node24.19.0:19 pure projector cases
passed once; the initial11 collector groups passed, then independent static review
of commit128d5d35 found a JSON-escaping gap in the configured-token label guard.
The correction checks both raw and JSON-escaped token forms. Its12 collector
groups passed, including the new quote/backslash regressions. These are fixture
and source results, not native worker calls; no runtime privacy incident was
observed. The original candidate and its review finding remain in Git history.
