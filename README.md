# flujo-cloud

Run an existing FLUJO flow on a private Fly Machine. The CLI discovers your local FLUJO instance, selects a compatible official worker image, clones the workspace and manages the worker's control credentials. Your flow uses FLUJO's existing models, conversations, execution engine and portable MCP installations.

## Get started

You need Node.js 22+, the bridge source checkout, an installed and signed-in Fly CLI, and **native** FLUJO running locally with discovery support. Configure and test the flow in FLUJO first; unlock its workspace before cloning.

Start FLUJO with `npx flujo-ai@3.45.2`; no FLUJO Git checkout or local build is required. This version includes native discovery and the Windows startup fix. See [source setup](docs/deployment.md#1-prepare-flujo-locally) for data locations and checkout alternatives. The private workspace profile additionally requires the paired source and image capability described [below](#clone-an-entire-private-workspace); these installation instructions do not establish that capability. Install the cloud CLI from its Git repository:

```text
git clone https://github.com/flujo-app/flujo-cloud.git
cd flujo-cloud
node bin/flujo-cloud.mjs sources
node bin/flujo-cloud.mjs workspaces
node bin/flujo-cloud.mjs preflight --workspace test-cloud --flow FLUJO
node bin/flujo-cloud.mjs up --workspace test-cloud --flow FLUJO
```

The bridge has no npm dependencies. These commands need no manually configured image digest, controller token, journal or local port. `preflight` checks setup without creating cloud resources. `up` creates one paid Machine and persistent volume and returns a worker ID.

If multiple FLUJO instances or Fly organizations are available, select them with `--source URL` or `--org SLUG`. The default region is `iad`; use `--region` to choose another.

Replace `WORKER` with the ID returned by `up`:

```text
node bin/flujo-cloud.mjs call WORKER --prompt "Inspect the workspace and report what this flow can do."
node bin/flujo-cloud.mjs list
node bin/flujo-cloud.mjs down WORKER
```

Calls execute the configured flow tools unattended. `--conversation-id ID` continues a conversation with a new prompt turn. `down` deletes the owned worker and its volume, then removes its saved control credential. `list` reports local deployment records, rather than polling the live fleet.

**Verified September 6, 2026:** the managed path selected a published official image, ran Astra with the restored GitHub MCP and filesystem tools while the local source was stopped, continued the same conversation after a Machine restart, and removed the new worker and its credential. See the [completed managed CLI validation](docs/managed-cli-validation-2026-09-06.md), and the earlier [three-worker GitHub MCP test](docs/github-mcp-validation-2026-09-05.md) for parallel execution.

## What is automatic

Native FLUJO creates an owner-protected local discovery record. The CLI verifies a fresh proof from the advertised process before using its bearer. It reads the source's application, snapshot, layout and worker-protocol versions, checks official GHCR image metadata, and pins the Linux image by digest before provisioning. FLUJO's dedicated publishing workflow updates `cloud-worker` tags independently of release `latest`.

Worker credentials and deployment records are kept privately under `~/.flujo-cloud`. The snapshot is encrypted in transit to the private worker. Portable MCP servers are installed through FLUJO's existing package functions at their Linux locations.

This copies durable workspace state. It does not export arbitrary OS keyrings, move running desktop services or synchronize later changes back. Supported file-backed Codex subscription authentication worked in the recorded test; copied refresh credentials do not provide independent long-term logins. Use a dedicated workspace: selecting a flow limits its execution scope but does not redact other workspace data or credentials.

## Clone an entire private workspace

`--profile private-workspace` explicitly creates a new always-on worker with full workspace dependency capture. The default remains the original flow profile; existing records and workers are never upgraded automatically.

```text
node bin/flujo-cloud.mjs preflight --workspace test-cloud --profile private-workspace --flow FLUJO
node bin/flujo-cloud.mjs up --workspace test-cloud --profile private-workspace --flow FLUJO
```

Here `--flow` chooses the default for later calls. Capture omits the snapshot API's flow selection, so all workspace flows and enabled portable MCP dependencies remain available. An explicit exact flow ID on `call` can address a legitimate flow created or changed in the restored workspace later. The bridge resolves its current unique name at call time. A missing or ambiguous default requires an explicit flow; it does not silently select a replacement.

This profile requires paired FLUJO support: authenticated snapshot info must report numeric `workerSnapshotSourceVersion: 1`, and the selected official immutable image must have the verified OCI label `io.flujo.worker.snapshot-source="1"` and matching application/snapshot/layout/protocol contract. A reported source build revision must match the verified target revision. Native sources without a reported revision are recorded as `sourceRevision: null`, `sourceProvenance: "unknown-native"`; their checkout HEAD is never inferred. The known target revision/digest and observed source contract remain bound to the deployment. Unchecked custom image overrides are refused.

The new worker uses private Fly networking, no public services, persistent data, a dedicated control credential, `always` restart and a UUID/positive recovery epoch allocated once and retained in its records. Current Machine execution configuration and immutable profile/provenance bindings must still match before use. The existing `on-failure` flow workers retain their original behavior.

Preflight checks declared compatibility; full capture must actually reach ready and pass archive SHA verification before any provisioning. There is no source MCP-portability Boolean. This clones a durable point in time, not live synchronization or running desktop services. Source info is sampled and does not attest archive/code provenance. Restart policy and the CLI lock do not provide durable model-call deduplication, OFF authority or safe replay of unknown work; the owning controller must enforce those boundaries.

No live deployment of this new profile is claimed here. The retained September 6 validation covers the established flow path. New image/profile tests use synthetic runners, fetch responses and credentials; actual subscriptions, MCP/tool execution, automation continuity, private voice and PC-off recovery need their own qualification. See [profile details](docs/deployment.md#private-workspace-profile).

## Clone a running private worker

An existing managed `private-workspace` worker can be the source of a new worker without local FLUJO discovery:

```text
node bin/flujo-cloud.mjs clone SOURCE_WORKER --app NEW_UNUSED_APP
```

`ManagedCloud.clone(sourceWorkerId, targetOptions)` uses the source's saved credential and its owned Machine-specific private proxy. It checks the current source ownership, immutable image, execution profile and authenticated readiness, then captures and finalizes the whole current workspace before provisioning. The target receives a fresh app, attempt, control token and recovery UUID. Its default flows inherit the source selection; `--flow ID_OR_NAME` can choose different target defaults without reducing capture scope. Source metadata, credential, journal and default selection remain unchanged.

The source must already be ready under this explicit profile. Legacy/operator workers, incomplete attempts, changed identities/configuration and stopped Machines cannot enter this path. Clone accepts no source URL, credential, data-root, journal or recovery override. It holds the source's managed and operator locks through capture, target handoff and observed proxy child closure. Unconfirmed snapshot/proxy cleanup retains the managed fence and preserves existing journal locks; a target that already reached ready remains recorded. A changed or missing lock requires reconciliation and is never recreated as evidence. Reconcile both outcomes before removing any lock or retrying. Snapshot acknowledgements confirm native session state, not physical staging cleanup or whole-source quiescence. This is a point-in-time clone, not synchronization or proof of provider/OFF authority. See [clone recovery](docs/deployment.md#clone-an-owned-cloud-workspace).

If the target's journal release or metadata binding is uncertain, its own managed fence remains even when the Bridge's observed ready result is retained. That observation does not confirm a later metadata write or changed journal. The original error and target outcome survive a second source-lock cleanup failure too; confirmed source cleanup can release its separate locks. The target cannot be called, cloned or retired until that hold is reconciled.

## Inspect a managed worker

Read the current configuration of an already owned, ready worker:

```text
node bin/flujo-cloud.mjs inspect WORKER
node bin/flujo-cloud.mjs inspect WORKER --timeout-seconds 60
```

The command writes JSON to stdout. Its HTTP observation deadline defaults to 30 seconds, with a maximum of 120 seconds; Fly ownership checks and proxy shutdown use their existing separate bounded timeouts. It uses the saved credential and an exact Machine private proxy to read authenticated worker status, then flow, model and MCP-server metadata. Only an initial status connection failure may repeat that GET, at most three attempts while the proxy starts. It does not provision or start a worker, submit a flow or call a provider. `list` reads local deployment records; `inspect` reads the existing worker.

The bounded report contains whitelisted graph nodes/edges and model/server metadata. Unavailable or truncated data is explicit. Observed flows are separate from journal-permitted calls and selected defaults, especially for legacy flow workers. Metadata and connection-status labels do not qualify tool execution, provider authorization, health or OFF authority. Labels can still be private; keep reports and deployment records outside Git and portable handoffs.

Inspection holds temporary managed/operator locks and a private proxy process. Unconfirmed cleanup retains the reconciliation fence and prevents a success report or automatic replay. See [inspection and recovery](docs/deployment.md#inspect-an-owned-worker).

## Documentation

### Recipient-encrypted native snapshots

When authenticated source metadata advertises the exact recipient-encrypted v2 contract, ordinary bootstrap and full-workspace clone require an officially resolved immutable image with the matching read-version/default-limit labels. The bridge retains a fresh independent 32-byte recipient key privately before native begin, authenticates the v2 envelope with `flujo:workspace-snapshot:v2`, and uploads the same encrypted wire bytes and SHA-256. It does not rewrap v2 or downgrade an unsupported advertised contract. Old sources without encryption metadata keep the original client-encrypted v1 path and record shape.

The new key recovery sidecar is `<journal>.snapshot-key-v2/recipient-key.json`, outside the journal and Machine config. Store the journal parent and sidecar in existing owner-protected private storage outside Git and portable handoffs. Sidecars are ignored by Git, but an ignore rule is not a privacy boundary. Existing sidecars are never adopted, overwritten or automatically deleted, including after ready or uncertain outcomes. A matching native terminal ACK establishes session state only. Live encrypted image/restore/MCP, Windows crash durability, both provider subscriptions and PC-off qualification remain separate requirements. See the [transfer contract and recovery limits](docs/deployment.md#recipient-encrypted-v2-transfer).

- [Managed deployment guide](docs/deployment.md): preparation, commands, selection, recovery and cleanup.
- [Architecture and deployment diagram](docs/architecture.md): repository boundaries, discovery, image selection, credentials and persistence.
- [Operator guide](docs/operator-guide.md): explicit images/journals, custom environments, the three-worker GitHub example and infrastructure diagnostics.
- [Managed CLI validation](docs/managed-cli-validation-2026-09-06.md): official publication, automatic setup and execution with the local source stopped.
- [Verified GitHub MCP run](docs/github-mcp-validation-2026-09-05.md): comments, Machine IDs, concurrent execution and limits.

The CLI source is in [flujo-app/flujo-cloud](https://github.com/flujo-app/flujo-cloud). Native discovery, snapshot/restore, worker images and execution live in [mario-andreschak/FLUJO](https://github.com/mario-andreschak/FLUJO). Deployment metadata and credentials remain privately stored outside this source repository. A future MCP wrapper can use the same `ManagedCloud` methods; this repository does not yet expose an MCP server.

Run `npm test` and `npm run smoke` for synthetic tests and offline CLI checks. They require no cloud resources or real credentials.
