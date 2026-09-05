import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { CloudBridge, validateOptions } from '../lib/bridge.mjs';
import { sha256, encryptSnapshot } from '../lib/envelope.mjs';
import { Journal } from '../lib/journal.mjs';
import { captureSnapshot } from '../lib/snapshot.mjs';

const sourceToken = 'synthetic_source_control_token_0123456789';
const workerToken = 'synthetic_worker_control_token_0123456789';
const snapshotBytes = Buffer.from('synthetic workspace: provider credentials are test fixtures only');
const snapshotHash = sha256(snapshotBytes);
const flyToken = 'synthetic_fly_api_token_0123456789';
const env = { FLUJO_SNAPSHOT_CONTROL_TOKEN: sourceToken, FLUJO_CLOUD_CONTROL_TOKEN: workerToken, FLY_API_TOKEN: flyToken };
const sessionId = '5cbbd52a-e64c-41a3-8093-4d16656f8f8a';

function json(value, status = 200) { return Response.json(value, { status }); }

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'flujo-cloud-test-'));
  t.after(async () => {
    const relative = path.relative(tmpdir(), directory);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('flujo-cloud-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const options = {
    app: 'synthetic-flujo-worker', org: 'example-org', region: 'iad', workspace: 'test-workspace',
    image: `ghcr.io/example/flujo@sha256:${'a'.repeat(64)}`,
    journal: path.join(directory, 'worker.journal.json'), timeoutMs: 1000,
  };
  const calls = [];
  const requests = [];
  const proxyCalls = [];
  let app;
  let volumes = [];
  let machines = [];
  let uploaded;
  let secretInput;
  let secrets = [];
  let proxyStops = 0;
  let workerState = 'ready';
  let resolvedFlowId;
  let duplicateFlowNames = false;
  let creationDigest;
  let execResult = { exit_code: 0 };
  const value = (args, key) => args[args.indexOf(key) + 1];
  const fly = {
    async run(args, runOptions = {}) {
      calls.push({ args, ...runOptions });
      const [group, command] = args;
      if (group === 'apps' && command === 'list') return JSON.stringify(app ? [app] : []);
      if (group === 'apps' && command === 'create') {
        app = { ID: 'app-immutable-id', Name: options.app, Organization: { Slug: options.org } };
        return JSON.stringify(app);
      }
      if (group === 'secrets' && command === 'import') {
        secretInput = runOptions.input;
        secrets = secretInput.trim().split('\n').map((line) => ({ Name: line.slice(0, line.indexOf('=')) }));
        return '';
      }
      if (group === 'secrets' && command === 'list') return JSON.stringify(secrets);
      if (group === 'volumes' && command === 'create') {
        volumes = [{ id: 'vol_testworker', name: args[2] }];
        return JSON.stringify(volumes);
      }
      if (group === 'volumes' && command === 'list') return JSON.stringify(volumes);
      if (group === 'machine' && command === 'update') {
        machines[0].config = JSON.parse(await fs.readFile(value(args, '--machine-config'), 'utf8'));
        return '';
      }
      if (group === 'machine' && command === 'list') return JSON.stringify(machines);
      if (group === 'machine' && command === 'exec') return JSON.stringify(execResult);
      if (group === 'ssh' && command === 'sftp') { uploaded = await fs.readFile(args[3]); return ''; }
      if (group === 'apps' && command === 'destroy') { app = undefined; machines = []; volumes = []; return ''; }
      throw new Error(`Unexpected test command: ${group} ${command}`);
    },
    async proxy(args) {
      proxyCalls.push(args);
      return { origin: 'http://127.0.0.1:43210', check() {}, async stop() { proxyStops += 1; } };
    },
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.origin === 'https://api.machines.dev') {
      assert.equal(init.headers.Authorization, `Bearer ${flyToken}`);
      const { name, config } = JSON.parse(init.body);
      machines = [{ id: 'ab1234cd5678', name, state: 'started', config,
        image_ref: { digest: creationDigest || config.image.split('@')[1] } }];
      return json(machines[0]);
    }
    if (url.pathname.startsWith('/api/snapshot/')) {
      assert.equal(init.headers.Authorization, `Bearer ${sourceToken}`);
      assert.equal(init.headers['x-flujo-workspace'], options.workspace);
      if (url.pathname.endsWith('/begin')) return json({ sessionId, workspace: options.workspace, state: 'beginning' }, 202);
      if (url.pathname.endsWith('/status')) return json({ sessionId, workspace: options.workspace, state: 'ready', sha256: snapshotHash });
      if (url.pathname.endsWith('/download')) return new Response(Buffer.from(snapshotBytes), { headers: { 'x-flujo-snapshot-sha256': snapshotHash } });
      return json({ state: 'finalized' });
    }
    assert.equal(init.headers.Authorization, `Bearer ${workerToken}`);
    if (url.pathname === '/api/worker/status') return json({ mode: 'worker', state: workerState, workspace: options.workspace, archiveSha256: snapshotHash }, workerState === 'ready' ? 200 : 503);
    if (url.pathname.startsWith('/api/flow/')) {
      resolvedFlowId = decodeURIComponent(url.pathname.slice('/api/flow/'.length));
      return json({ id: resolvedFlowId, name: 'Synthetic Flow' });
    }
    if (url.pathname === '/api/flow') return json([
      { id: resolvedFlowId, name: 'Synthetic Flow' },
      ...(duplicateFlowNames ? [{ id: 'unselected-other-flow', name: 'Synthetic Flow' }] : []),
    ]);
    if (url.pathname === '/v1/chat/completions') return json({ choices: [{ message: { content: 'synthetic flow finished' } }] });
    throw new Error('Unexpected test HTTP endpoint.');
  };
  const bridge = new CloudBridge({ fly, fetchImpl, sleepImpl: async () => undefined, port: async () => 43210 });
  return {
    bridge, fly, fetchImpl, options, calls, requests, proxyCalls,
    uploaded: () => uploaded, secretInput: () => secretInput, proxyStops: () => proxyStops,
    machines: () => machines, volumes: () => volumes,
    clearSecrets: () => { secrets = []; },
    duplicateFlowNames: () => { duplicateFlowNames = true; },
    setCreationDigest: (value) => { creationDigest = value; },
    setExecResult: (value) => { execResult = value; },
    setApp: (value) => { app = value; }, setWorkerState: (value) => { workerState = value; },
  };
}

test('mock lifecycle captures, encrypts, provisions privately, calls the same flow API, and destroys its app', async (t) => {
  const state = await fixture(t);
  const up = await state.bridge.up(state.options, env);
  assert.equal(up.state, 'ready');
  const journal = JSON.parse(await fs.readFile(state.options.journal, 'utf8'));
  assert.equal(journal.appId, 'app-immutable-id');
  assert.equal(journal.archiveSha256, snapshotHash);
  assert.equal(journal.authState, 'copied-workspace');
  assert.equal(state.proxyStops(), 1);

  const secrets = Object.fromEntries(state.secretInput().trim().split('\n').map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), JSON.parse(line.slice(index + 1))];
  }));
  const envelope = JSON.parse(state.uploaded().toString());
  assert.equal(envelope.format, 'flujo-workspace-encrypted');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secrets.FLUJO_WORKER_SNAPSHOT_KEY, 'base64'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]), snapshotBytes);
  assert.equal(secrets.FLUJO_SNAPSHOT_CONTROL_TOKEN, workerToken);
  assert.ok(!JSON.stringify(journal).includes(workerToken));
  assert.ok(!JSON.stringify(journal).includes(secrets.FLUJO_WORKER_SNAPSHOT_KEY));
  assert.ok(!JSON.stringify(state.calls.map((call) => call.args)).includes(workerToken));
  assert.ok(!JSON.stringify(state.calls.map((call) => call.args)).includes(secrets.FLUJO_WORKER_SNAPSHOT_KEY));
  assert.ok(!state.uploaded().includes(snapshotBytes));
  assert.deepEqual(state.machines()[0].config.services, []);
  assert.ok(state.machines()[0].config.init.cmd.includes('::'));
  assert.ok(!state.calls.some((call) => call.args.includes('--port') || call.args[0] === 'ips'));
  assert.ok(!state.calls.some((call) => call.args[0] === 'machine' && call.args[1] === 'run'));
  const creation = state.requests.find((entry) => entry.url.origin === 'https://api.machines.dev');
  assert.equal(JSON.parse(creation.init.body).config.image, state.options.image);
  assert.ok(state.calls.find((call) => call.args[0] === 'volumes' && call.args[1] === 'create').args.includes('--scheduled-snapshots=false'));
  assert.ok(state.calls.find((call) => call.args[0] === 'ssh' && call.args[1] === 'sftp').args.includes('0600'));

  const response = await state.bridge.call({ journal: state.options.journal,
    request: { model: 'flow-id', messages: [{ role: 'user', content: 'go' }] }, conversationId: 'existing-conversation' }, env);
  assert.match(response.body, /synthetic flow finished/);
  const request = state.requests.find((entry) => entry.url.pathname === '/v1/chat/completions');
  assert.equal(request.init.headers['x-flujo-workspace'], state.options.workspace);
  assert.equal(JSON.parse(request.init.body).metadata.conversationId, 'existing-conversation');
  assert.equal(JSON.parse(request.init.body).metadata.flujo, 'true');
  assert.equal(JSON.parse(request.init.body).model, 'flow-Synthetic Flow');
  const lookup = state.requests.find((entry) => entry.url.pathname === '/api/flow/flow-id');
  assert.equal(lookup.url.searchParams.get('workspace'), state.options.workspace);
  assert.equal(state.proxyCalls[0].machineId, 'ab1234cd5678');
  assert.equal(state.proxyStops(), 2);
  assert.equal((await state.bridge.down({ journal: state.options.journal })).state, 'destroyed');
  const deletes = state.calls.filter((call) => call.args[0] === 'apps' && call.args[1] === 'destroy');
  assert.deepEqual(deletes.map((call) => call.args), [['apps', 'destroy', state.options.app, '--yes']]);
  await state.bridge.down({ journal: state.options.journal });
  assert.equal(state.calls.filter((call) => call.args[1] === 'destroy').length, 1);
  assert.ok(state.requests.every((request) => request.init.redirect === 'error'));
});

test('requires immutable images and explicit app, organization, workspace, and region before any provisioning', async (t) => {
  const state = await fixture(t);
  for (const field of ['app', 'org', 'workspace', 'region']) assert.throws(() => validateOptions({ ...state.options, [field]: undefined }));
  await assert.rejects(state.bridge.up({ ...state.options, image: 'ghcr.io/example/flujo:latest' }, env), /immutable/);
  assert.equal(state.calls.length, 0);
});

test('selected flow scope reaches snapshot begin and prevents calls outside that scope', async (t) => {
  const state = await fixture(t);
  await state.bridge.up({ ...state.options, flowIds: ['flow-one', 'flow-two', 'flow-one'] }, env);
  const begin = state.requests.find((entry) => entry.url.pathname.endsWith('/begin'));
  assert.deepEqual(JSON.parse(begin.init.body), { flowIds: ['flow-one', 'flow-two'] });
  const journal = JSON.parse(await fs.readFile(state.options.journal, 'utf8'));
  assert.deepEqual(journal.flowIds, ['flow-one', 'flow-two']);
  await assert.rejects(state.bridge.call({ journal: state.options.journal, request: { model: 'unselected-flow' } }, env), /scoped to selected flows/);
  const response = await state.bridge.call({ journal: state.options.journal, request: { model: 'flow-one' } }, env);
  assert.match(response.body, /synthetic flow finished/);
});

test('call refuses duplicate flow names instead of accidentally executing another flow ID', async (t) => {
  const state = await fixture(t);
  await state.bridge.up({ ...state.options, flowIds: ['selected-flow'] }, env);
  state.duplicateFlowNames();
  await assert.rejects(state.bridge.call({ journal: state.options.journal, request: { model: 'selected-flow' } }, env), /ambiguous/);
  assert.ok(!state.requests.some((request) => request.url.pathname === '/v1/chat/completions'));
});

test('wrong resolved image digest blocks upload while owned cleanup remains available', async (t) => {
  const state = await fixture(t);
  state.setCreationDigest(`sha256:${'b'.repeat(64)}`);
  await assert.rejects(state.bridge.up(state.options, env), /image digest/);
  assert.equal(state.uploaded(), undefined);
  const journal = JSON.parse(await fs.readFile(state.options.journal, 'utf8'));
  assert.equal(journal.machineId, 'ab1234cd5678');
  assert.equal((await state.bridge.down({ journal: state.options.journal })).state, 'destroyed');
});

test('failed volume permission setup prevents credential upload and withholds command output', async (t) => {
  const state = await fixture(t);
  state.setExecResult({ exit_code: 1, stderr: workerToken, stdout: sourceToken });
  await assert.rejects(state.bridge.up(state.options, env), (error) =>
    /permission setup command failed/.test(error.message)
    && !error.message.includes(workerToken) && !error.message.includes(sourceToken));
  assert.equal(state.uploaded(), undefined);
  assert.equal((await state.bridge.down({ journal: state.options.journal })).state, 'destroyed');
});

test('call refuses missing or changed physical image digest before opening a tunnel', async (t) => {
  const state = await fixture(t);
  await state.bridge.up(state.options, env);
  const proxyCount = state.proxyCalls.length;
  for (const digest of [undefined, `sha256:${'b'.repeat(64)}`]) {
    state.machines()[0].image_ref = { digest };
    await assert.rejects(state.bridge.call({ journal: state.options.journal,
      request: { model: 'flow-id' } }, env), /image digest/);
  }
  assert.equal(state.proxyCalls.length, proxyCount);
  assert.ok(!state.requests.some((request) => request.url.pathname === '/v1/chat/completions'));
});

test('never adopts an existing app', async (t) => {
  const state = await fixture(t);
  state.setApp({ ID: 'someone-elses-id', Name: state.options.app, Organization: { Slug: state.options.org } });
  await assert.rejects(state.bridge.up(state.options, env), /already exists/);
  assert.ok(!state.calls.some((call) => call.args[1] === 'create' || call.args[1] === 'destroy'));
});

test('readiness failure keeps ownership journal for cleanup and closes its proxy', async (t) => {
  const state = await fixture(t);
  state.setWorkerState('error');
  await assert.rejects(state.bridge.up(state.options, env), /bootstrap is error/);
  assert.equal(state.proxyStops(), 1);
  assert.equal(JSON.parse(await fs.readFile(state.options.journal, 'utf8')).state, 'failed');
  assert.ok(!state.calls.some((call) => call.args[1] === 'destroy'));
  await state.bridge.down({ journal: state.options.journal });
});

test('down refuses an app whose immutable identity changed', async (t) => {
  const state = await fixture(t);
  await state.bridge.up(state.options, env);
  state.setApp({ ID: 'replacement-app-id', Name: state.options.app, Organization: { Slug: state.options.org } });
  await assert.rejects(state.bridge.down({ journal: state.options.journal }), /identity changed/);
  assert.ok(!state.calls.some((call) => call.args[1] === 'destroy'));
});

test('down refuses a recreated same-name app even when Fly reuses its app ID', async (t) => {
  const state = await fixture(t);
  await state.bridge.up(state.options, env);
  state.clearSecrets();
  await assert.rejects(state.bridge.down({ journal: state.options.journal }), /ownership marker is missing/);
  assert.ok(!state.calls.some((call) => call.args[1] === 'destroy'));
});

test('down refuses unowned volumes and call refuses public service configuration', async (t) => {
  const state = await fixture(t);
  await state.bridge.up(state.options, env);
  state.volumes().push({ id: 'vol_foreign', name: 'foreign_data' });
  await assert.rejects(state.bridge.down({ journal: state.options.journal }), /unowned volume/);
  state.machines()[0].config.services = [{ internal_port: 4200, ports: [{ port: 443 }] }];
  await assert.rejects(state.bridge.call({ journal: state.options.journal, request: {} }, env), /public Fly service/);
  assert.ok(!state.calls.some((call) => call.args[1] === 'destroy'));
});

test('snapshot integrity failure aborts the local session before any Fly mutation', async (t) => {
  const state = await fixture(t);
  const endpoints = [];
  const fetchImpl = async (url, init) => {
    endpoints.push(new URL(url).pathname);
    if (new URL(url).pathname.endsWith('/download')) return new Response('corrupt', { headers: { 'x-flujo-snapshot-sha256': snapshotHash } });
    return state.fetchImpl(url, init);
  };
  await assert.rejects(captureSnapshot({ origin: 'http://127.0.0.1:4200', workspace: state.options.workspace,
    token: sourceToken, fetchImpl }), /SHA-256/);
  assert.equal(endpoints.at(-1), '/api/snapshot/abort');
  assert.ok(!endpoints.includes('/api/snapshot/finalize'));
  assert.equal(state.calls.length, 0);
});

test('snapshot size limit cancels capture rather than accepting an oversized response', async (t) => {
  const state = await fixture(t);
  await assert.rejects(captureSnapshot({ origin: 'http://127.0.0.1:4200', workspace: state.options.workspace,
    token: sourceToken, fetchImpl: state.fetchImpl, maxBytes: 2 }), /size limit/);
  assert.equal(state.requests.at(-1).url.pathname, '/api/snapshot/abort');
});

test('envelope tampering is rejected by authenticated decryption', () => {
  const result = encryptSnapshot(snapshotBytes);
  const envelope = JSON.parse(result.envelope.toString());
  const payload = Buffer.from(envelope.data, 'base64');
  payload[0] ^= 1;
  const decipher = createDecipheriv('aes-256-gcm', result.key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  decipher.update(payload);
  assert.throws(() => decipher.final());
});

test('journal rejects secret fields and serializes conflicting operations', async (t) => {
  const state = await fixture(t);
  const journal = new Journal(state.options.journal);
  assert.throws(() => journal.serialize({ token: workerToken }), /unknown journal field/);
  await journal.locked(async () => {
    await assert.rejects(journal.locked(async () => undefined), /locked/);
  });
});
