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
reviewer entries), optional `codeWorker`, optional `largeWorkers` (one or two),
and optional `largeCodeWorker`. Each entry needs only `origin`, `token`
and `workspace`; model/process values and other configuration are ignored. Origins
must be HTTPS roots without credentials, query strings, fragments or extra paths.
Tokens remain server-side and must never be placed in a browser bundle. An identical
origin/workspace/token across profiles is collected once, retaining every role:
`developer`, `reviewer`, `code-developer`, `large-developer`, `large-reviewer`,
and `large-code-developer`. Distinct large entries use IDs `large-worker-1`,
`large-worker-2` and `large-code-worker`; default IDs remain unchanged.
At most six configured entries and 24 fixed GETs are admitted before deduplication.
Entries are configured HTTP targets, not an independently verified Machine count.
Supply trusted JSON-derived server configuration. Arbitrary JavaScript proxies,
array accessors and coercion callbacks are not a sandboxed input boundary.

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
2048nodes/4096edges per worker inventory,128-character IDs,160-character printable labels and
finite bounded positions. Matched model/MCP/subflow bindings are retained.
Prompts, conversations, raw model configuration, credentials, MCP arguments/env/
headers/URLs and raw errors are omitted. Complete known configured worker-token
values and the explicitly recognized reversible encodings in retained labels
refuse the target inventory. All configured profiles supply this guard before
deduplication or the first GET. Arbitrary encodings, partial/chunked values and
unknown secrets are not covered by this finite guard. Flow/server/model names may still be
private; authenticated reports stay outside Git and portable artifacts.

Recognized whole-token forms are raw/JSON-escaped text, URI/component/query
encoding with percent-hex case normalization, padded/unpadded UTF-8 base64 and
base64url, and lower/upper UTF-8 hex. Unescaped credential-letter case is preserved.
Percent-hex normalization can conservatively refuse a literal `%HH` label.

With six distinct configured targets, the per-worker caps can produce at most
600 flows, 1200 models, 1200 servers, 12288 nodes and 24576 edges in one report.
The existing shared deadline and per-response byte bounds still apply; this is
a sequential observation, not an atomic fleet snapshot or a Machine census.
The deadline bounds HTTP/body waits; synchronous JSON parsing and projection
do not have a hard CPU-preemption guarantee.

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

## Large-profile successor, October 4

This separate successor starts at frozen PR7 head `d1127044`. The first author
collector run passed16/16 using the CRLF checkout. A local attribute policy then
pinned graph source to LF; the same16 groups passed once on exact LF bytes.
The unchanged projector now matches its Git blob. These repeated executions
overlap and are not32 distinct security conditions or actual worker calls.

Independent static review found an inherited encoded-label gap: a known token
could be reflected as reversible percent/base64 text without matching the old
raw/JSON guard. One targeted fictional transport witness failed before correction
when a percent-encoded cross-profile token survived projection. The corrected
collector passed17/17 once, including the added known-encoding group. Original
failures and preliminary pins are retained in SOURCE-CHECKS.json. No runtime
credential incident was observed and no actual GET or inference was performed.
Independent static review passed the final exact LF code/test bytes without
test or import reruns. Hosted successor confirmation is pending at publication.

Root must authenticate the gateway session before collection, keep runtime
configuration server-side, return no-store JSON, and distinguish this report from
the Sample sky. Optional direct FLUJO UI links still require their native login.
Gateway route adoption, World graph consumption, voice response playback, native
authority, subscription qualification and hot workspace/MCP cloning are separate
acceptance gates. This pack supplies graph source; it does not establish them.
