#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { CloudBridge } from '../lib/bridge.mjs';

const help = `flujo-cloud — private FLUJO workers on Fly Machines

up --app NAME --org SLUG --region REGION --workspace NAME
   --image REGISTRY/IMAGE@sha256:DIGEST --journal PATH
   [--source http://127.0.0.1:4200] [--auth-state copied-workspace]
   [--memory-mb 2048] [--volume-gb 2] [--timeout-seconds 600]
   [--max-snapshot-mib 256] [--flow FLOW_ID ...] [--flows ID1,ID2]

call --journal PATH --request FILE [--conversation-id ID] [--timeout-seconds 600]
down --journal PATH

up requires FLUJO_SNAPSHOT_CONTROL_TOKEN and FLUJO_CLOUD_CONTROL_TOKEN in the
environment. call requires FLUJO_CLOUD_CONTROL_TOKEN. Fly uses its existing
login or FLY_API_TOKEN; FLYCTL_PATH can select the flyctl executable.

up provisions paid resources. down destroys only the dedicated journaled app.
No command prints credentials. call writes the flow response to stdout.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries([
      'app', 'org', 'region', 'workspace', 'image', 'journal', 'source', 'auth-state',
      'memory-mb', 'volume-gb', 'timeout-seconds', 'max-snapshot-mib', 'request', 'conversation-id', 'flows',
    ].map((name) => [name, { type: 'string' }]).concat([
      ['flow', { type: 'string', multiple: true }], ['help', { type: 'boolean', short: 'h' }],
    ])),
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
  } else {
    if (positionals.length !== 1 || !['up', 'call', 'down'].includes(positionals[0])) throw new Error('Choose up, call, or down. Use --help for usage.');
    if (!values.journal) throw new Error('--journal is required.');
    const bridge = new CloudBridge({ progress: (message) => process.stderr.write(`${message}\n`) });
    const command = positionals[0];
    const timeoutMs = Number(values['timeout-seconds'] ?? 600) * 1000;
    let result;
    if (command === 'up') {
      result = await bridge.up({
        app: values.app, org: values.org, region: values.region, workspace: values.workspace,
        image: values.image, journal: values.journal, source: values.source, authState: values['auth-state'],
        memoryMb: values['memory-mb'], volumeGb: values['volume-gb'], timeoutMs,
        maxSnapshotBytes: Number(values['max-snapshot-mib'] ?? 256) * 1024 * 1024,
        flowIds: [...(values.flow ?? []), ...(values.flows ? values.flows.split(',').map((value) => value.trim()) : [])],
      });
    } else if (command === 'call') {
      if (!values.request) throw new Error('--request must name a JSON request file.');
      const stat = await fs.stat(values.request);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Request file must be a regular JSON file smaller than 16 MiB.');
      let request;
      try { request = JSON.parse(await fs.readFile(values.request, 'utf8')); }
      catch { throw new Error('Request file is not valid JSON.'); }
      const response = await bridge.call({ journal: values.journal, request, conversationId: values['conversation-id'], timeoutMs });
      process.stdout.write(`${response.body}\n`);
    } else result = await bridge.down({ journal: values.journal });
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const message = error?.code?.startsWith('ERR_PARSE_ARGS')
    ? 'Invalid command options. Secrets belong in environment variables; use --help.'
    : error instanceof Error ? error.message : 'Command failed.';
  process.stderr.write(`flujo-cloud: ${message}\n`);
  process.exitCode = 1;
}
