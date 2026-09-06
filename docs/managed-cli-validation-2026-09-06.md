# Managed CLI validation — September 6, 2026

The managed CLI created a private worker from a local `test-cloud` workspace without an explicit source URL, image, token or journal, or manually supplied source/worker control environment variables. The worker selected the published official image and completed an Astra flow using its restored GitHub MCP and filesystem tools while the local FLUJO source was stopped. It then continued the same conversation after a Machine restart and was removed through managed cleanup.

All checks in this managed lifecycle passed. Dates below are UTC. This is a bounded integration test, not a claim of production readiness or independent long-term Codex credential renewal.

## Official image publication

| Evidence | Result |
|---|---|
| [Publish Cloud Worker Image run 33999689534](https://github.com/mario-andreschak/FLUJO/actions/runs/33999689534) | Completed successfully at `2026-09-06T00:01:10Z` |
| [Worker source revision](https://github.com/mario-andreschak/FLUJO/commit/c55ce4410bebc7bb7db66d02144914d5ad068d5a) | `c55ce4410bebc7bb7db66d02144914d5ad068d5a` |
| Registry | `ghcr.io/mario-andreschak/flujo` |
| Verified Linux/amd64 manifest | `sha256:8b5da896c92be52aadd0ad866cf2821d780d81249b9a3a29de80a7b46a0cb709` |

Before publishing the worker tags, the workflow tested the exact built image with an encrypted synthetic snapshot, portable MCP path restoration, filesystem write/read, a real FLUJO ExecutionEngine flow using a local mock model, and persistence across a worker-process restart. The smoke ran without external network access or provider credentials. Publication did not rebuild the tested image or advance release `latest`.

## Live managed deployment

The source was an updated native FLUJO checkout with one Astra model assigned to the default `FLUJO` flow (`default-agent-flujo`) in `test-cloud`. The custom `github-cloud-test` server used the existing portable GitHub installation at commit `f8b0ceb192d129651082e1a652d4f331d29eaaf8`, with `GITHUB_TOKEN` configured as a secret environment value.

The managed path discovered the source, resolved the official image, generated its private control credential and journal, and reached authenticated readiness. The worker was `flujo-test-cloud-9dfa0eaa`, Machine `82d1471ce79d78`.

| Check | Status |
|---|---|
| Managed `up` without manual source/image/token/journal | Passed |
| Official image selected and pinned before provisioning | Passed |
| Private worker authenticated readiness | Passed |
| Local FLUJO stopped before the cloud model call | Confirmed |
| Astra model call through transferred Codex subscription login | Completed |
| Custom GitHub MCP restored at its Linux path and pinned commit | Passed |
| Secret env metadata and encrypted-at-rest value preserved | Passed |
| Codex access/refresh credentials present, API key absent, auth file mode `0600` | Passed; values were not printed |
| GitHub MCP GET `/repos/flujo-app/flujo-cloud-mcp-test/issues/1/comments` | Successful durable tool result |
| Filesystem MCP write/read of the unique marker | Successful durable tool results; complete content/hash and on-disk file matched |
| Saved first-run automated proof report | All checks passed at `2026-09-06T00:19:51.727Z` |
| Restart of the same live Fly Machine | Passed under journal ownership verification, `00:21:22.323Z`–`00:21:38.458Z`; local source remained stopped |
| Second `--prompt` on the same conversation | CLI call completed successfully while local source remained stopped |
| Retained original history and marker readback after the second prompt | All durable continuation checks passed at `2026-09-06T00:23:31.891Z` |
| Managed `down`, app absence and matching credential deletion | Passed at `2026-09-06T00:26:48.572Z`; retired metadata and destroyed journal retained |
| Repeated `down` and preservation of prior workers | Passed; all four existing workers preserved |

The first call used conversation `managed-cli-ae4c17e2-30c2-42d7-9a90-8862edbf7277`. Its marker file was `userdata/managed-cli-ae4c17e2-30c2-42d7-9a90-8862edbf7277.txt`, containing the unique test marker. This call read GitHub comments; it did not need to post another comment. Verification uses the actual MCP envelopes and terminal execution events, rather than the assistant's summary. Reports expose booleans, counts and timestamps, not credentials or GitHub comment bodies.

After the Machine restart, the second `--prompt` preserved the original prompt and appended the continuation prompt in the same saved conversation. The durable proof found 14 saved messages, two completed runs, exactly one successful filesystem read in the second run, no GitHub calls, no filesystem writes and unchanged marker content. The local source remained stopped throughout both cloud calls and the restart.

Managed cleanup returned successfully, Fly confirmed the new app was absent, and its matching local control credential was removed. The retired record and destroyed journal remained for audit; repeated `down` succeeded. All four earlier workers were preserved, and the local test source was restarted afterward. Their earlier parallel GitHub result is documented [separately](github-mcp-validation-2026-09-05.md).

Native autodiscovery passed again after source restoration at `2026-09-06T00:27:55.990Z`, with neither control environment variable configured manually. An unauthenticated snapshot request returned `401`.

The bridge's [CI run 34000557715](https://github.com/flujo-app/flujo-cloud/actions/runs/34000557715) also passed: 110 tests on Windows, and 109 tests with one Windows-only skip on Linux. These synthetic checks complement the live workflow above.

## Using this version

Use the [managed deployment guide](deployment.md). The source currently needs an updated FLUJO `main` checkout launched normally; the published `flujo-ai` npm release does not yet contain native discovery. The bridge is installed from the private `flujo-app/flujo-cloud` Git repository and has no npm runtime dependencies. It is not a public npm package.

This is the CLI path. The shared `ManagedCloud` service is available for a future MCP adapter, but this repository does not expose an MCP server yet. Supported file-backed Codex credentials were exercised here; arbitrary OS keyrings, perpetual refresh coordination, automatic scaling and result merge-back are not implemented.
