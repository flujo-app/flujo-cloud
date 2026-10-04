# Deploy a flow with the managed CLI

Start with a working local FLUJO flow. The CLI discovers the native instance, chooses a compatible official image, creates a private Fly worker and saves what it needs to call or remove that worker later.

The complete managed lifecycle has been verified: automatic official image selection, an Astra flow using GitHub MCP and filesystem tools with the local source stopped, conversation continuation after a Machine restart, and owned cleanup. See the [September 6 validation record](managed-cli-validation-2026-09-06.md). `preflight` still refuses missing or incompatible images. The earlier [three-worker test](github-mcp-validation-2026-09-05.md) used the explicit-image operator path.

## 1. Prepare FLUJO locally

Use native FLUJO 3.45.2. Local-instance discovery and worker compatibility metadata first shipped in the npm launcher with 3.45.1, but a later Windows consumer test found that initialization could return `500` from `/api/init` even when discovery succeeded. Version 3.45.2 includes the Windows startup fix. Start the prebuilt package directly:

```text
npx flujo-ai@3.45.2
```

This needs no FLUJO Git checkout or local build. The npm launcher stores data in `~/.flujo` by default and registers the running instance automatically. It does not automatically import workspaces from another checkout; configure the workspace in this instance and verify it with `workspaces`. Your MCP servers may still need their own system dependencies. npm releases before 3.45.1 lack the discovery support required by the managed path.

A compatible official worker image must also be published for the source version; `preflight` verifies that separately. npm installation alone does not establish cloud-image compatibility or the additional paired source/image capability required by the [private workspace profile](#private-workspace-profile). The September 6 acceptance run used an updated native checkout before the 3.45.1 npm release.

Alternatively, use an updated native checkout of [FLUJO `main`](https://github.com/mario-andreschak/FLUJO) containing the same Windows startup fix:

```text
git clone https://github.com/mario-andreschak/FLUJO.git FLUJO-cloud-source
cd FLUJO-cloud-source
npm ci
npm run build:mcp
npm run dev
```

For an existing checkout, update it and restart FLUJO through the normal launcher. A production build can use `npm run build` followed by `npm start`. Both the npm and checkout launchers create the source control token and private discovery record automatically, so the bridge needs no manually supplied token or port. Keep the source running through capture; the worker operates independently afterward.

Automatic discovery applies to native localhost mode. Ordinary network/public sources cannot be captured. A paired private worker with the explicit snapshot-source profile can be captured over an authorized private loopback tunnel; it must pass the same dedicated bearer/workspace/runtime checks. Older or container installations with a supported loopback snapshot API can use the [operator interface](operator-guide.md). The CLI does not accept arbitrary remote source URLs.

In FLUJO:

1. Create a dedicated workspace, such as `test-cloud`.
2. Add a model and assign it to the default `FLUJO` flow. The recorded test used one Astra model with Codex subscription authentication.
3. Install the flow's MCP servers through FLUJO's existing installer. Configure API keys as secret environment values or the appropriate supported credential fields, then attach their tools to the flow.
4. Run a representative task locally and check its actual tool results and external outcome.
5. Unlock the workspace if it uses a password. Keep its configuration stable and quiesce external file writers during capture.

MCPs need portable installation plans and services accessible from Linux. Desktop-only integrations, external file roots and local listeners do not move automatically. The tested GitHub package, pinned installation and secret env format are documented in the [operator guide](operator-guide.md#example-install-a-github-mcp-with-an-env-credential).

Supported file-backed Codex ChatGPT authentication can transfer. Arbitrary OS keyrings cannot; shared refresh credentials can interfere when rotated. See the [authentication details](architecture.md#codex-subscription-authentication).

## 2. Install the bridge

Install Node.js 22+ and the Fly CLI, and sign in to the Fly account that will own and pay for the worker. Clone the bridge source repository:

```text
git clone https://github.com/flujo-app/flujo-cloud.git
cd flujo-cloud
node bin/flujo-cloud.mjs --help
```

There are no npm dependencies to install. This bridge is installed from Git rather than a published npm package; run the CLI with Node from the source checkout. It finds `flyctl` in its conventional `~/.fly/bin` location or on PATH and uses the existing Fly login. Its private deployment records and credentials are not source files.

## 3. Discover and check the source

```text
node bin/flujo-cloud.mjs sources
node bin/flujo-cloud.mjs workspaces
node bin/flujo-cloud.mjs preflight --workspace test-cloud --flow FLUJO
```

`sources` lists verified native instances without their credentials. It reads the launcher's private registration and asks that process to prove its identity before sending authenticated workspace requests. It does not scan ports or use whichever browser tab happens to be open. `workspaces` lists workspace names on the selected instance. With more than one source, pass the URL returned by `sources` to subsequent commands:

```text
node bin/flujo-cloud.mjs workspaces --source http://127.0.0.1:4210
node bin/flujo-cloud.mjs preflight --source http://127.0.0.1:4210 --workspace test-cloud --flow FLUJO --org YOUR_ORG
```

`--org` is required when the signed-in Fly account has multiple organizations. The error lists the available organization slugs. Choose where the worker should be billed; the CLI does not guess. `--region` defaults to `iad`.

Preflight checks the selected workspace's snapshot capability, flow identity, source/image compatibility and Fly organization. It does not capture the workspace, create paid resources or execute the flow. A successful preflight is not a model/MCP execution test; capture can still reject a required nonportable dependency.

For `up` and `preflight`, `--flow` accepts an exact flow ID or a unique name. Repeat the flag to select several flows. If omitted, the CLI selects the default FLUJO flow, or the sole available flow. Ambiguous names fail rather than choosing arbitrarily. Flow selection scopes dependencies and permitted calls; it does not remove unrelated workspace files or credentials from the snapshot.

## 4. Create the worker

```text
node bin/flujo-cloud.mjs up --workspace test-cloud --flow FLUJO
```

Include the same `--source`, `--org` and `--region` selections used for preflight if needed. The CLI generates a new app name, worker credential and journal. `--app NEW_NAME` optionally supplies your own unused name.

The command captures the workspace, encrypts it, creates one paid Fly Machine and volume, restores FLUJO, reinstalls the selected portable MCPs and checks authenticated readiness. It returns the worker ID only after readiness matches the workspace and snapshot hash. Existing apps are never adopted; each `up` creates a separate deployment.

Defaults are two shared CPUs, 2048 MiB memory, a 2 GiB volume and a 256 MiB compressed snapshot cap. Use `--memory-mb`, `--volume-gb` or `--max-snapshot-mib` to change these. `--timeout-seconds` defaults to 600 per wait/request, rather than imposing one overall deployment deadline. No public Fly service or IP is allocated, and automatic volume snapshots are disabled at creation.

The official image is resolved and pinned automatically. The resolver checks source version, snapshot format, workspace layout, worker protocol, source labels and Linux architecture before provisioning. Missing or incompatible image metadata stops deployment. The [architecture guide](architecture.md#official-worker-images) explains the dedicated publishing channel; custom digests and manual journal control remain in the [operator guide](operator-guide.md).

## Private workspace profile

For a new dedicated full workspace, add `--profile private-workspace` to both `preflight` and `up`. The default/explicit `--profile flow` retains the original record shape, selected-flow scope, localhost exposure and `on-failure` restart; neither path migrates an existing worker.

```text
node bin/flujo-cloud.mjs preflight --workspace test-cloud --profile private-workspace --flow FLUJO
node bin/flujo-cloud.mjs up --workspace test-cloud --profile private-workspace --flow FLUJO
```

The API equivalent is `ManagedCloud.up({workspace,profile:'private-workspace',flowIds:[...]})`. `flowIds` selects call defaults, resolved by exact ID or unique name in managed preparation. Full-workspace begin omits flow IDs; with the recipient-encrypted contract its only body field is the fresh recipient key, while older sources receive no body. The native capture planner therefore checks all enabled workspace MCP dependencies; a nonportable required dependency, failed snapshot, bad download hash or incomplete finalize stops before creating an app, volume or Machine. Read-only preflight does not perform this capture and is not a portability/model/tool qualification.

The source must report numeric `workerCompatibility.workerSnapshotSourceVersion: 1`. The official target resolver verifies Linux architecture, manifest/config descriptor digests, FLUJO source identity, OCI revision and `io.flujo.worker.snapshot-source="1"`, plus exact application/snapshot/layout/protocol labels. A reported source revision must match the target. A normal native launcher may not report `FLUJO_BUILD_REVISION`; the bridge records that as `sourceRevision: null`, `sourceProvenance: 'unknown-native'` and retains the separately verified `targetRevision` and image digest. It never infers compiled provenance from Git HEAD. The closed observed `sourceCompatibility` and both provenance fields are persisted in metadata/journal, cannot migrate, and managed preparation is compared with the fresh Bridge observation before capture. Sampling does not establish source-image byte identity or bind the archive to a source revision.

Managed `--image` overrides are unchecked and refused for this profile; use the officially verified resolution. The operator API with `--journal` independently resolves that same official source contract and compares it to the supplied immutable digest before capture. A source reached through a private tunnel still uses a loopback origin and the existing dedicated source control token; the target must have a distinct dedicated token. Neither source tokens nor real workspace contents belong in source, logs or portable examples.

New profile records allocate one recovery UUID and positive safe integer epoch before cloud entry. The same values reach idle creation and active bootstrap, and survive calls/restarts without incrementing or replacing them. Target configuration sets worker mode, network exposure, explicit `FLUJO_WORKER_SNAPSHOT_SOURCE=1`, persistent `/data`, and `always` restart without public services. Its image/owner/identity, environment, launch command, mounts, restart and execution overrides are checked against the saved profile before a proxy or model POST. Extra containers/processes, guest-file injection, boot overrides, automatic destruction or scheduled starts are refused. Resource resizing alone does not change this execution profile.

All restored flows remain callable by exact ID, including legitimate additions after restore; the pinned `defaultFlowIds` is not a scope allowlist. A renamed flow is routed using its current unique name. A deleted default, duplicate name, multiple defaults or absent default requires explicit selection or refusal, never an automatic replacement. Several flows without a default and an initially empty workspace may still be captured. This is a durable workspace clone, not bidirectional/live synchronization or a clone of running OS services/keyrings/external file roots.

Worker/bootstrap readiness still checks the assigned workspace/archive digest; there is no new worker-status capability field. The CLI lock excludes overlapping local commands, and existing journals continue to record resource provisioning and owned app destruction. O/FACTORY must supply durable admission and reconciliation of model/provider effects, OFF enforcement and protection against unsafe replay; the CLI lock supplies none of that authority. Unknown/interrupted provisioning or profile/identity mismatches cannot be replayed or upgraded by another `up`/`call`. The controller must reconcile model/provider effects before authorizing new work; restart does not authorize a resend, schedule enrollment or discarded history.

This profile has source fixtures, not a retained live acceptance result. The unchanged September 6 record continues to establish the earlier selected-flow Codex/Astra/GitHub/filesystem MCP path. Full workspace cloning, both subscriptions, communicating flows, scheduler recovery, actual MCP/tools, private phone voice and PC-off operation require separate image/runtime evidence.

## Clone an owned cloud workspace

Use an existing managed worker ID with the explicit `private-workspace` profile:

```text
node bin/flujo-cloud.mjs clone SOURCE_WORKER --app NEW_UNUSED_APP
node bin/flujo-cloud.mjs clone SOURCE_WORKER --flow OTHER_FLOW_ID --org ORG --region iad
```

The API is `ManagedCloud.clone(sourceWorkerId, {app, flowIds, org, region, ...})`. The source's assigned workspace is fixed. Omitted target defaults inherit its recorded `defaultFlowIds`; an explicit flow ID or unique name selects a different target default. An empty selection inherits the source defaults. If a saved default was deleted, select a current flow explicitly rather than silently replacing it. Every capture still omits flow IDs, including with several defaults or an empty workspace; encrypted v2 begin sends the recipient key only. Current enabled MCP dependencies must pass the native full capture planner and download SHA check before any cloud creation. Legitimate restored/new flows remain callable under the existing exact-ID/current-name rules.

The source is read from matched owner-protected managed metadata, credential and operator journal. It must be ready with a confirmed owned app, immutable image, started Machine, exact private execution profile and authenticated workspace/bootstrap hash. The bridge opens one Machine-specific loopback Fly proxy using that saved credential. This does not require a registered desktop source, start a stopped Machine or accept an arbitrary remote URL. Source, token, data-root, journal and recovery overrides are refused; legacy workers cannot be adopted or migrated through clone. The official target image is verified again against the observed source contract. No default model or provider identity is rewritten.

The source managed lock and operator journal lock remain held while the current workspace is captured and finalized, the target attempt is durably handed off, and the source proxy child closes. The target has a distinct app, attempt UUID, dedicated control token and recovery UUID/epoch. Its private metadata binds the source worker/attempt/journal owner/recovery identity for later reconciliation. All original source metadata, credential, journal and defaults stay byte-identical. Only local lock files are created for the source; no source app, volume or Machine is deleted or reconfigured. The workspace snapshot is a point-in-time copy, not live synchronization, an independent provider login, or a copy of running OS services. Source bootstrap readiness does not prove O/FACTORY idleness or a global OFF fence; its owning controller must authorize capture and reconcile admitted work.

Clone requires a bounded terminal finalize acknowledgement matching workspace, session and `finalized`. On capture failure it attempts the original session abort once and requires a matching `aborted` acknowledgement before releasing source fences. Those acknowledgements establish native API session state only: the native service suppresses staging deletion failures, and an abort reply can precede preparation callback completion. They do not prove physical staging removal, source/process quiescence or resolution of model/provider effects. A lost begin identity, lost/malformed finalize acknowledgement, refused abort or unobserved source proxy closure remains uncertain. There is no automatic retry, resource deletion, replacement session or source-history repair. The older default/operator snapshot path retains best-effort abort semantics; every advertised v2 path, including ordinary bootstrap, requires the stricter matching terminal acknowledgement and encryption version.

Snapshot or proxy cleanup uncertainty retains the source managed fence, preserves existing operator locks and reports `CLONE_SOURCE_CLEANUP_UNKNOWN`, preserving the primary cause. Both acquired source lock files normally remain; a changed, replaced or already missing journal lock is reported for reconciliation, never deleted or recreated to manufacture ownership evidence. If the target already reached ready, its result remains available on the error and its metadata, journal, credential and source lineage remain intact. A managed-lock release failure reports `MANAGED_LOCK_CLEANUP_UNKNOWN`, preserves the primary outcome and refuses to remove a changed lock. A replacement operator lock is also preserved after acquired-file identity comparison. These checks protect cooperating local commands; the pathname check and deletion are not an atomic exclusion of arbitrary filesystem writers. Reconcile the original target and source session/process before authorizing another operation or removing a lock. A successful target does not make uncertain source cleanup successful.

Target journal release or outcome-binding uncertainty reports `MANAGED_TARGET_RECONCILIATION_UNKNOWN` and retains the target's managed fence. The original task/cleanup cause is preserved, including failed capture. When the Bridge throws a journal-release error after reaching ready, reconciliation checks its observed app, workspace, Machine, journal path and current saved ready profile against this exact target attempt before retaining that ready result and binding metadata. After an ordinary successful Bridge return, a later journal read or metadata binding failure also retains its observed ready result, original binding cause and managed fence. That result preserves the completed Bridge observation; it does not certify changed/missing records or a successful metadata write. A second source journal-lock cleanup failure carries the same target result and original target error to the outer clone error. Existing or replacement operator locks are preserved; an absent lock is not recreated. No new `call`, `down` or `clone` may bypass the target managed hold. Independently confirmed source cleanup can release the source locks; simultaneous source cleanup uncertainty preserves its own fence. These are local record reconciliation rules, not a retry, replay, cleanup or provider-operation authorization.

The Fly runner now waits for the proxy child's actual `close` event after its one termination request. A bounded timeout remains unknown, including if the child later closes; repeated `stop()` observes the same result and sends no second termination. This strengthens ordinary proxy cleanup too, while retaining legacy profiles and journals. Child-close evidence does not prove closure of every descendant or remote work. Resource destruction remains explicitly journaled by `down`; durable provider/model admission and OFF/replay authority remain O/FACTORY responsibilities.

This new command is covered by synthetic HTTP/Fly/proxy fixtures and real temporary private-file/ACL tests. No live hot-clone, paid provider, full MCP execution, schedule, voice or PC-off qualification follows from those tests. The earlier September validation and its resource identities remain historical evidence for the selected-flow path.

## Recipient-encrypted v2 transfer

The paired native contract is FLUJO PR745/source `d01e095fc6bf9d25d91e78ce423c99c307b10b09`. Earlier PR740 introduced the envelope and PR744 used a historical limits-label name. Only `io.flujo.worker.snapshot-default-limits` is accepted here, without aliases. This source pairing is not a qualified published OCI image or a live deployment. An integrated image must retain the private snapshot-source Cap1, source consent and workspace/cross-process lease protections as well as the encrypted restore contract.

Authenticated `/api/snapshot/info` must report the exact AES-256-GCM recipient contract: write version 2, read versions `[1,2]`, canonical base64 32-byte key, AAD `flujo:workspace-snapshot:v2`, v2 SHA-256 over encrypted wire bytes and v1 SHA-256 over plaintext ZIP. A present unsupported or partial capability is refused. Sources without encryption/limits metadata retain the legacy v1 path; existing metadata/journals are not migrated or upgraded.

Before native begin or provisioning, official resolution validates the actual descriptor/config digests, Linux architecture, FLUJO source/revision and existing application/snapshot/layout/protocol labels. Private profile still requires `io.flujo.worker.snapshot-source="1"`. V2 additionally requires `io.flujo.worker.snapshot-envelope-read-versions="1,2"` and the exact canonical default-limit label:

```json
{"maxFileBytes":268435456,"maxUncompressedBytes":1073741824,"maxManifestBytes":8388608,"maxArchiveBytes":1082130432,"maxEncryptedBytes":1442844672,"maxMembers":65534}
```

All six source limits must fit those verified target defaults. Reported source revisions must match; an absent native revision is never inferred from Git. Unchecked/custom image assertions, historical labels, altered defaults and unqualified OCI `Config.Env` overrides are refused. `FLUJO_SNAPSHOT_MAX_FILE_BYTES` and `FLUJO_SNAPSHOT_MAX_BYTES` are disallowed in target image environment, constructed/observed Machine environment and secret-name metadata. V2 targets also refuse process/container/file or boot overrides that could replace the qualified launch contract; resource sizing stays configurable. Source info is a sample, not source-image byte identity or archive provenance.

The bridge generates an independent recipient key, awaits exclusive private recovery publication, then enters begin once. V2 capture validates bounded begin/status records and matching workspace/session/encryption version, wire size/hash/content type and the closed authenticated envelope. It uploads the identical bytes/hash, delivers the key through secret-import stdin and checks restored workspace/archive SHA using existing readiness. It never rewraps or uses the plaintext digest for v2. Full capture includes every enabled workspace dependency; selecting default flows does not reduce it. Native archive/member/MCP validation remains necessary; bridge envelope authentication is not portability qualification.

Recovery material is `<journal>.snapshot-key-v2/recipient-key.json`, bound to journal owner, target attempt, app, workspace and immutable image. Managed attempts use their existing private controller directory. Direct operator v2 requires the journal parent to exist as an owner-protected plain directory outside Git/portable outputs before entry. Parent/ancestor validation precedes journal/lock creation and is repeated before sidecar creation. Existing sidecars are refused, never read/adopted/replaced or automatically removed. The key is absent from journal, metadata, Machine config, argv and public evidence. Git ignores sidecars as defense in depth; never force-add them or include them in a portable archive.

The key file is synced before publication; POSIX directory entries are synced too. Windows directory/crash durability, hostile concurrent path replacement and full memory erasure are not qualified by this source. A crash can retain a key even if no begin occurred. Reconcile the original attempt/session and remote resources before deciding whether to retire private recovery material. Retention never authorizes replay. Lost begin identity or unconfirmed terminal cleanup remains `SNAPSHOT_CLEANUP_UNKNOWN`; managed target/source fences and already-ready outcomes follow existing reconciliation rules. ACK proves native session state, not physical staging removal or process/provider quiescence.

This companion's source/fixtures require independent review and first execution. No new genuine v2 capture/restore/MCP, provider login, model tool call, paid cloud provisioning, voice, automation or PC-off result is claimed. Preserve the established September selected-flow acceptance and all held/unknown records as their original purposes.

## 5. Call the flow

Replace `WORKER` with the ID returned by `up` or `list`:

```text
node bin/flujo-cloud.mjs call WORKER --prompt "Inspect the workspace and report the available tools."
```

A prompt automatically uses the worker's single selected flow. For multiple selected flows, pass `--flow EXACT_FLOW_ID` on `call`, or supply `--request FILE` with `model` set to that exact flow ID. Model/provider selection still comes from the flow's configuration.

Calls execute the configured flow tools unattended, using FLUJO's completion API default. There is no interactive approval client attached to a worker. An advanced request with `metadata.requireApproval: "true"` can pause or wait for approval; the CLI has no approval/respond command.

`--conversation-id ID` addresses an existing or chosen conversation in this worker. A `--prompt` call appends one new user turn and preserves its existing history. JSON request files retain FLUJO's API semantics: include `metadata.appendMessages: "true"` when the file contains only new messages; without that setting the supplied messages represent the active transcript. The response goes to stdout and may contain private conversation/tool data. Streaming responses are currently buffered until completion. Source FLUJO does not need to keep running after deployment.

Check actual results and external effects. If a request times out after a possible write, inspect its durable conversation and external outcome before retrying. A new `call` is a new dispatch; the generic CLI does not provide exactly-once execution or automatically replay uncertain requests. The [parallel GitHub acceptance helper](operator-guide.md#6-run-the-three-worker-github-acceptance-example) adds durable reservations and comment-marker audits for that particular test.

## Inspect an owned worker

Use the worker ID returned by `up`, `clone` or `list` to read the current remote configuration:

```text
node bin/flujo-cloud.mjs inspect WORKER
node bin/flujo-cloud.mjs inspect WORKER --timeout-seconds 60
```

The managed command writes its JSON report to stdout. The HTTP observation deadline `--timeout-seconds` defaults to 30 and cannot exceed 120; Fly ownership checks and proxy shutdown keep their existing separate bounded timeouts. It uses the existing saved credential, verifies the owned ready Machine, and opens its Machine-specific private loopback proxy. Authenticated worker status is read first, followed by flow, model and MCP-server GETs over that same proxy. Only an initial status connection failure may repeat that GET, at most three attempts while the proxy starts; HTTP refusals and inventory requests are never retried. Inspection needs no local FLUJO discovery and accepts no arbitrary remote source. It does not create resources, start a stopped worker, POST a completion or invoke a provider.

`list` reports local deployment records, including incomplete attempts. `inspect` samples the existing worker's metadata; these reads are sequential observations, not an atomic workspace snapshot. The report projects bounded whitelists for flow graph nodes/edges, model metadata and MCP servers. Missing endpoints or bounded/truncated collections are reported as unavailable or truncated rather than complete. Observed flow IDs, journal-callable selections and defaults remain separate: an observed legacy flow is not automatically admitted for `call`, while private-workspace defaults do not restrict the full restored workspace.

A graph or reported connection status does not prove model authorization, MCP execution, continuous health, provider/OFF authority or an accepted task. The report omits credential/configuration bodies and prompts, but names and labels may still be private. Keep stdout captures and the underlying deployment records in private storage outside Git and portable handoffs.

Inspection takes temporary managed and operator locks and owns a local proxy child. A timeout or unavailable metadata does not authorize a restart or retry of uncertain work. If proxy closure or lock release is unconfirmed, the command retains its reconciliation fence, preserves the original outcome and does not report success or replay automatically. Existing or replaced locks are preserved; absent locks are not recreated as evidence. Reconcile the original operation before removing a fence or retrying.

## 6. Keep track and clean up

```text
node bin/flujo-cloud.mjs list
node bin/flujo-cloud.mjs down WORKER
```

`list` reports the local attempt/journal state, including incomplete deployments. It does not query current Machine health. `down` verifies the owned app, Machine and volume before deletion, then removes the matching saved worker credential. Confirmed preparation-only failures can be retired locally. When cloud creation may have happened but its identity is uncertain, cleanup stops for reconciliation.

Keep `~/.flujo-cloud` until workers are retired. It contains owner-protected credentials and attempt records, including journals needed after interrupted deployment. `down` deletes the worker's durable volume; export results you need first. Local source state is unaffected, and cloud results are not merged back automatically.

## Troubleshooting

| Result | Next step |
|---|---|
| No registered source | Start/restart an updated native FLUJO through its normal launcher in localhost mode; run `sources`. Use operator mode for older/container installations. |
| Several sources or organizations | Select the listed source URL or organization slug explicitly. |
| Workspace locked or busy | Unlock it in FLUJO, or finish the active snapshot/mutation before trying again. |
| Official image missing or incompatible | Check the FLUJO cloud-worker publishing workflow and use a source version with a compatible published image. Do not substitute release `latest`. |
| MCP restore/connect or model call fails | Check portable install configuration, remote reachability and the actual provider login. Bootstrap readiness does not verify continued model authorization. |
| Deployment or call interrupted | Keep all managed records and credentials. Inspect the local journal and remote outcome before retrying or cleaning up. |
| An active/interrupted managed lock is reported | Reconcile the operation and remote state before removing that lock. Removing it blindly can enable overlapping calls or lose cleanup evidence. |
| Worker restarted | Its volume preserves changed durable state. Reconcile interrupted work; restarting does not recapture the source. |

Advanced overrides are optional: `FLYCTL_PATH`, `FLY_API_TOKEN`, `FLUJO_CLOUD_HOME`, `FLUJO_LOCAL_INSTANCE_DIR`, `--channel` and immutable `--image`. Keep controller state outside source workspaces. Details of manual tokens, image builds, infrastructure inspection and parallel testing are retained in the [operator guide](operator-guide.md).
