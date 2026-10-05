#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { CloudBridge } from '../lib/bridge.mjs';
import { ManagedCloud } from '../lib/managed.mjs';
import { buildPromptRequest } from '../lib/requests.mjs';

const help = `flujo-cloud — private FLUJO workers on Fly Machines

sources                         Discover native local FLUJO instances.
workspaces [--source URL]        List workspaces on the selected instance.
preflight --workspace NAME      Verify setup and compatible official image.
up --workspace NAME [--flow ID_OR_NAME ...]
   [--profile flow|private-workspace]
   [--source URL] [--org SLUG] [--region iad] [--app NEW_NAME]
   [--memory-mb 2048] [--volume-gb 2] [--timeout-seconds 600]
list                            List managed deployment records.
clone WORKER [--app NEW_NAME]    Clone an owned ready private workspace in cloud.
   [--flow ID_OR_NAME ...] [--org SLUG] [--region iad]
call WORKER --prompt TEXT        Run the worker's single selected flow.
call WORKER --request FILE [--conversation-id ID] [--timeout-seconds 600]
down WORKER                     Remove the owned deployment and saved credential.

Native FLUJO discovery, compatible GHCR image selection, immutable digest pinning,
worker names, journals and control credentials are managed automatically.
Fly CLI must be installed and signed in. Multiple instances/organizations need
an explicit selection. Calls run configured tools unattended; submit only tasks
and external actions you have authorized. Prompts append a new conversation turn.
private-workspace captures the whole workspace; --flow only selects call defaults.
It requires a checked official capability image and creates a new always-on worker.
Existing workers keep their recorded profile; no model replay/dedup is provided.
clone keeps the source intact, captures all dependencies over its owned private
proxy, and creates a fresh private-workspace target. It has no --journal/--source
or credential override; legacy workers are not adopted or upgraded.

Advanced/operator mode remains available with --journal PATH:
up --app NAME --org SLUG --region REGION --workspace NAME
   --image REGISTRY/IMAGE@sha256:DIGEST --journal PATH [--source URL]
call --journal PATH --request FILE
down --journal PATH

Operator mode uses the existing source/worker control environment variables.
--image supplies an explicit immutable custom image; --channel selects an
official compatible worker channel. FLUJO_CLOUD_HOME overrides private CLI state.
FLYCTL_PATH and FLY_API_TOKEN remain optional overrides.

up and clone provision paid resources. down destroys only the dedicated journaled app.
Status output omits controller credentials. call writes potentially private
flow results to stdout.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries([
      'app', 'org', 'region', 'workspace', 'image', 'journal', 'source', 'auth-state', 'profile',
      'memory-mb', 'volume-gb', 'timeout-seconds', 'max-snapshot-mib', 'request', 'conversation-id', 'flows', 'channel', 'prompt',
    ].map((name) => [name, { type: 'string' }]).concat([
      ['flow', { type: 'string', multiple: true }], ['help', { type: 'boolean', short: 'h' }],
    ])),
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
  } else {
    const command = positionals[0];
    if (!['sources', 'workspaces', 'preflight', 'up', 'clone', 'list', 'call', 'down'].includes(command)
      || positionals.length > (['clone', 'call', 'down'].includes(command) && !values.journal ? 2 : 1)) throw new Error('Invalid command. Use --help for usage.');
    if (values.profile !== undefined && !['preflight', 'up'].includes(command)) throw new Error('--profile is only supported for preflight and new up deployments.');
    const progress = (message) => process.stderr.write(`${message}\n`);
    const managed = new ManagedCloud({ progress });
    const operator = Boolean(values.journal);
    if (operator && !['up', 'call', 'down'].includes(command)) throw new Error('--journal is only supported with up, call or down.');
    const bridge = operator ? new CloudBridge({ progress }) : null;
    const timeoutMs = Number(values['timeout-seconds'] ?? 600) * 1000;
    let result;
    if (command === 'sources') result = await managed.sources();
    else if (command === 'workspaces') result = await managed.workspaces({ source: values.source });
    else if (command === 'list') result = await managed.list();
    else if (command === 'up' || command === 'preflight' || command === 'clone') {
      const options = {
        app: values.app, org: values.org, region: values.region, workspace: values.workspace,
        image: values.image, journal: values.journal, source: values.source, authState: values['auth-state'],
        profile: values.profile,
        channel: values.channel,
        memoryMb: values['memory-mb'], volumeGb: values['volume-gb'], timeoutMs,
        maxSnapshotBytes: Number(values['max-snapshot-mib'] ?? 256) * 1024 * 1024,
        flowIds: [...(values.flow ?? []), ...(values.flows ? values.flows.split(',').map((value) => value.trim()) : [])],
      };
      result = command === 'clone' ? await managed.clone(positionals[1], options)
        : command === 'preflight' ? await managed.preflight(options) : operator ? await bridge.up(options) : await managed.up(options);
    } else if (command === 'call') {
      if (Boolean(values.request) === Boolean(values.prompt)) throw new Error('Provide exactly one of --request FILE or --prompt TEXT.');
      let request;
      if (values.request) {
        const stat = await fs.stat(values.request);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Request file must be a regular JSON file smaller than 16 MiB.');
        try { request = JSON.parse(await fs.readFile(values.request, 'utf8')); }
        catch { throw new Error('Request file is not valid JSON.'); }
      } else {
        request = buildPromptRequest({ prompt: values.prompt, flowIds: values.flow });
      }
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object.');
      const args = { request, conversationId: values['conversation-id'], timeoutMs };
      const response = operator ? await bridge.call({ journal: values.journal, ...args }) : await managed.call(positionals[1], args);
      process.stdout.write(`${response.body}\n`);
    } else result = operator ? await bridge.down({ journal: values.journal }) : await managed.down(positionals[1]);
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const message = error?.code?.startsWith('ERR_PARSE_ARGS')
    ? 'Invalid command options. Secrets belong in environment variables; use --help.'
    : error instanceof Error ? error.message : 'Command failed.';
  process.stderr.write(`flujo-cloud: ${message}\n`);
  process.exitCode = 1;
}
