# Operator guide: explicit images and journals

This guide preserves the original deployment and acceptance-test workflow. For ordinary deployments, use the [managed CLI guide](deployment.md): it discovers native FLUJO, selects the official image and saves controller credentials automatically. Passing `--journal PATH` explicitly selects the lower-level operator interface documented here. The parallel GitHub example still uses that interface.

## Original deployment workflow

Use a dedicated local FLUJO workspace, prove its flow works locally, deploy it with the `flujo-cloud` CLI, then call that flow in the cloud. Start with the [architecture and deployment diagram](architecture.md) for the repository split and credential boundaries. The [recorded GitHub MCP test](github-mcp-validation-2026-09-05.md) is a completed example using one local workspace and three cloud workers.

## 1. Prepare the source workspace

Use a FLUJO version containing the merged [snapshot/worker changes](https://github.com/mario-andreschak/FLUJO/pull/503) and [secret MCP environment fixes](https://github.com/mario-andreschak/FLUJO/pull/504). Start local FLUJO with `FLUJO_SNAPSHOT_CONTROL_TOKEN` set in its environment. The bridge must use that same source token and the actual loopback port.

In FLUJO:

1. Create a dedicated workspace, such as `test-cloud`.
2. Add the model and assign it to the flow. The validated setup used one `gpt-6-astra` Codex subscription model and the default `FLUJO` flow, ID `default-agent-flujo`.
3. Install required MCP servers through FLUJO's existing installer. Configure their env values, headers or remote credentials normally; mark sensitive env values as secret.
4. Attach the required MCP tools to the flow. Remove desktop-only dependencies from this worker's flow or replace them with portable equivalents.
5. Execute a representative local flow. Check the actual tool result and external outcome, not just an assistant's success message.
6. Unlock the workspace if it is password protected. Pause external processes that write its files during capture and keep its configuration unchanged while preparing parallel clones.

For Codex, a valid supported file-backed ChatGPT login must be available to FLUJO. Cloud capture does not copy arbitrary OS keychain entries, and a copied login does not guarantee independent long-term token refresh. See [Codex authentication](architecture.md#codex-subscription-authentication).

### Example: install a GitHub MCP with an env credential

The completed test used this configuration:

| Setting | Value |
|---|---|
| Installer source | `https://github.com/ildunari/Github-MCP` |
| Ref | `f8b0ceb192d129651082e1a652d4f331d29eaaf8` |
| Server name | `github-cloud-test` |
| Install command | `npm ci --ignore-scripts --include=dev` |
| Build command | Empty; this pinned version runs JavaScript directly |
| Secret env | `GITHUB_TOKEN`, marked secret |
| Other env | `MCP_IDLE_TIMEOUT_MS=0` |
| Flow tools | `github_get_issue`, `github_rest_get`, `github_create_issue_comment` |

This is the community `github-mcp-server-kosta@3.1.0` package. It is not the official GitHub Go/Docker MCP server. The current portable GitHub installer path used here supports Node servers; another package may require different installation hints and credential names.

The existing authoring tool is `install_mcp_server`, available through `/api/mcp/flujo/authoring?workspace=test-cloud`. It accepts `source`, `serverName`, `ref`, `installCommand`, `buildCommand` and `env`. A secret env entry uses the existing wrapped form `{ value: credential, metadata: { isSecret: true } }`. Supply the credential from a private environment or secret store when constructing the request; do not paste a real value into documentation, source control or a shell command argument. The installation/save path now preserves secret metadata and encrypts the value.

Create a dedicated test repository and issue, and use a fine-grained GitHub token with the necessary issue permissions limited to that repository. The completed test's token is temporary; provision your own credential for later deployments.

## 2. Install the bridge and choose an image

The bridge requires Node.js 22+, Git and an authenticated Fly CLI/account that can create apps, Machines, volumes and secrets. Clone this private repository with an authorized GitHub account:

```text
git clone https://github.com/flujo-app/flujo-cloud.git
cd flujo-cloud
node bin/flujo-cloud.mjs --help
npm test
npm run smoke
```

No `npm install` is needed for the bridge. Its automated tests use synthetic credentials and mocked cloud operations.

Supply an immutable image reference ending in `@sha256:<64 lowercase hex characters>`. The image must contain FLUJO's matching worker bootstrap and layout; prefer a build from the same FLUJO implementation as the source. Restore checks format/version compatibility. The bridge does not build or publish images.

An image build belongs in the **FLUJO repository**, using its Dockerfile and a clean chosen revision. With Docker and a registry configured, the build/publish shape is:

```text
docker build -t YOUR_REGISTRY/flujo-worker:YOUR_TAG .
docker push YOUR_REGISTRY/flujo-worker:YOUR_TAG
```

Replace those placeholders and use the registry's resulting immutable digest reference for deployment. A CI or remote builder can produce the same Dockerfile image. The [validation report](github-mcp-validation-2026-09-05.md) records the exact commit and image used in the live test; access to that private registry is account-specific.

## 3. Configure controller credentials

| Environment variable | Required by | Meaning |
|---|---|---|
| `FLUJO_SNAPSHOT_CONTROL_TOKEN` | `up` | Same dedicated token configured in the running source FLUJO process |
| `FLUJO_CLOUD_CONTROL_TOKEN` | `up`, `call` | Separate random worker control token; retain it for future calls |
| `FLY_API_TOKEN` | Optional | Alternative to the existing authenticated Fly CLI session |
| `FLYCTL_PATH` | Optional | Full path to `flyctl` if it is not on PATH |
| `FLUJO_GITHUB_AUDIT_TOKEN` | GitHub example when the issue is private | Read access for controller-side GitHub audits; does not replace the worker's MCP env credential |

Control tokens must contain at least 32 ASCII letters/digits or base64/URL-safe characters. Generate separate random values, keep them in a private secret store and inject them into the controller's environment. Start/restart source FLUJO with its source token set before capture. Do not confuse the source token with the worker token.

For example, in PowerShell, existing private token files can be loaded without printing their contents:

```powershell
$env:FLUJO_SNAPSHOT_CONTROL_TOKEN = (Get-Content -LiteralPath 'C:\secure\source-control-token' -Raw).Trim()
$env:FLUJO_CLOUD_CONTROL_TOKEN = (Get-Content -LiteralPath 'C:\secure\worker-control-token' -Raw).Trim()
```

Replace these example paths with your own files, restrict them to the owning account and keep them outside Git. The source process and bridge can be separate processes as long as the source token matches.

## 4. Deploy one worker

Run commands from the bridge repository. Replace `YOUR_ORG`, `YOUR_NEW_APP` and the image reference below with real values; select a Fly region available to your account. Use the actual source port and exact flow ID.

```text
node bin/flujo-cloud.mjs up --source http://127.0.0.1:4200 --workspace test-cloud --flow default-agent-flujo --app YOUR_NEW_APP --org YOUR_ORG --region iad --image REGISTRY/IMAGE@sha256:DIGEST --journal .flujo-cloud/test-worker.journal.json
```

The command creates one paid app/Machine/volume deployment. Defaults are two shared CPUs, 2048 MiB RAM, a 2 GiB volume, a 600-second timeout per operation wait/request and a 256 MiB compressed snapshot cap. The timeout is not a total wall-clock deadline for all of `up`. Optional flags include `--memory-mb`, `--volume-gb`, `--timeout-seconds` and `--max-snapshot-mib`. Automatic Fly volume snapshots are disabled at creation. No public service or IP is allocated.

Use a new app name and journal for each deployment. Existing apps are not adopted, and `up` is not an update-in-place command. Keep the journal after success or failure. Success returns the app, Machine ID, workspace, journal and `state: "ready"` only after authenticated readiness for the expected snapshot.

Repeat `--flow` or use `--flows ID1,ID2` for multiple flow IDs. Omitting flow selection uses the workspace's enabled-MCP scope. Selection controls startup dependencies and bridge calls; it does **not** remove unrelated workspace data or credentials from the snapshot.

## 5. Execute and verify a flow

Create a request file, for example `.flujo-cloud/request.json`:

```json
{
  "model": "default-agent-flujo",
  "stream": false,
  "metadata": {
    "conversationId": "cloud-example-001",
    "appendMessages": "true",
    "requireApproval": "false"
  },
  "messages": [
    { "role": "user", "content": "Run the agreed test using the tools configured on this flow and verify the result." }
  ]
}
```

```text
node bin/flujo-cloud.mjs call --journal .flujo-cloud/test-worker.journal.json --request .flujo-cloud/request.json
```

`request.model` is the exact **flow ID**, not the provider model name. The bridge resolves that ID to the unique flow name used by FLUJO's current completion endpoint and adds `metadata.flujo: "true"` so FLUJO executes its tools inside the worker. Duplicate flow names are rejected. Model choice comes from the restored flow configuration.

FLUJO's completion API defaults to unattended tool execution. This example makes that setting explicit with `requireApproval: "false"`. The operator bridge preserves request metadata; it has no approval/respond command for a request that explicitly enables approval. Give the flow a concrete task and outcome to verify.

The flow response is written to stdout. Redirect it to a private result file if needed; it can contain conversation/tool data. Streaming responses are buffered until completion. `--conversation-id ID` overrides the request's conversation ID to address the worker's saved conversation. `appendMessages: "true"` appends the supplied new messages; without it, the API treats them as the active transcript. Later source changes are not synchronized into the worker.

Verify the external effect and the durable worker conversation events. A ready worker and an assistant's prose are not sufficient evidence of successful execution. After deployment the source FLUJO process does not need to remain running for `call`.

## 6. Run the three-worker GitHub acceptance example

First complete the local GitHub MCP test, configure the worker's `GITHUB_TOKEN` secret and choose a dedicated issue. Set `FLUJO_GITHUB_AUDIT_TOKEN` if that issue is private. The example expects the tool argument shapes from the pinned community package described above.

```text
node examples/parallel-github.mjs prepare --target https://github.com/OWNER/TEST_REPO/issues/NUMBER --flow default-agent-flujo --mcp github-cloud-test --image REGISTRY/IMAGE@sha256:DIGEST --org YOUR_ORG --region iad --workspace test-cloud --source http://127.0.0.1:4200
node examples/parallel-github.mjs provision --plan PATH_FROM_PREPARE
node examples/parallel-github.mjs run --plan PATH_FROM_PREPARE
node examples/parallel-github.mjs audit --plan PATH_FROM_PREPARE
```

Replace placeholders and retain the returned plan directory. `prepare` writes the plan and uniquely marked requests under ignored `.flujo-cloud/integration-runs`. `provision` captures and provisions three workers sequentially because capture is coordinated by the source. `run` requires all three ready journals, checks marker absence, reserves all calls durably and dispatches the three flow requests concurrently once.

`prepare --directory PATH` selects another private output location. Optional `--conversation-id ID` continues the same saved conversation independently in each clone; otherwise each worker receives a new conversation ID. `prepare` only writes the reviewable local plan and requests; `provision` allocates the three paid Machines and volumes. Run files can contain private conversation results.

Each requested flow reads the issue comments, creates its one exact marker if absent and reads it back. `audit` performs GET requests only and records exact marker counts, authors, URLs and worker identities. Inspect durable FLUJO events separately to establish that the MCP route executed the calls and that their execution intervals overlapped. The [live validation](github-mcp-validation-2026-09-05.md) records that stronger proof.

If a call is uncertain, use `audit` and inspect its conversation before deciding the next action. Do not delete reservation files to replay a run. The example deliberately refuses automatic replay of already dispatched calls. Distinct conversations/volumes keep worker execution state separate; shared external services still require their own concurrency and idempotency handling.

## Operations and recovery

| Situation | Action |
|---|---|
| `up` fails | Keep its journal and inspect the recorded stage. Resources are retained; reconcile them or remove the owned deployment using `down`. Do not assume failure means nothing was created. |
| Source snapshot rejects capture | Confirm source port/token, workspace unlock state, supported Codex auth and portable MCP configuration. Quiesce external writers and inspect the source snapshot status. |
| Worker reports `error` or `locked` | Inspect authenticated worker status for restore/decryption/package/credential errors. A Machine in `started` state alone is insufficient. |
| MCP cannot install/connect | Check the pinned source, install/build commands, Linux runtime dependencies, secret metadata and reachability. A copied localhost URL now addresses the worker; local services do not move with it. |
| Cloud model call fails | Verify the actual Codex subscription/provider credential. Bootstrap readiness does not verify model authorization or continued refresh. |
| Request times out after a possible external write | Inspect worker events and the external system; reconcile before retrying. Generic `call` provides no cross-request exactly-once guarantee. |
| Worker restarts | Its matching restore marker preserves changed cloud state and rechecks runtime setup. Running calls may need reconciliation; the source is not recaptured. |
| Local workspace changes | Create a new deployment from a new capture. There is no automatic sync, merge-back or in-place re-clone command. |
| App/journal ownership differs, or extra resources exist | Stop and reconcile identities. Do not bypass ownership checks or use another deployment's journal. |
| Controller crashes | Inspect any journal `.lock`/`.next` files and the matching remote resources before removing stale local files. The helper's reservation files also require outcome reconciliation. |

For read-only infrastructure inspection, use the app recorded in the journal:

```text
fly machine list --app YOUR_APP --json
fly volumes list --app YOUR_APP --json
```

There is no separate bridge `status` command. `up` and `call` check authenticated worker readiness. For direct bootstrap diagnosis, open a private tunnel in a separate terminal using the recorded Machine/app/org:

```text
fly proxy 43460:4200 MACHINE_ID.vm.YOUR_APP.internal --app YOUR_APP --org YOUR_ORG --bind-addr 127.0.0.1
```

Then query status with the worker token already loaded in the controller environment:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:43460/api/worker/status' -Headers @{ Authorization = "Bearer $env:FLUJO_CLOUD_CONTROL_TOKEN" }
```

Close the tunnel when finished. Treat detailed status, application logs and conversation files as private diagnostic data; they can contain workspace identifiers and tool outcomes.

## Remove a deployment

```text
node bin/flujo-cloud.mjs down --journal .flujo-cloud/test-worker.journal.json
```

`down` destroys the dedicated app, its worker and volume after ownership checks. This deletes that worker's durable cloud state. Export any results you need first; the bridge has no automatic result-download or merge-back command. Revoke dedicated external credentials when they are no longer needed.

For the parallel example, run `down` separately with each `worker-1.journal.json`, `worker-2.journal.json` and `worker-3.journal.json` from its plan directory. Retain journals until cleanup is confirmed. Cleanup is explicit; test workers are not automatically deleted after their flow completes.

## Transfer and ownership

The bridge verifies the source ZIP's SHA-256, encrypts it using AES-256-GCM with a fresh random 32-byte key, and writes only the encrypted envelope to its temporary directory. The envelope is `{format:"flujo-workspace-encrypted",version:1,iv,tag,data}`, with base64 fields. The key and remote control token go to `fly secrets import` over stdin. The worker authenticates/decrypts the envelope before checking the plaintext hash.

The Machine initially runs `sleep infinity`. The bridge uploads via `fly ssh sftp put`, uses `fly machine exec` to give the fixed volume paths to the image's `node` user, then starts `/app/scripts/launch-next.mjs`. Both Machine configurations have `services: []`; the bridge allocates no public IP or Fly service. Fly proxy binds only `127.0.0.1` locally and reaches the specific Machine's private IPv6 address. The worker listens on IPv6 and requires its control bearer on worker endpoints.

Creation uses the official HTTPS Machines API to preserve the exact image digest; flyctl 0.4.87 can append a digest twice when resolving positional images. The existing Fly login token is obtained in memory (or supplied by `FLY_API_TOKEN`) and sent only in the HTTPS authorization header. The bridge verifies the Machine's resolved image digest before upload and subsequent use. Configuration updates, secrets, volumes, and private tunnels use Fly CLI.

The journal records the created app ID, owner marker, Machine/volume identities, image, workspace, and snapshot hash. It contains no credential values. Existing apps are never adopted. Fly currently reuses app names as app IDs, so the bridge also creates a random journal-derived **secret-name marker with the nonsecret value `1`**. `down` requires that marker and checks for unexpected Machines or volumes before destroying the dedicated app. Keep this app exclusively for the bridge. A missing marker, changed identity, or foreign resource causes cleanup to stop.

If `up` fails, its journal remains for `down`; the bridge does not hide failures by deleting resources automatically. An uncertain app-creation response without a confirmed app ID requires manual reconciliation. A hard crash can also leave `.lock`/`.next` files or an encrypted temporary file; inspect the journal and remote state before removing those files. Fly CLI failure output is withheld because it can include configuration and credentials.

## Current limits

- Auth mode defaults to `--auth-state=copied-workspace`. This transfers the FLUJO snapshot's supported credentials. It does not export arbitrary OS keyrings. Two machines using copied Codex refresh credentials can interfere when either refreshes; a separate remote login is not implemented by this bridge.
- This is a fork of durable state. Running processes, in-flight calls, local listeners, desktop integrations, external file roots, and ongoing local changes do not move. MCPs must have portable installation plans and remote access to their services.
- Snapshot and encryption buffers are held in memory. The default download cap is 256 MiB (`--max-snapshot-mib` can increase it to 1024); allow additional memory for encrypted/base64 buffers. Machine memory defaults to 2048 MiB and the volume to 2 GiB.
- The encrypted snapshot remains on the private volume for worker restarts. The restored workspace also contains credentials; destroy the dedicated app with `down` when finished. Automatic volume snapshots are disabled at creation.


## Validation

The [three-worker GitHub MCP validation](github-mcp-validation-2026-09-05.md) also passed on 2026-09-05: the locally tested custom server and encrypted GitHub credential were cloned to three Linux Machines. Each Astra flow created and read back one dedicated issue comment through MCP; durable execution timestamps showed 48.970 seconds of overlap. All three used the copied Codex subscription login without an API key.

On 2026-09-05, a private Fly worker running FLUJO commit `5330772856b76ae3661dc9b0c8ec079979b8e265` restored an encrypted `test-cloud` snapshot and executed its existing flow with `gpt-6-astra` using copied Codex subscription authentication, without an API key. The run used all four bundled MCP servers: filesystem read/write, FLUJO model inspection, Bash on Linux, and browser navigation. The existing conversation contained the completed cloud run.

After restarting the same Machine, the worker became ready with its prior conversation and local/cloud proof files intact. A second Astra call read both files through the filesystem MCP and completed successfully. Independent checks confirmed the Codex adapter had an empty API-key field, the copied auth file had mode `0600`, and an unauthenticated worker-status request returned HTTP 401.

This smoke run verifies that particular workspace, login, image, and bundled MCP set. It does not guarantee indefinite credential refresh or portability of arbitrary MCP servers. The automated tests use synthetic credentials and mocked Fly operations; they can run independently of the live account.

Fly references: [Machines API](https://fly.io/docs/machines/api/machines-resource/), [Machine update](https://fly.io/docs/flyctl/machine-update/), [Machine exec](https://fly.io/docs/flyctl/machine-exec/), [private proxy](https://fly.io/docs/flyctl/proxy/), [SFTP upload](https://fly.io/docs/flyctl/ssh-sftp-put/), [secrets import](https://fly.io/docs/flyctl/secrets-import/).
