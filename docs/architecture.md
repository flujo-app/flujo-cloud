# FLUJO cloud-worker architecture

The feature runs an existing FLUJO workspace in a private cloud Machine. FLUJO captures durable workspace state, restores it on Linux, rebuilds portable MCP runtimes with its existing package installers, and executes the same flows through its existing execution engine.

There are two repositories:

| Repository | Responsibility |
|---|---|
| [mario-andreschak/FLUJO](https://github.com/mario-andreschak/FLUJO) | Native instance registration/challenge, workspace snapshot API and compatibility metadata, portable MCP installation plans, credential capture, worker restore/bootstrap, models, conversations and the ExecutionEngine. Its Dockerfile and dedicated CI workflow produce/publish worker images. |
| [flujo-app/flujo-cloud](https://github.com/flujo-app/flujo-cloud) — this private repository | Node.js CLI and shared `ManagedCloud` application service: verified discovery, official image selection, private controller state, encrypted capture, Fly provisioning, flow calls and owned cleanup. It also contains the explicit three-worker example. |

The bridge has no npm runtime dependencies. It invokes FLUJO's APIs and Fly tooling; it does not implement another execution engine or an independent MCP installer. Deployment is currently CLI-driven. A future MCP adapter can call the same `ManagedCloud` methods (`sources`, `workspaces`, `preflight`, `up`, `call`, `list`, `down`); no MCP server is exposed yet. The bridge does not build images, provide a fleet dashboard, schedule recurring work or synchronize later workspace changes.

## Deployment diagram

![FLUJO deployment diagram](diagrams/deployment.svg)

[Editable Mermaid source](diagrams/deployment.mmd). The diagram includes native discovery, verified image resolution and private controller storage. Dashed arrows describe provisioning/bootstrap; heavy arrows show flow dispatch. Each worker is a separate deployment with its own Fly app, Machine and persistent volume. A single-worker deployment uses the same structure with one worker.

The bridge opens a temporary local loopback proxy to the specific Machine's private address. The apps have no public Fly services or allocated public IPs. Worker requests also require the worker control bearer. Workers make outbound connections to their configured model providers, package repositories and MCP services.

## Local discovery and controller state

Both native FLUJO launchers load the normal runtime environment, select the actual loopback bind and generate a source control token when one was not explicitly configured. After creating the child process they register it under `~/.flujo/instances/<instanceId>.json`. The versioned record contains the process ID, origin, application/data roots and source bearer. It is outside workspace snapshots and protected by an owner-only Windows DACL or Unix directory/file permissions (`0700`/`0600`). Links and nonregular files are rejected. Registration cleanup is best effort; crashed or unreachable instances do not count as available sources.

The CLI reads those private records and challenges `/api/cloud/instance` with a fresh random nonce. The endpoint returns an HMAC over the nonce, instance ID and origin using the source token. The initial request sends no bearer: the endpoint must prove possession before the CLI uses the credential for subsequent requests. Host/origin/forwarding and localhost-exposure checks apply. This installation-wide challenge works while workspace data is locked or migrating, but snapshot access still enforces its own unlock and authorization requirements. Container, worker and network/public modes do not automatically register or generate discovery credentials.

`sources` returns safe metadata for all proven instances. `workspaces`, `preflight` and `up` require an explicit source selection when more than one is available. Billing organization selection is also explicit when Fly lists more than one. There is no port guessing or selection based on the newest running instance.

`ManagedCloud` keeps worker credentials, attempt metadata, journals and operation locks under `~/.flujo-cloud/workers`, using the same OS protection and atomic private-file handling. A separate random worker credential is generated for every deployment. Tokens are not printed or embedded in journal records. Attempt identity binds the credential to its journal, and exclusive operation locks prevent concurrent operations on one managed worker. Defaults can be overridden with `FLUJO_LOCAL_INSTANCE_DIR` or `FLUJO_CLOUD_HOME`; both registries must stay outside source workspace data.

`list` reads this local inventory and reports its state source; it is not a live fleet-health query. `down` removes a credential only after confirmed retirement. Uncertain creation, changed ownership or interrupted locks require reconciliation while preserving the local evidence. The [operator guide](operator-guide.md) retains the older explicit `--journal` interface and manual credentials for custom installations.

## Official worker images

Authenticated `/api/snapshot/info` reports the application's version, snapshot format, workspace layout and worker protocol, plus a build revision when available. The bridge resolves an official Linux/amd64 image from `ghcr.io/mario-andreschak/flujo` using this metadata. Default tag order is:

1. `cloud-worker-<source revision>`, when the source reports a build revision.
2. `cloud-worker-<application version>`.
3. `cloud-worker`.

Only a missing tag falls through. A found image with invalid digest, identity or compatibility metadata stops selection. The resolver checks manifest/config hashes, source and revision labels, architecture and exact application/snapshot/layout/protocol labels, then passes an immutable platform digest to Fly. A matching revision tag must carry the requested source revision. Version/channel fallback guarantees the declared compatibility contract, rather than equality with an unreported local Git checkout. An explicit `--channel` is checked against the same source contract. Operator `--image` accepts an immutable custom digest; its registry labels are not claimed as verified, while restore/readiness checks still apply.

The FLUJO `Publish Cloud Worker Image` workflow builds and tests a main-branch Linux image, then publishes that tested image under revision, application-version and current `cloud-worker` tags. Its offline production smoke uses synthetic state and a mock model, exercises restore/MCP/flow execution and persistence, and needs no provider credentials. This workflow is independent of npm/release publishing and does not advance release `latest`.

Publication of a compatible official image and a live managed deployment are still pending validation. The [earlier GitHub MCP proof](github-mcp-validation-2026-09-05.md) used an explicitly built private image and remains evidence for that recorded implementation/run. The managed resolver does not silently replace a missing compatible image with another release.

## Capture, restore and execution

```mermaid
sequenceDiagram
  actor Operator
  participant Bridge as flujo-cloud CLI
  participant Source as Local FLUJO
  participant Registry as Official GHCR
  participant Fly as Fly API / flyctl
  participant Worker as Cloud FLUJO
  participant MCP as Worker MCP runtime
  participant Service as Model / external API

  Operator->>Bridge: up with workspace and flow name/ID
  Bridge->>Bridge: Read owner-protected instance records
  Bridge->>Source: Fresh nonce challenge (no bearer)
  Source-->>Bridge: HMAC proof of instance identity
  Bridge->>Source: Authenticated workspace/flow/compatibility metadata
  Bridge->>Registry: Resolve and verify compatible image metadata
  Registry-->>Bridge: Linux manifest pinned by digest
  Bridge->>Bridge: Save private worker credential and attempt identity
  Bridge->>Source: Begin snapshot with source bearer
  Source->>Source: Coordinate writers, capture state and portable runtime plan
  Bridge->>Source: Poll status, download ZIP, verify SHA-256
  Bridge->>Source: Finalize capture and remove staging archive
  Bridge->>Bridge: Encrypt ZIP with a fresh AES-256-GCM key
  Bridge->>Fly: Create app, import key and worker bearer, create volume + idle Machine
  Bridge->>Worker: Upload encrypted envelope, start FLUJO
  Worker->>Worker: Decrypt, verify and restore workspace
  Worker->>MCP: Install/rebase packages, restore config, connect
  Bridge->>Worker: Authenticated readiness check for workspace + snapshot hash
  Worker-->>Bridge: ready
  Operator->>Bridge: call WORKER with prompt or request
  Bridge->>Bridge: Load matching saved credential and selected flow
  Bridge->>Worker: Resolve unique flow name, POST completion with flujo=true
  Worker->>Service: Model request using restored credentials
  Worker->>MCP: Execute the flow's selected tools
  MCP->>Service: Tool request using configured credential
  Worker->>Worker: Persist conversation and execution events
  Worker-->>Bridge: Flow response
  Bridge-->>Operator: Response on stdout
```

Capture uses `/api/snapshot/begin`, `/status`, `/download` and `/finalize`; unsuccessful captures attempt `/abort`. These paths are under `/api/snapshot/`. The source runs on the same computer as the bridge and is addressed through loopback HTTP(S).

The source stages a **plaintext ZIP** in a restricted temporary directory; finalize, abort and expiry remove its staging state. After download, the bridge verifies the hash and writes only an **encrypted envelope** to its own temporary directory. The fresh envelope key goes to Fly secrets separately. The cloud worker authenticates and decrypts the envelope, validates the archive, and restores into `/data/flujo/workspaces/<workspace>`.

`/api/worker/status` reports `ready` only after bootstrap and required MCP connection checks. The bridge also checks the requested workspace, archive hash, Machine ownership and actual image digest. A subsequent representative flow call is the end-to-end model/tool test; readiness alone does not prove the model subscription works.

## What moves

| State or dependency | Cloud behavior |
|---|---|
| Workspace flows, model definitions, conversations and execution records | Durable workspace files are captured and restored. FLUJO's workspace database here is JSON/JSONL; this is not a SQLite database-copy mechanism. |
| Userdata and other permitted workspace files | Captured as allowed by the snapshot format. Cloud changes persist on that worker's volume. |
| Secret MCP env values, headers, provider credentials and supported workspace encryption material | Included in the protected workspace transfer. Secret env metadata and encryption are preserved by the existing MCP configuration path. |
| Bundled MCPs | Resolved from the Linux FLUJO image's bundled packages. |
| Supported installed GitHub MCPs | A portable plan records the actual clean local Git commit; the existing installer rebuilds the Node server at a Linux workspace location. |
| `npx` / `uvx` servers | Package-runner configuration is retained and used on the worker. Pin package versions explicitly; an unversioned argument does not become pinned automatically. |
| Remote MCP endpoints | URL and supported authentication configuration transfer. The remote server process stays where it already runs. |
| Local `node_modules`, platform-specific installations and running processes | Recreated where supported; they are not migrated as live processes or copied Windows installations. |
| Browser profiles, Python virtual environments and Codex internal runtime databases | Excluded. Included data files with a live SQLite signature are rejected rather than copied as if they were portable durable state. |
| Arbitrary OS keyrings, desktop sessions, local listeners and external filesystem roots | Not transferred. Required nonportable dependencies fail capture/bootstrap or need explicit cloud-compatible configuration. |
| In-flight work and later local edits | Not moved or synchronized. This is a fork of durable state, not a live VM migration. |

Snapshot coordination covers registered FLUJO writers. Quiesce tools and external processes that write directly into workspace files while capturing. For parallel deployment, keep the source configuration unchanged between the sequential captures.

The package integration reuses installation origins and runtime helpers while preserving the original workspace entity IDs and configuration. It does not re-import the flows, models and conversations through the package-import wizard.

`--flow` selects dependency/startup scope, disables unrelated MCPs in the exported configuration and restricts which flow IDs the bridge's `call` accepts. **It does not redact unrelated workspace data or credentials and is not an authorization boundary.** Use a dedicated workspace when only a particular set of data and credentials should reach the cloud.

## Credentials and trust boundaries

| Credential | Where it is used |
|---|---|
| Source `FLUJO_SNAPSHOT_CONTROL_TOKEN` | Generated by the native launcher when absent; stored in its private per-launch descriptor and used after a valid discovery proof to authenticate local snapshot calls. Explicit configured tokens remain supported. |
| Worker control bearer | Generated and saved privately per managed deployment; imported to the app as its `FLUJO_SNAPSHOT_CONTROL_TOKEN`. Operator mode instead supplies `FLUJO_CLOUD_CONTROL_TOKEN` explicitly. |
| Fresh snapshot encryption key | Generated per deployment and delivered through Fly secrets as `FLUJO_WORKER_SNAPSHOT_KEY`; absent from the journal. |
| Existing Fly login / `FLY_API_TOKEN` | Used by the controller to provision and access Fly; not installed as a workspace credential. |
| MCP and model credentials | Restored with the selected workspace and consumed by the worker's normal adapters/MCP configuration. |
| Optional `FLUJO_GITHUB_AUDIT_TOKEN` | Used by the three-worker example locally for read-only GitHub verification. Worker comments are created through MCP using the separately configured workspace credential. |

The snapshot contains sensitive workspace state, including material needed to use its credentials. The cloud app and volume therefore belong inside the same trust boundary as the source workspace. Encryption of env values at rest does not prevent an authorized worker process from using/decrypting them.

### Codex subscription authentication

FLUJO captures supported file-backed Codex ChatGPT authentication into its managed workspace runtime. The worker's `db/codex-runtime/auth.json` carries the supported access/refresh credentials and is restricted to owner access (`0600` on Linux). FLUJO's Codex adapter then uses that managed runtime for the model call. No Codex API key is needed for this path.

This does **not** export arbitrary Windows Credential Manager/macOS Keychain entries. Explicit Codex `keyring` or `auto` storage modes are rejected, even when a leftover `auth.json` exists. Profile-based, missing or ambiguous/stale credential sources are unsupported instead of being treated as a valid cloud login. A valid file-backed, unprofiled local login is a deployment prerequisite; the local and cloud flow calls verify it actually works.

The [three-worker live test](github-mcp-validation-2026-09-05.md) demonstrated concurrent use of the copied login. It does not guarantee independent long-term refresh: clones share refresh credentials and can interfere when credentials rotate. A separate login or coordinated credential lifecycle for each long-running worker is not implemented by this bridge.

## Persistence, ownership and limits

A worker's volume stores its restored workspace, later conversations/results and the encrypted snapshot. A restart recognizes the matching restore marker and preserves the worker's changed durable state; it does not reset the workspace from the original snapshot. Bootstrap checks/reconnects the MCP runtimes. Running calls are not live-migrated or guaranteed to resume across a crash.

Each deployment journal stores identities, an ownership marker and hashes, not credential values. Managed attempt metadata and its separate credential file bind that journal to the worker. `down` verifies the app marker, Machine and volume before deleting the dedicated app. Extra or mismatched resources stop deletion. Controller state must be retained until a deployment is retired; successful managed cleanup removes its credential and retains the retired record.

The current bridge targets Fly Machines, one Machine and one volume per deployment. Parallelism uses separate deployments. It has no automatic scaling, result merge-back, perpetual credential renewal or automatic replay of uncertain requests. The three-worker example separately guards against replay with durable call reservations and comment-marker audits.

Implementation entry points: [managed application service](../lib/managed.mjs), [discovery](../lib/discovery.mjs), [private storage](../lib/private-files.mjs), [image resolver](../lib/images.mjs), [bridge lifecycle](../lib/bridge.mjs), [snapshot client](../lib/snapshot.mjs), [envelope encryption](../lib/envelope.mjs), [Machine creation](../lib/machines.mjs), [FLUJO snapshot coordinator](https://github.com/mario-andreschak/FLUJO/blob/main/src/backend/services/workspace/snapshotCoordinator.ts), [worker restore](https://github.com/mario-andreschak/FLUJO/blob/main/src/backend/services/workspace/snapshotRestore.ts).

Continue with the [managed deployment guide](deployment.md), or the [operator guide](operator-guide.md) for explicit configuration and infrastructure diagnostics.
