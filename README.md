# flujo-cloud

Run an existing FLUJO flow on a private Fly Machine. The CLI discovers your local FLUJO instance, selects a compatible official worker image, clones the workspace and manages the worker's control credentials. Your flow uses FLUJO's existing models, conversations, execution engine and portable MCP installations.

## Get started

You need Node.js 22+, the bridge source checkout, an installed and signed-in Fly CLI, and an updated **native** FLUJO checkout running locally. Configure and test the flow in FLUJO first; unlock its workspace before cloning.

For the managed path, use the updated [FLUJO `main` checkout](https://github.com/mario-andreschak/FLUJO), launched with `npm run dev`, or `npm start` after a production build. As of the September 6 validation, the published `flujo-ai` npm release does not yet contain native discovery. See [source setup](docs/deployment.md#1-prepare-flujo-locally). This bridge is installed from its Git repository; it is not a published npm package.

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

## Documentation

- [Managed deployment guide](docs/deployment.md): preparation, commands, selection, recovery and cleanup.
- [Architecture and deployment diagram](docs/architecture.md): repository boundaries, discovery, image selection, credentials and persistence.
- [Operator guide](docs/operator-guide.md): explicit images/journals, custom environments, the three-worker GitHub example and infrastructure diagnostics.
- [Managed CLI validation](docs/managed-cli-validation-2026-09-06.md): official publication, automatic setup and execution with the local source stopped.
- [Verified GitHub MCP run](docs/github-mcp-validation-2026-09-05.md): comments, Machine IDs, concurrent execution and limits.

The CLI source is in [flujo-app/flujo-cloud](https://github.com/flujo-app/flujo-cloud). Native discovery, snapshot/restore, worker images and execution live in [mario-andreschak/FLUJO](https://github.com/mario-andreschak/FLUJO). Deployment metadata and credentials remain privately stored outside this source repository. A future MCP wrapper can use the same `ManagedCloud` methods; this repository does not yet expose an MCP server.

Run `npm test` and `npm run smoke` for synthetic tests and offline CLI checks. They require no cloud resources or real credentials.
