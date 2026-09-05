# GitHub MCP cloud-worker validation — 2026-09-05

**PASS:** the local `test-cloud` workspace and three distinct private Fly Machines executed the default `FLUJO` flow with `gpt-6-astra`. Each posted exactly one identified comment to the dedicated private test issue through its configured GitHub MCP server and verified the comment with a subsequent MCP read.

| Execution | Machine | Verified comment |
|---|---|---|
| Local Windows workspace | Local | [Local comment](https://github.com/flujo-app/flujo-cloud-mcp-test/issues/1#issuecomment-5554786643) |
| Cloud worker 1 | `87477d7a5014e8` | [Worker 1](https://github.com/flujo-app/flujo-cloud-mcp-test/issues/1#issuecomment-5554977929) |
| Cloud worker 2 | `8ed91edf3194d8` | [Worker 2](https://github.com/flujo-app/flujo-cloud-mcp-test/issues/1#issuecomment-5554978045) |
| Cloud worker 3 | `817224b9744028` | [Worker 3](https://github.com/flujo-app/flujo-cloud-mcp-test/issues/1#issuecomment-5554978379) |

All four comments were authored by `flujo-app`. Read-only GitHub audits found one exact body per marker, with no duplicate marker. Cloud run ID: `4bb8cd94-5c24-42f9-9270-7f102ddbd4ce`.

## What ran

- Flow: `default-agent-flujo` (`FLUJO`), assigned to the workspace's single Astra model.
- Custom MCP: community package `github-mcp-server-kosta@3.1.0`, installed as `github-cloud-test` from [ildunari/Github-MCP](https://github.com/ildunari/Github-MCP), pinned to `f8b0ceb192d129651082e1a652d4f331d29eaaf8`.
- Installation used FLUJO's existing `install_mcp_server` authoring function. Hot cloning reused the portable package installation plan; each worker reinstalled the server under its Linux workspace path. Its actual Git checkout matched the pinned commit on every Machine.
- GitHub authentication: secret MCP environment variable `GITHUB_TOKEN`, using a fine-grained token limited to this test repository's Issues read/write and required Metadata read access. It expires September 12, 2026.
- Codex authentication: copied ChatGPT subscription login. Each worker had access/refresh credentials, no Codex API key, and an auth file with mode `0600`.
- GitHub credential metadata and encrypted storage were verified locally and on all workers. The local configuration and process logs did not contain the plaintext token.

The immutable FLUJO image was built from `91396a8e13621dec43db45163338a9aae9002931`:

```text
registry.fly.io/flujo-cloud-test-build-b766975430@sha256:7474df25a369b331a07a0bcfd37c677c25d6d5c8b4830bc1cdc0431dd320bf2f
```

All workers passed authenticated workspace/snapshot readiness and physical image checks. Capture and provisioning ran sequentially against the unchanged local workspace; the three flow requests were then dispatched concurrently, once each.

## Execution evidence

The durable FLUJO conversation logs independently verified, for every worker:

1. A completed flow run.
2. Two successful `github-cloud-test__github_rest_get` calls targeting the exact issue's comments.
3. Exactly one `github-cloud-test__github_create_issue_comment` call with the expected repository, issue and body, and a successful result matching the GitHub comment ID, URL and author.
4. A subsequent readback containing that same created comment.

| Worker | Run started (UTC) | Run completed (UTC) |
|---|---|---|
| 1 | 21:41:52.753 | 21:42:42.104 |
| 2 | 21:41:52.280 | 21:42:43.562 |
| 3 | 21:41:53.134 | 21:42:45.744 |

All three executions overlapped for **48.970 seconds**. The model calls were not retried. The separate read-only inspection was repeated after allowing Git to inspect the specific workspace repository under Fly's administrative exec user; no global Git configuration or flow was changed.

The verification helper passed 19 synthetic checks covering failed runs, failed/missing tool results, wrong targets/authors/bodies, duplicate creation, missing readback and a newer unfinished run. This complements the actual GitHub audit and worker event evidence.

## Published implementation and scope

[FLUJO PR503](https://github.com/mario-andreschak/FLUJO/pull/503) and [PR504](https://github.com/mario-andreschak/FLUJO/pull/504) are merged. The custom-server test exposed secret metadata loss and missing central environment encryption; the fixes use the existing installer and MCP configuration-save paths and remove environment-value logging. Focused checks passed 105 tests plus TypeScript and ESLint. Full CI retained 14 known main-branch test failures and the existing Persona soak failure; these were compared against the baseline rather than treated as new failures. The bridge's reusable three-worker example and lifecycle passed 28 tests.

The three test apps are `flujo-cloud-gh-4bb8cd945c-1`, `-2` and `-3`, each in `iad` with a private Machine and volume. They remain available for inspection. The original single-worker validation app and shared builder/registry resources were preserved.

This validates the current copied Codex login and this MCP package. It does not establish independent long-term refresh for cloned Codex credentials or arbitrary OS-keychain transfer. Copied refresh credentials can interfere after rotation; an independent worker-login lifecycle remains separate work.
