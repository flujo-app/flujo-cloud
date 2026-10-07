import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { CloudBridge, validateOptions, buildMachineConfig } from '../lib/bridge.mjs';
import { sha256, encryptSnapshot } from '../lib/envelope.mjs';
import { Journal } from '../lib/journal.mjs';
import { captureSnapshot } from '../lib/snapshot.mjs';
import { buildPromptRequest } from '../lib/requests.mjs';
import { snapshotTransferContract } from '../lib/transfer.mjs';
import { ensurePrivateDirectory, readPrivateJson } from '../lib/private-files.mjs';

const sourceToken = 'synthetic_source_control_token_0123456789';
const workerToken = 'synthetic_worker_control_token_0123456789';
const snapshotBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('synthetic workspace: provider credentials are test fixtures only')]);
const snapshotHash = sha256(snapshotBytes);
const flyToken = 'synthetic_fly_api_token_0123456789';
const env = { FLUJO_SNAPSHOT_CONTROL_TOKEN: sourceToken, FLUJO_CLOUD_CONTROL_TOKEN: workerToken, FLY_API_TOKEN: flyToken };
const sessionId = '5cbbd52a-e64c-41a3-8093-4d16656f8f8a';
const encryptedCompatibility = {
  snapshotEncryption: { format: 'flujo-workspace-encrypted', cipher: 'aes-256-gcm', writeVersion: 2,
    readVersions: [1, 2], legacyPlaintextRead: true, recipientKeyRequired: true, recipientKeyBytes: 32,
    recipientKeyEncoding: 'base64', v2Aad: 'flujo:workspace-snapshot:v2',
    v2Digest: 'sha256-encrypted-wire', v1Digest: 'sha256-plaintext-zip' },
  snapshotLimits: { maxFileBytes: 256 * 1024 * 1024, maxUncompressedBytes: 1024 * 1024 * 1024,
    maxManifestBytes: 8 * 1024 * 1024, maxArchiveBytes: 1032 * 1024 * 1024,
    maxEncryptedBytes: 4 * Math.ceil(1032 * 1024 * 1024 / 3) + 4096, maxMembers: 65_534 },
};

function json(value, status = 200) { return Response.json(value, { status }); }

async function fixture(t, { encryptedExport = false, recipientAck = true } = {}) {
  let exportBytes = snapshotBytes;
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
  const events = [];
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
  let flowName = 'Synthetic Flow';
  let duplicateFlowNames = false;
  let creationDigest;
  let execResult = { exit_code: 0 };
  let sourceVersion = 1;
  let rejectedCapture = false;
  let imageResult;
  let sourceRevision = 'b'.repeat(40);
  let encryptedTransfer = false;
  let sourceEncryption = structuredClone(encryptedCompatibility);
  let beginUnknown = false;
  let nativeWire = snapshotBytes;
  let nativeWireHash = snapshotHash;
  const targetRevision = 'b'.repeat(40);
  const sourceContract = { applicationVersion: '3.45.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
  const value = (args, key) => args[args.indexOf(key) + 1];
  const fly = {
    async run(args, runOptions = {}) {
      calls.push({ args, ...runOptions });
      const [group, command] = args;
      events.push(`fly:${group}:${command}`);
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
      if (group === 'machine' && command === 'exec') return JSON.stringify(args[3] === 'sha256sum /data/worker.snapshot' && execResult.exit_code === 0 ? { exit_code: 0, stdout: sha256(uploaded) + '  /data/worker.snapshot\n' } : execResult);
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
    events.push(`http:${url.pathname}`);
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
      if (url.pathname.endsWith('/info')) return json({ workspace: options.workspace, capability: 'available',
        workerCompatibility: { ...sourceContract, revision: sourceRevision, workerSnapshotSourceVersion: sourceVersion,
          ...(encryptedTransfer ? sourceEncryption : {}) } });
      if (url.pathname.endsWith('/begin')) {
        if (encryptedExport) {
          const selection = JSON.parse(init.body);
          assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(selection.recipientKey));
          exportBytes = encryptSnapshot(snapshotBytes, Buffer.from(selection.recipientKey, 'base64')).envelope;
          nativeWire = exportBytes; nativeWireHash = sha256(exportBytes);
        }
        if (encryptedTransfer) {
          const selection = JSON.parse(init.body);
          const keyRecord = await readPrivateJson(`${options.journal}.snapshot-key-v2/recipient-key.json`);
          assert.equal(selection.recipientKey, keyRecord.key);
          if (beginUnknown) throw new Error('Synthetic begin acknowledgement lost.');
          const key = Buffer.from(selection.recipientKey, 'base64');
          const iv = Buffer.alloc(12, 3);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          cipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2'));
          const data = Buffer.concat([cipher.update(snapshotBytes), cipher.final()]);
          nativeWire = Buffer.from(JSON.stringify({ format: 'flujo-workspace-encrypted', version: 2,
            iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
          nativeWireHash = sha256(nativeWire);
          key.fill(0);
        }
        return json({ sessionId, workspace: options.workspace, state: 'beginning',
          ...(encryptedTransfer ? { encryptionVersion: 2 } : {}) }, 202);
      }
      if (url.pathname.endsWith('/status')) return json({ sessionId, workspace: options.workspace,
        state: rejectedCapture ? 'failed' : 'ready', sha256: nativeWireHash,
        ...(encryptedTransfer ? { encryptionVersion: 2, archiveBytes: nativeWire.length } : {}),
        ...(encryptedExport ? { encrypted: true, recipientKeyUsed: recipientAck, plaintextSha256: snapshotHash } : {}),
        ...(rejectedCapture ? { errorCode: 'UNSAFE_MCP', error: 'A fictional enabled MCP is not portable.' } : {}) });
      if (url.pathname.endsWith('/download')) return new Response(Buffer.from(nativeWire), { headers: {
        'x-flujo-snapshot-sha256': nativeWireHash, ...(encryptedExport ? { 'x-flujo-snapshot-encrypted': 'true', 'x-flujo-snapshot-recipient-key-used': String(recipientAck), 'x-flujo-snapshot-plaintext-sha256': snapshotHash } : {}), ...(encryptedTransfer ? {
          'content-type': 'application/vnd.flujo.workspace-snapshot+json', 'content-length': String(nativeWire.length),
        } : {}) } });
      if (encryptedTransfer) return json({ sessionId, workspace: options.workspace, encryptionVersion: 2,
        state: url.pathname.endsWith('/abort') ? 'aborted' : 'finalized' });
      return json({ state: 'finalized' });
    }
    assert.equal(init.headers.Authorization, `Bearer ${workerToken}`);
    if (url.pathname === '/api/worker/status') return json({ mode: 'worker', state: workerState, workspace: options.workspace, archiveSha256: encryptedTransfer ? nativeWireHash : snapshotHash }, workerState === 'ready' ? 200 : 503);
    if (url.pathname.startsWith('/api/flow/')) {
      resolvedFlowId = decodeURIComponent(url.pathname.slice('/api/flow/'.length));
      return json({ id: resolvedFlowId, name: flowName });
    }
    if (url.pathname === '/api/flow') return json([
      { id: resolvedFlowId, name: flowName },
      ...(duplicateFlowNames ? [{ id: 'unselected-other-flow', name: flowName }] : []),
    ]);
    if (url.pathname === '/v1/chat/completions') return json({ choices: [{ message: { content: 'synthetic flow finished' } }] });
    throw new Error('Unexpected test HTTP endpoint.');
  };
  const bridge = new CloudBridge({ fly, fetchImpl, sleepImpl: async () => undefined, port: async () => 43210,
    resolveImage: async ({ source, profile }) => {
      if (!encryptedTransfer) assert.equal(profile, 'private-workspace');
      assert.equal(source.revision, sourceRevision);
      return imageResult ?? { image: options.image, mode: 'official', compatibility: 'verified',
        ...sourceContract, revision: targetRevision, workerSnapshotSourceVersion: 1,
        ...(encryptedTransfer ? { snapshotEnvelopeReadVersions: [1, 2],
          snapshotTransfer: snapshotTransferContract(encryptedCompatibility) } : {}) };
    } });
  return {
    bridge, fly, fetchImpl, options, calls, requests, proxyCalls, events,
    exported: () => exportBytes,
    uploaded: () => uploaded, secretInput: () => secretInput, proxyStops: () => proxyStops,
    machines: () => machines, volumes: () => volumes,
    clearSecrets: () => { secrets = []; },
    setSecrets: value => { secrets = value; },
    duplicateFlowNames: () => { duplicateFlowNames = true; },
    setCreationDigest: (value) => { creationDigest = value; },
    setExecResult: (value) => { execResult = value; },
    setApp: (value) => { app = value; }, setWorkerState: (value) => { workerState = value; },
    setSourceVersion: value => { sourceVersion = value; }, rejectCapture: () => { rejectedCapture = true; },
    setImageResult: value => { imageResult = value; }, sourceRevision,
    setFlowName: value => { flowName = value; },
    setSourceRevision: value => { sourceRevision = value; }, sourceContract,
    enableV2: async () => { encryptedTransfer = true;
      options.image = `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`;
      await ensurePrivateDirectory(path.dirname(options.journal)); },
    nativeWire: () => nativeWire, nativeWireHash: () => nativeWireHash,
    setSourceLimits: limits => { sourceEncryption.snapshotLimits = limits; },
    loseBegin: () => { beginUnknown = true; },
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
  const selection = JSON.parse(begin.init.body);
  assert.deepEqual(selection.flowIds, ['flow-one', 'flow-two']);
  assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(selection.recipientKey));
  assert.deepEqual(Object.keys(selection).sort(), ['flowIds', 'recipientKey']);
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

test('prompt continuation sends only its new turn with append mode through scoped flow routing', async (t) => {
  const state = await fixture(t);
  const flowId = 'default-agent-flujo';
  await state.bridge.up({ ...state.options, flowIds: [flowId] }, env);
  const request = buildPromptRequest({ prompt: 'Continue with the next step.', flowIds: [flowId] });
  await state.bridge.call({ journal: state.options.journal, request, conversationId: 'existing-conversation' }, env);
  const completion = state.requests.find((entry) => entry.url.pathname === '/v1/chat/completions');
  assert.deepEqual(JSON.parse(completion.init.body), {
    model: 'flow-Synthetic Flow', stream: false,
    messages: [{ role: 'user', content: 'Continue with the next step.' }],
    metadata: { appendMessages: 'true', flujo: 'true', conversationId: 'existing-conversation' },
  });
  assert.equal(completion.init.headers['x-flujo-workspace'], state.options.workspace);
  assert.ok(state.requests.some((entry) => entry.url.pathname === `/api/flow/${flowId}`));
  assert.equal(request.model, flowId);
  assert.equal(request.metadata.conversationId, undefined);
});

test('raw request history and explicit approval/append metadata survive worker forwarding unchanged', async (t) => {
  const state = await fixture(t);
  const flowId = 'default-agent-flujo';
  await state.bridge.up({ ...state.options, flowIds: [flowId] }, env);
  const request = { model: flowId, stream: false,
    messages: [{ role: 'user', content: 'Prior question' }, { role: 'assistant', content: 'Prior answer' },
      { role: 'user', content: 'New question' }],
    metadata: { requireApproval: 'true', appendMessages: 'false', conversationId: 'raw-conversation', custom: 'preserved' } };
  const original = structuredClone(request);
  await state.bridge.call({ journal: state.options.journal, request }, env);
  const completion = state.requests.find((entry) => entry.url.pathname === '/v1/chat/completions');
  assert.deepEqual(JSON.parse(completion.init.body), { ...original, model: 'flow-Synthetic Flow',
    metadata: { ...original.metadata, flujo: 'true' } });
  assert.deepEqual(request, original);
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

test('private-workspace captures full scope before provisioning and binds one recovery identity through idle and active config', async t => {
  const f = await fixture(t);
  await f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['default-agent-flujo'] }, env);
  const record = await new Journal(f.options.journal).read();
  const begin = f.requests.find(r => r.url.pathname === '/api/snapshot/begin');
  assert.deepEqual(Object.keys(JSON.parse(begin.init.body)), ['recipientKey']);
  assert.equal(begin.init.headers['Content-Type'], 'application/json');
  assert.equal(Object.hasOwn(record, 'flowIds'), false);
  assert.deepEqual(record.defaultFlowIds, ['default-agent-flujo']);
  assert.match(record.recoveryId, /^[a-f0-9-]{36}$/);
  assert.equal(record.recoveryEpoch, 1);
  const idle = JSON.parse(f.requests.find(r => r.url.origin === 'https://api.machines.dev').init.body).config;
  const active = f.machines()[0].config;
  for (const config of [idle, active]) {
    assert.equal(config.env.FLUJO_WORKER_MODE, '1');
    assert.equal(config.env.FLUJO_EXPOSURE_MODE, 'network');
    assert.equal(config.env.FLUJO_WORKER_SNAPSHOT_SOURCE, '1');
    assert.equal(config.env.FLUJO_WORKER_RECOVERY_ID, record.recoveryId);
    assert.equal(config.env.FLUJO_WORKER_RECOVERY_EPOCH, '1');
    assert.deepEqual(config.restart, { policy: 'always' });
    assert.deepEqual(config.services, []);
    assert.deepEqual(config.mounts, [{ volume: record.volumeId, path: '/data' }]);
  }
  assert.deepEqual(idle.init.cmd, ['sleep', 'infinity']);
  assert.notDeepEqual(active.init.cmd, idle.init.cmd);
  assert.ok(f.events.indexOf('http:/api/snapshot/finalize') < f.events.indexOf('fly:apps:create'));
  assert.ok(f.events.indexOf('http:/api/snapshot/download') < f.events.indexOf('fly:volumes:create'));
  const response = await f.bridge.call({ journal: f.options.journal, request: { messages: [] } }, env);
  assert.match(response.body, /synthetic flow finished/);
  const sent = JSON.parse(f.requests.find(r => r.url.pathname === '/v1/chat/completions').init.body);
  assert.equal(sent.model, 'flow-Synthetic Flow');
  assert.equal((await new Journal(f.options.journal).read()).recoveryId, record.recoveryId);
});

test('private-workspace uses current flow names and later restored flow IDs without narrowing to the pinned default', async t => {
  const f = await fixture(t);
  await f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['default-agent-flujo'] }, env);
  f.setFlowName('Renamed Current Flow');
  await f.bridge.call({ journal: f.options.journal, request: { model: 'created-after-restore', messages: [] } }, env);
  assert.equal(f.requests.find(r => r.url.pathname.startsWith('/api/flow/')).url.pathname, '/api/flow/created-after-restore');
  assert.equal(JSON.parse(f.requests.find(r => r.url.pathname === '/v1/chat/completions').init.body).model, 'flow-Renamed Current Flow');
  assert.deepEqual((await new Journal(f.options.journal).read()).defaultFlowIds, ['default-agent-flujo']);
});

test('private-workspace refuses absent source capability or unverified/mismatched target before capture and provisioning', async t => {
  for (const variant of ['source', 'unchecked', 'marker', 'revision', 'digest']) {
    const f = await fixture(t);
    if (variant === 'source') f.setSourceVersion(undefined);
    else f.setImageResult({ image: f.options.image, mode: 'official', compatibility: 'verified',
      ...f.sourceContract, revision: f.sourceRevision, workerSnapshotSourceVersion: 1,
      ...(variant === 'unchecked' ? { mode: 'explicit', compatibility: 'unchecked' }
        : variant === 'marker' ? { workerSnapshotSourceVersion: 0 }
          : variant === 'revision' ? { revision: 'c'.repeat(40) } : { image: `ghcr.io/example/flujo@sha256:${'c'.repeat(64)}` }) });
    await assert.rejects(f.bridge.up({ ...f.options, profile: 'private-workspace' }, env), /source|verified|capability/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.requests.some(r => r.url.pathname === '/api/snapshot/begin'), false);
    await assert.rejects(fs.stat(f.options.journal), { code: 'ENOENT' });
  }
});

test('full-workspace nonportable enabled MCP refusal retains failed capture and never provisions or posts a model', async t => {
  const f = await fixture(t);
  f.rejectCapture();
  await assert.rejects(f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['default-agent-flujo'] }, env), /snapshot did not complete/);
  const record = await new Journal(f.options.journal).read();
  assert.equal(record.state, 'failed');
  assert.equal(record.stage, 'snapshot');
  assert.equal(record.appCreated, false);
  const selection = JSON.parse(f.requests.find(r => r.url.pathname === '/api/snapshot/begin').init.body);
  assert.deepEqual(Object.keys(selection), ['recipientKey']);
  assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(selection.recipientKey));
  assert.equal(f.requests.at(-1).url.pathname, '/api/snapshot/abort');
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.some(r => r.url.pathname === '/v1/chat/completions'), false);
});

test('private-workspace refuses execution/config drift before model dispatch or deletion and accepts omitted empty services/init alternatives', async t => {
  const mutations = [
    c => { c.env.FLUJO_WORKER_SNAPSHOT_SOURCE = '0'; }, c => { c.env.FLUJO_EXPOSURE_MODE = 'localhost'; },
    c => { c.env.FLUJO_WORKER_RECOVERY_ID = 'substituted'; }, c => { c.env.FLUJO_WORKER_RECOVERY_EPOCH = '2'; },
    c => { c.env.FLUJO_DATA_DIR = '/tmp/state'; }, c => { c.env.NODE_OPTIONS = '--import=/tmp/unreviewed.mjs'; },
    c => { c.restart = { policy: 'on-failure', max_retries: 3 }; }, c => { c.mounts[0].volume = 'vol_other'; },
    c => { c.metadata.flujo_cloud_profile = 'other'; }, c => { c.init.cmd = ['sleep', 'infinity']; },
    c => { c.init.entrypoint = ['sh', '-c']; }, c => { c.init.exec = ['unreviewed']; },
    c => { c.containers = [{ image: 'unreviewed', services: [] }]; },
    c => { c.files = [{ guest_path: '/app/scripts/launch-next.mjs', raw_value: 'fictional override' }]; },
    c => { c.files = {}; }, c => { c.processes = [{ cmd: ['unreviewed'], env: { NODE_OPTIONS: 'unreviewed' } }]; },
    c => { c.processes = {}; }, c => { c.init.kernel_args = ['unreviewed']; },
    c => { c.guest.kernel_args = ['unreviewed']; }, c => { c.auto_destroy = true; }, c => { c.auto_destroy = 'false'; },
    c => { c.schedule = 'daily'; }, c => { c.schedule = false; },
    c => { c.services = [{ internal_port: 4200, ports: [{ port: 443 }] }]; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    await f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['default-agent-flujo'] }, env);
    mutate(f.machines()[0].config);
    const before = await fs.readFile(f.options.journal);
    const proxiesBefore = f.proxyCalls.length;
    await assert.rejects(f.bridge.call({ journal: f.options.journal, request: { messages: [] } }, env), /configuration|command/);
    await assert.rejects(f.bridge.down({ journal: f.options.journal }), /configuration|command/);
    assert.deepEqual(await fs.readFile(f.options.journal), before);
    assert.equal(f.requests.some(r => r.url.pathname === '/v1/chat/completions'), false);
    assert.equal(f.calls.some(c => c.args[0] === 'apps' && c.args[1] === 'destroy'), false);
    assert.equal(f.proxyCalls.length, proxiesBefore);
  }
  const f = await fixture(t);
  await f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['default-agent-flujo'] }, env);
  delete f.machines()[0].config.services;
  f.machines()[0].config.files = null;
  f.machines()[0].config.processes = [];
  f.machines()[0].config.containers = [];
  f.machines()[0].config.init.entrypoint = null;
  f.machines()[0].config.init.exec = [];
  f.machines()[0].config.init.kernel_args = [];
  f.machines()[0].config.guest.kernel_args = null;
  f.machines()[0].config.guest.memory_mb = 4096;
  f.machines()[0].config.auto_destroy = false;
  f.machines()[0].config.schedule = '';
  const machine = f.machines()[0];
  machine.Config = machine.config; delete machine.config;
  machine.ID = machine.id; delete machine.id;
  machine.Name = machine.name; delete machine.name;
  machine.ImageRef = { Digest: machine.image_ref.digest }; delete machine.image_ref;
  await f.bridge.call({ journal: f.options.journal, request: { messages: [] } }, env);
});

test('private-workspace unknown/incomplete journal stages refuse calls without reposting, even on a ready Machine', async t => {
  for (const change of [{ state: 'failed' }, { state: 'unknown' }, { stage: 'bootstrap' }, { stage: 'new-unknown-stage' }]) {
    const f = await fixture(t);
    await f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['default-agent-flujo'] }, env);
    const journal = new Journal(f.options.journal);
    await journal.save({ ...(await journal.read()), ...change });
    const before = await fs.readFile(f.options.journal);
    await assert.rejects(f.bridge.call({ journal: f.options.journal, request: { messages: [] } }, env), /incomplete or unknown/);
    assert.deepEqual(await fs.readFile(f.options.journal), before);
    assert.equal(f.requests.some(r => r.url.pathname === '/v1/chat/completions'), false);
  }
});

test('legacy flow records/config remain original and legacy Machines cannot opt themselves into private recovery', async t => {
  const f = await fixture(t);
  await f.bridge.up({ ...f.options, flowIds: ['selected-flow'] }, env);
  const record = await new Journal(f.options.journal).read();
  for (const key of ['profile', 'recoveryId', 'recoveryEpoch', 'defaultFlowIds']) assert.equal(Object.hasOwn(record, key), false);
  assert.deepEqual(record.flowIds, ['selected-flow']);
  assert.deepEqual(f.machines()[0].config.restart, { policy: 'on-failure', max_retries: 3 });
  assert.equal(f.machines()[0].config.env.FLUJO_EXPOSURE_MODE, 'localhost');
  assert.equal(f.machines()[0].config.env.FLUJO_WORKER_SNAPSHOT_SOURCE, undefined);
  const selection = JSON.parse(f.requests.find(r => r.url.pathname === '/api/snapshot/begin').init.body);
  assert.deepEqual(selection.flowIds, ['selected-flow']);
  assert.deepEqual(Object.keys(selection).sort(), ['flowIds', 'recipientKey']);
  assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(selection.recipientKey));
  f.machines()[0].config.env.FLUJO_WORKER_SNAPSHOT_SOURCE = '1';
  await assert.rejects(f.bridge.call({ journal: f.options.journal, request: { model: 'selected-flow' } }, env), /migration/);
  assert.equal(f.requests.some(r => r.url.pathname === '/v1/chat/completions'), false);
});

test('profile identity/type/migration errors refuse before any command and journal save preserves original bytes', async t => {
  const f = await fixture(t);
  const recoveryId = '5cbbd52a-e64c-41a3-8093-4d16656f8f8a';
  for (const bad of [{ profile: 'unknown' }, { profile: null }, { profile: 'flow', recoveryId, recoveryEpoch: 1 },
    { profile: 'private-workspace', recoveryId }, { profile: 'private-workspace', recoveryEpoch: 1 },
    ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map(recoveryEpoch => ({ profile: 'private-workspace', recoveryId, recoveryEpoch })),
    { profile: 'private-workspace', recoveryId: { toString: () => recoveryId }, recoveryEpoch: 1 },
    { profile: 'private-workspace', defaultFlowIds: ['one'], flowIds: ['other'] }]) {
    await assert.rejects(f.bridge.up({ ...f.options, ...bad }, env));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
  await f.bridge.up({ ...f.options, profile: 'private-workspace' }, env);
  const journal = new Journal(f.options.journal),record = await journal.read(),before = await fs.readFile(f.options.journal);
  for (const change of [{ profile: 'unknown' }, { recoveryId }, { recoveryEpoch: 2 }, { defaultFlowIds: ['new-default'] }, { flowIds: ['scoped'] }]) {
    await assert.rejects(journal.save({ ...record, ...change }), /profile|identity|selection|scope|migration/);
    assert.deepEqual(await fs.readFile(f.options.journal), before);
  }
  const legacy = await fixture(t);
  await legacy.bridge.up(legacy.options, env);
  const old = await new Journal(legacy.options.journal).read(),oldBytes = await fs.readFile(legacy.options.journal);
  await assert.rejects(new Journal(legacy.options.journal).save({ ...old, profile: 'private-workspace', recoveryId, recoveryEpoch: 1,
    defaultFlowIds: [], sourceCompatibility: record.sourceCompatibility, sourceRevision: record.sourceRevision,
    sourceProvenance: record.sourceProvenance, targetRevision: record.targetRevision }), /migration/);
  assert.deepEqual(await fs.readFile(legacy.options.journal), oldBytes);
  assert.deepEqual(buildMachineConfig(old, { idle: false }).restart, { policy: 'on-failure', max_retries: 3 });
});

test('explicit full capture rejects mixed or unknown scope before sending any source request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not fetch'); };
  for (const selection of [{ scope: 'workspace', flowIds: ['flow'] }, { scope: 'workspace', flowIds: [] }, { scope: 'unknown' }]) {
    await assert.rejects(captureSnapshot({ origin: 'http://127.0.0.1:4200', workspace: 'synthetic', token: sourceToken, fetchImpl, ...selection }), /scope|flowIds/);
  }
  assert.equal(calls, 0);
});

test('unknown native revision remains explicit while verified target provenance is retained, and changed prepared source refuses', async t => {
  const f = await fixture(t);
  f.setSourceRevision(undefined);
  await f.bridge.up({ ...f.options, profile: 'private-workspace' }, env);
  const record = await new Journal(f.options.journal).read();
  assert.equal(record.sourceRevision, null);
  assert.equal(record.sourceProvenance, 'unknown-native');
  assert.equal(record.targetRevision, 'b'.repeat(40));
  assert.deepEqual(record.sourceCompatibility, { ...f.sourceContract, workerSnapshotSourceVersion: 1 });
  const changed = await fixture(t);
  await assert.rejects(changed.bridge.up({ ...changed.options, profile: 'private-workspace',
    sourceCompatibility: { ...changed.sourceContract, workerSnapshotSourceVersion: 1 },
    sourceRevision: null, sourceProvenance: 'unknown-native', targetRevision: changed.sourceRevision }, env), /identity changed|migration/);
  assert.equal(changed.calls.length, 0);
  assert.equal(changed.requests.some(r => r.url.pathname === '/api/snapshot/begin'), false);
});

test('private source/target contract pins reject partial or changed provenance and equal source/target controller tokens', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.up({ ...f.options, profile: 'private-workspace', sourceRevision: null }, env), /provenance|contract/);
  await assert.rejects(f.bridge.up({ ...f.options, profile: 'private-workspace' }, { ...env, FLUJO_CLOUD_CONTROL_TOKEN: sourceToken }), /dedicated target credential/);
  assert.equal(f.requests.length, 0);
  await f.bridge.up({ ...f.options, profile: 'private-workspace' }, env);
  const journal = new Journal(f.options.journal),record = await journal.read(),before = await fs.readFile(f.options.journal);
  for (const change of [{ sourceCompatibility: { ...record.sourceCompatibility, layoutVersion: 3 } },
    { sourceRevision: null, sourceProvenance: 'unknown-native' },
    { targetRevision: 'c'.repeat(40) }, { sourceCompatibility: { ...record.sourceCompatibility, authorized: true } }]) {
    await assert.rejects(journal.save({ ...record, ...change }), /identity changed|migration|provenance|contract/);
    assert.deepEqual(await fs.readFile(f.options.journal), before);
  }
});

test('ordinary v2 bootstrap uploads identical native ciphertext, preserves selected flows and uses only private key/stdin', async t => {
  const f = await fixture(t); await f.enableV2();
  await f.bridge.up({ ...f.options, flowIds: ['synthetic-selected-flow'] }, env);
  const record = await new Journal(f.options.journal).read();
  const retained = await readPrivateJson(`${f.options.journal}.snapshot-key-v2/recipient-key.json`);
  const inputKey = JSON.parse(f.secretInput().split('\n').find(line => line.startsWith('FLUJO_WORKER_SNAPSHOT_KEY='))
    .slice('FLUJO_WORKER_SNAPSHOT_KEY='.length));
  assert.equal(inputKey, retained.key);
  assert.equal(retained.journalOwner, record.owner); assert.equal(retained.attemptId, record.owner);
  assert.deepEqual(f.uploaded(), f.nativeWire());
  assert.equal(record.archiveSha256, sha256(f.uploaded()));
  assert.notEqual(record.archiveSha256, snapshotHash);
  assert.equal(JSON.parse(f.uploaded()).version, 2);
  assert.deepEqual(JSON.parse(f.requests.find(r => r.url.pathname === '/api/snapshot/begin').init.body).flowIds,
    ['synthetic-selected-flow']);
  assert.ok(f.events.indexOf('http:/api/snapshot/finalize') < f.events.indexOf('fly:apps:create'));
  assert.equal(JSON.stringify(record).includes(retained.key), false);
  assert.equal(JSON.stringify(f.calls.map(c => c.args)).includes(retained.key), false);
  assert.equal(JSON.stringify(f.machines()[0].config).includes(retained.key), false);
  assert.deepEqual(f.machines()[0].config.restart, { policy: 'on-failure', max_retries: 3 });
});

test('private v2 bootstrap captures every flow with recipient key only and keeps Cap1/identity/always restart', async t => {
  const f = await fixture(t); await f.enableV2();
  await f.bridge.up({ ...f.options, profile: 'private-workspace', flowIds: ['synthetic-default'] }, env);
  const record = await new Journal(f.options.journal).read();
  const selection = JSON.parse(f.requests.find(r => r.url.pathname === '/api/snapshot/begin').init.body);
  assert.deepEqual(Object.keys(selection), ['recipientKey']);
  assert.deepEqual(record.defaultFlowIds, ['synthetic-default']);
  assert.equal(record.sourceCompatibility.workerSnapshotSourceVersion, 1);
  assert.equal(record.snapshotTransfer.encryptionVersion, 2);
  assert.deepEqual(f.uploaded(), f.nativeWire());
  assert.equal(f.machines()[0].config.env.FLUJO_WORKER_SNAPSHOT_SOURCE, '1');
  assert.equal(f.machines()[0].config.env.FLUJO_WORKER_RECOVERY_ID, record.recoveryId);
  assert.deepEqual(f.machines()[0].config.restart, { policy: 'always' });
});

test('every source cap and unqualified target bounds prevent encrypted begin and all provisioning', async t => {
  for (const key of Object.keys(encryptedCompatibility.snapshotLimits)) {
    const f = await fixture(t); await f.enableV2();
    const limits = { ...encryptedCompatibility.snapshotLimits, [key]: encryptedCompatibility.snapshotLimits[key] + 1 };
    if (key === 'maxUncompressedBytes') {
      limits.maxArchiveBytes = limits.maxUncompressedBytes + limits.maxManifestBytes;
      limits.maxEncryptedBytes = 4 * Math.ceil(limits.maxArchiveBytes / 3) + 4096;
    }
    f.setSourceLimits(limits);
    await assert.rejects(f.bridge.up(f.options, env), /contract|bounds/);
    assert.equal(f.requests.some(r => r.url.pathname === '/api/snapshot/begin'), false);
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.lstat(f.options.journal), { code: 'ENOENT' });
  }
  for (const profile of [undefined, 'private-workspace']) {
    const f = await fixture(t); await f.enableV2();
    f.setImageResult({ image: f.options.image, mode: 'official', compatibility: 'verified', revision: f.sourceRevision,
      ...f.sourceContract, workerSnapshotSourceVersion: 1, snapshotEnvelopeReadVersions: [1, 2] });
    await assert.rejects(f.bridge.up({ ...f.options, profile }, env), /restore bounds/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.requests.some(r => r.url.pathname === '/api/snapshot/begin'), false);
  }
});

test('ordinary and private v2 observed config or secret-bound drift refuses before proxy and model POST', async t => {
  for (const profile of [undefined, 'private-workspace']) {
    const f = await fixture(t); await f.enableV2();
    await f.bridge.up({ ...f.options, profile, flowIds: ['synthetic-default'] }, env);
    const machine = f.machines()[0], original = structuredClone(machine.config);
    const proxyCount = f.proxyCalls.length, modelCount = f.requests.filter(r => r.url.pathname === '/v1/chat/completions').length;
    for (const override of [config => { config.env.FLUJO_SNAPSHOT_MAX_BYTES = '1'; },
      config => { config.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES = '268435456'; },
      config => { config.processes = [{ env: { FLUJO_SNAPSHOT_MAX_BYTES: '1' } }]; },
      config => { config.containers = [{ env: { FLUJO_SNAPSHOT_MAX_BYTES: '1' } }]; },
      config => { config.files = [{ guest_path: '/synthetic/replacement' }]; },
      config => { config.init.exec = ['replacement']; }]) {
      machine.config = structuredClone(original); override(machine.config);
      await assert.rejects(f.bridge.call({ journal: f.options.journal, request: { model: 'synthetic-default', messages: [] } }, env),
        /restore-bound|execution overrides/);
      assert.equal(f.proxyCalls.length, proxyCount);
      assert.equal(f.requests.filter(r => r.url.pathname === '/v1/chat/completions').length, modelCount);
    }
    machine.config = original;
    const record = await new Journal(f.options.journal).read();
    f.setSecrets([{ Name: `FLUJO_CLOUD_OWNER_${record.owner.replaceAll('-', '').toUpperCase()}` },
      { Name: 'FLUJO_SNAPSHOT_MAX_BYTES' }]);
    await assert.rejects(f.bridge.call({ journal: f.options.journal, request: { model: 'synthetic-default', messages: [] } }, env),
      /restore-bound secrets/);
    assert.equal(f.proxyCalls.length, proxyCount);
  }
});

test('lost v2 begin retains exact privately bound key and failed identity without replay or cloud entry', async t => {
  const f = await fixture(t); await f.enableV2(); f.loseBegin();
  await assert.rejects(f.bridge.up(f.options, env), { code: 'SNAPSHOT_CLEANUP_UNKNOWN' });
  const filename = `${f.options.journal}.snapshot-key-v2/recipient-key.json`;
  const before = await fs.readFile(filename), key = await readPrivateJson(filename);
  const journal = await new Journal(f.options.journal).read();
  assert.equal(journal.state, 'failed'); assert.equal(key.journalOwner, journal.owner);
  assert.equal(JSON.stringify(journal).includes(key.key), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.filter(r => r.url.pathname === '/api/snapshot/begin').length, 1);
  await assert.rejects(f.bridge.up(f.options, env), /journal|exists|starting/);
  assert.equal(f.requests.filter(r => r.url.pathname === '/api/snapshot/begin').length, 1);
  assert.deepEqual(await fs.readFile(filename), before);
});

test('whole v2 up rejects linked journal parent before journal, lock or sidecar outside effects', async t => {
  const f = await fixture(t); await f.enableV2();
  const root = path.dirname(f.options.journal), outside = path.join(root, 'outside-owned-fixture');
  await fs.mkdir(outside); await ensurePrivateDirectory(outside);
  const sentinel = Buffer.from('synthetic outside sentinel'); await fs.writeFile(path.join(outside, 'sentinel.txt'), sentinel);
  const linked = path.join(root, 'linked');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  f.options.journal = path.join(linked, 'worker.journal.json');
  await assert.rejects(f.bridge.up(f.options, env), /Private storage/);
  assert.deepEqual(await fs.readdir(outside), ['sentinel.txt']);
  assert.deepEqual(await fs.readFile(path.join(outside, 'sentinel.txt')), sentinel);
  assert.equal(f.requests.some(r => r.url.pathname === '/api/snapshot/begin'), false);
  assert.equal(f.calls.length, 0); assert.equal(f.proxyCalls.length, 0);
});

test('recipient-encrypted Core export is uploaded byte-for-byte and worker decrypts once to the archive', async t => {
  const state = await fixture(t, { encryptedExport: true });
  await state.bridge.up(state.options, env);
  assert.deepEqual(state.uploaded(), state.exported());
  const journal = JSON.parse(await fs.readFile(state.options.journal, 'utf8'));
  assert.equal(journal.archiveSha256, snapshotHash);
  assert.notEqual(journal.archiveSha256, sha256(state.exported()));
  assert.equal(state.machines()[0].config.env.FLUJO_WORKER_SNAPSHOT_SHA256, snapshotHash);
  const line = state.secretInput().split('\n').find(line => line.startsWith('FLUJO_WORKER_SNAPSHOT_KEY='));
  const key = Buffer.from(JSON.parse(line.slice(line.indexOf('=') + 1)), 'base64');
  const envelope = JSON.parse(state.uploaded());
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]), snapshotBytes);
  assert.ok(!JSON.stringify(journal).includes(key.toString('base64')));
});

test('unknown server encryption key aborts before any Fly app/secret/upload operation', async t => {
  const state = await fixture(t, { encryptedExport: true, recipientAck: false });
  await assert.rejects(state.bridge.up(state.options, env), /acknowledged recipient key/);
  assert.equal(state.calls.length, 0);
  assert.equal(state.requests.at(-1).url.pathname, '/api/snapshot/abort');
});
