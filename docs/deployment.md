# Deploy a flow with the managed CLI

Start with a working local FLUJO flow. The CLI discovers the native instance, chooses a compatible official image, creates a private Fly worker and saves what it needs to call or remove that worker later.

The complete managed lifecycle has been verified: automatic official image selection, an Astra flow using GitHub MCP and filesystem tools with the local source stopped, conversation continuation after a Machine restart, and owned cleanup. See the [September 6 validation record](managed-cli-validation-2026-09-06.md). `preflight` still refuses missing or incompatible images. The earlier [three-worker test](github-mcp-validation-2026-09-05.md) used the explicit-image operator path.

## 1. Prepare FLUJO locally

Use native FLUJO 3.45.2. Local-instance discovery and worker compatibility metadata first shipped in the npm launcher with 3.45.1, but a later Windows consumer test found that initialization could return `500` from `/api/init` even when discovery succeeded. Version 3.45.2 includes the Windows startup fix. Start the prebuilt package directly:

```text
npx flujo-ai@3.45.2
```

This needs no FLUJO Git checkout or local build. The npm launcher stores data in `~/.flujo` by default and registers the running instance automatically. It does not automatically import workspaces from another checkout; configure the workspace in this instance and verify it with `workspaces`. Your MCP servers may still need their own system dependencies. npm releases before 3.45.1 lack the discovery support required by the managed path.

A compatible official worker image must also be published for the source version; `preflight` verifies that separately. npm installation alone does not establish cloud-image compatibility. The September 6 acceptance run used an updated native checkout before the 3.45.1 npm release.

Alternatively, use an updated native checkout of [FLUJO `main`](https://github.com/mario-andreschak/FLUJO) containing the same Windows startup fix:

```text
git clone https://github.com/mario-andreschak/FLUJO.git FLUJO-cloud-source
cd FLUJO-cloud-source
npm ci
npm run build:mcp
npm run dev
```

For an existing checkout, update it and restart FLUJO through the normal launcher. A production build can use `npm run build` followed by `npm start`. Both the npm and checkout launchers create the source control token and private discovery record automatically, so the bridge needs no manually supplied token or port. Keep the source running through capture; the worker operates independently afterward.

Automatic discovery applies to native localhost mode. Capture is unavailable in network/public exposure: switch the source to localhost mode first. Older or container installations with a supported loopback snapshot API can use the [operator interface](operator-guide.md).

In FLUJO:

1. Create a dedicated workspace, such as `test-cloud`.
2. Add a model and assign it to the default `FLUJO` flow. The recorded test used one Astra model with Codex subscription authentication.
3. Install the flow's MCP servers through FLUJO's existing installer. Configure API keys as secret environment values or the appropriate supported credential fields, then attach their tools to the flow.
4. Run a representative task locally and check its actual tool results and external outcome.
5. Unlock the workspace if it uses a password. Keep its configuration stable and quiesce external file writers during capture.

MCPs need portable installation plans and services accessible from Linux. Desktop-only integrations, external file roots and local listeners do not move automatically. The tested GitHub package, pinned installation and secret env format are documented in the [operator guide](operator-guide.md#example-install-a-github-mcp-with-an-env-credential).

Supported file-backed Codex ChatGPT authentication can transfer. Arbitrary OS keyrings cannot; shared refresh credentials can interfere when rotated. See the [authentication details](architecture.md#codex-subscription-authentication).

## 2. Install the bridge

Install Node.js 22+ and the Fly CLI, and sign in to the Fly account that will own and pay for the worker. Use an authorized GitHub account to clone this private repository:

```text
git clone https://github.com/flujo-app/flujo-cloud.git
cd flujo-cloud
node bin/flujo-cloud.mjs --help
```

There are no npm dependencies to install. This private bridge is not published as a public npm package; run the CLI with Node from the authorized Git checkout. It finds `flyctl` in its conventional `~/.fly/bin` location or on PATH and uses the existing Fly login.

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

## 5. Call the flow

Replace `WORKER` with the ID returned by `up` or `list`:

```text
node bin/flujo-cloud.mjs call WORKER --prompt "Inspect the workspace and report the available tools."
```

A prompt automatically uses the worker's single selected flow. For multiple selected flows, pass `--flow EXACT_FLOW_ID` on `call`, or supply `--request FILE` with `model` set to that exact flow ID. Model/provider selection still comes from the flow's configuration.

Calls execute the configured flow tools unattended, using FLUJO's completion API default. There is no interactive approval client attached to a worker. An advanced request with `metadata.requireApproval: "true"` can pause or wait for approval; the CLI has no approval/respond command.

`--conversation-id ID` addresses an existing or chosen conversation in this worker. A `--prompt` call appends one new user turn and preserves its existing history. JSON request files retain FLUJO's API semantics: include `metadata.appendMessages: "true"` when the file contains only new messages; without that setting the supplied messages represent the active transcript. The response goes to stdout and may contain private conversation/tool data. Streaming responses are currently buffered until completion. Source FLUJO does not need to keep running after deployment.

Check actual results and external effects. If a request times out after a possible write, inspect its durable conversation and external outcome before retrying. A new `call` is a new dispatch; the generic CLI does not provide exactly-once execution or automatically replay uncertain requests. The [parallel GitHub acceptance helper](operator-guide.md#6-run-the-three-worker-github-acceptance-example) adds durable reservations and comment-marker audits for that particular test.

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
