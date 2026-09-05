# flujo-cloud

A small bridge that runs the existing FLUJO execution engine on a private Fly Machine. It captures one workspace, encrypts the snapshot, restores it into a clean FLUJO container, and forwards flow requests over a local WireGuard proxy.

This package is separate from FLUJO. It does not implement another flow engine, expose a public service, or synchronize changes back to the local workspace.

## Requirements

- Node.js 22+ and an authenticated `flyctl` installation. `FLYCTL_PATH` may point to its executable; Fly also accepts `FLY_API_TOKEN` from the environment.
- Local FLUJO containing the portable snapshot API, started with `FLUJO_SNAPSHOT_CONTROL_TOKEN` set. Unlock its workspace before capturing if it uses a password.
- An immutable FLUJO image **containing the matching worker bootstrap implementation**, such as `ghcr.io/OWNER/flujo@sha256:<digest>`. A current release without these changes cannot run this worker. The bridge neither builds nor publishes an image, and does not require a local Docker daemon.
- An explicit new Fly app name, organization, region, workspace, and local journal filename. `up` creates paid resources: one Machine and one volume.

There are no npm dependencies. Run `npm test` for the mocked end-to-end lifecycle and `npm run smoke` for the offline CLI check. These checks require no Fly login, cloud resources, or real credentials.

## Use

Set `FLUJO_SNAPSHOT_CONTROL_TOKEN` to the source FLUJO control token and `FLUJO_CLOUD_CONTROL_TOKEN` to a separate random token of at least 32 characters. Set secrets through your shell or secret manager; do not put token values in command arguments. Retain the cloud control token for later `call` commands. The bridge stores neither token in its journal.

```text
node bin/flujo-cloud.mjs up --app my-private-worker --org my-org --region bog --workspace default-workspace --image ghcr.io/OWNER/flujo@sha256:DIGEST --journal .flujo-cloud/worker.journal.json
node bin/flujo-cloud.mjs call --journal .flujo-cloud/worker.journal.json --request request.json --conversation-id conversation-id
node bin/flujo-cloud.mjs down --journal .flujo-cloud/worker.journal.json
```

Replace the image with a real lowercase digest reference and choose a region available to your organization. `request.json` uses FLUJO's existing completion request shape, with `model` set to the **flow ID**. The bridge reads that flow from the authenticated worker and translates it to the current endpoint's `flow-<name>` routing form:

```json
{
  "model": "YOUR_FLOW_ID",
  "messages": [{ "role": "user", "content": "Execute the flow." }],
  "stream": false
}
```

Add `--flow FLOW_ID` (repeatable) or `--flows ID1,ID2` to `up` when this worker should run only selected flows. FLUJO resolves their dependencies and disables unrelated MCP servers in the exported copy, leaving the source workspace unchanged. A required nonportable server still fails export. With this scope, `call` requires `request.model` to be one of the exact selected flow IDs recorded in the journal. Omitting the flags captures the workspace's enabled-server scope.

`--conversation-id` sets `metadata.conversationId`; the bridge supplies the saved workspace header and `metadata.flujo: "true"` so FLUJO executes MCP calls inside the worker. The response goes to stdout, so it can be redirected to a file. Streaming responses are currently buffered until completion.
Because the current completion API routes by name, the bridge also rejects duplicate flow names before forwarding the request.

`up` returns success only after authenticated `/api/worker/status` reports `ready` for the requested workspace and exact snapshot hash. Package/MCP bootstrap errors, unavailable authentication, or a different snapshot do not count as success. Readiness checks bootstrap state; use `call` with your representative flow to verify its model and tool dependencies end to end.

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

On 2026-09-05, a private Fly worker running FLUJO commit `5330772856b76ae3661dc9b0c8ec079979b8e265` restored an encrypted `test-cloud` snapshot and executed its existing flow with `gpt-6-astra` using copied Codex subscription authentication, without an API key. The run used all four bundled MCP servers: filesystem read/write, FLUJO model inspection, Bash on Linux, and browser navigation. The existing conversation contained the completed cloud run.

After restarting the same Machine, the worker became ready with its prior conversation and local/cloud proof files intact. A second Astra call read both files through the filesystem MCP and completed successfully. Independent checks confirmed the Codex adapter had an empty API-key field, the copied auth file had mode `0600`, and an unauthenticated worker-status request returned HTTP 401.

This smoke run verifies that particular workspace, login, image, and bundled MCP set. It does not guarantee indefinite credential refresh or portability of arbitrary MCP servers. The 19 automated tests use synthetic credentials and mocked Fly operations; they can run independently of the live account.

Fly references: [Machines API](https://fly.io/docs/machines/api/machines-resource/), [Machine update](https://fly.io/docs/flyctl/machine-update/), [Machine exec](https://fly.io/docs/flyctl/machine-exec/), [private proxy](https://fly.io/docs/flyctl/proxy/), [SFTP upload](https://fly.io/docs/flyctl/ssh-sftp-put/), [secrets import](https://fly.io/docs/flyctl/secrets-import/).
