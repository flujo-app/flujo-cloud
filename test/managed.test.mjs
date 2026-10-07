import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { ManagedCloud } from '../lib/managed.mjs';
import { CloudBridge, buildMachineConfig } from '../lib/bridge.mjs';
import { sha256 } from '../lib/envelope.mjs';
import { Journal } from '../lib/journal.mjs';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from '../lib/private-files.mjs';
import { snapshotTransferContract } from '../lib/transfer.mjs';

const sourceToken = 'synthetic_source_private_01234567890123456789';
const origin = 'http://127.0.0.1:43451';
const image = `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`;
const compatibility = { applicationVersion: '3.45.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
const v2Native = { snapshotEncryption: { format: 'flujo-workspace-encrypted', cipher: 'aes-256-gcm', writeVersion: 2,
  readVersions: [1, 2], legacyPlaintextRead: true, recipientKeyRequired: true, recipientKeyBytes: 32,
  recipientKeyEncoding: 'base64', v2Aad: 'flujo:workspace-snapshot:v2', v2Digest: 'sha256-encrypted-wire',
  v1Digest: 'sha256-plaintext-zip' }, snapshotLimits: { maxFileBytes: 268435456, maxUncompressedBytes: 1073741824,
  maxManifestBytes: 8388608, maxArchiveBytes: 1082130432, maxEncryptedBytes: 1442844672, maxMembers: 65534 } };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-managed-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('flujo-managed-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const state = { calls: [], organizations: { personal: 'Synthetic account' },
    flows: [{ id: 'default-agent-flujo', name: 'FLUJO' }],
    sources: [{ source: origin, instanceId: 'synthetic-instance', token: sourceToken, appRoot: '/app', dataRoot: '/data' }],
    response: 'completed', stateDirectory: path.join(directory, 'controller') };
  state.compatibility = compatibility;
  const fly = { async run(args) { state.calls.push({ command: args }); return JSON.stringify(state.organizations); } };
  const bridge = {
    async up(options, env) {
      state.calls.push({ up: options });
      assert.equal(env.FLUJO_SNAPSHOT_CONTROL_TOKEN, sourceToken);
      assert.ok(env.FLUJO_CLOUD_CONTROL_TOKEN.length >= 32);
      assert.notEqual(env.FLUJO_CLOUD_CONTROL_TOKEN, sourceToken);
      state.workerToken = env.FLUJO_CLOUD_CONTROL_TOKEN;
      const files = managed.paths(options.app);
      assert.equal((await readPrivateJson(files.credentials)).token, state.workerToken);
      const metadata = await readPrivateJson(files.metadata);
      assert.equal(metadata.phase, 'provisioning');
      assert.equal((await readPrivateJson(files.credentials)).attemptId, metadata.attemptId);
      if (state.failBeforeJournal) throw new Error('Synthetic interruption before journal creation.');
      await state.beforeJournal?.(options);
      await new Journal(options.journal).create({ format: 'flujo-cloud-journal', version: 1,
        owner: randomUUID(), app: options.app, org: options.org, region: options.region,
        workspace: options.workspace, image: options.image,
        ...(options.profile === 'private-workspace' ? { profile: options.profile, recoveryId: options.recoveryId,
          recoveryEpoch: options.recoveryEpoch, defaultFlowIds: options.defaultFlowIds,
          sourceCompatibility: options.sourceCompatibility, sourceRevision: options.sourceRevision,
          sourceProvenance: options.sourceProvenance, targetRevision: options.targetRevision } : { flowIds: options.flowIds }),
        state: state.failUp || state.failCapture || state.failCreateApp ? 'failed' : 'ready',
        stage: state.failCapture ? 'snapshot' : state.failCreateApp ? 'create-app' : 'ready',
        appCreated: !state.failCapture && !state.failCreateApp,
        ...(!state.failCapture && !state.failCreateApp ? { appId: options.app, machineId: 'synthetic-machine' } : {}) });
      if (state.failCapture) throw new Error('Synthetic capture failed.');
      if (state.failCreateApp) throw new Error('Synthetic uncertain app creation.');
      if (state.failUp) throw new Error('Synthetic provisioning failed.');
      return { app: options.app, state: 'ready', machineId: 'synthetic-machine' };
    },
    async call(options, env) {
      state.calls.push({ call: options });
      assert.equal(env.FLUJO_CLOUD_CONTROL_TOKEN, state.workerToken);
      return { body: state.leak ? state.workerToken : state.response };
    },
    async down({ journal }) {
      state.calls.push({ down: journal });
      const store = new Journal(journal);
      const record = await store.read();
      if (!record.appCreated && record.state !== 'destroyed') throw new Error('No confirmed app ownership; reconcile remote state.');
      await store.save({ ...record, state: 'destroyed', stage: 'destroyed' });
      return { app: record.app, state: 'destroyed' };
    },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${sourceToken}`);
    const request = new URL(url);
    assert.equal(request.origin, origin);
    if (request.pathname === '/api/workspaces') return Response.json({ workspaces: [{ name: 'test-cloud', roots: ['private-details-not-returned'] }], defaultWorkspace: 'test-cloud' });
    assert.equal(options.headers['x-flujo-workspace'], 'test-cloud');
    if (request.pathname === '/api/snapshot/info') return Response.json({ workspace: 'test-cloud', capability: 'available', workerCompatibility: state.compatibility });
    if (request.pathname === '/api/flow') return Response.json(state.flows);
    throw new Error('Unexpected synthetic endpoint.');
  };
  const managed = new ManagedCloud({ directory: state.stateDirectory, env: {}, fly, bridge, fetchImpl,
    writeJson: async (filename, value, options) => {
      await state.beforeWrite?.(filename, value, options);
      await writePrivateJson(filename, value, options);
      await state.afterWrite?.(filename, value, options);
    },
    discover: async () => state.sources,
    resolveImage: async ({ source, image: explicit, profile }) => {
      assert.deepEqual(source, state.compatibility);
      if (state.failImage) throw new Error('No compatible official worker image.');
      if (profile === 'private-workspace' && explicit) return { image: explicit, mode: 'explicit', compatibility: 'unchecked' };
      return { image: explicit || image, mode: 'official', applicationVersion: '3.45.0', revision: 'b'.repeat(40),
        ...(profile === 'private-workspace' ? { ...compatibility, compatibility: 'verified', workerSnapshotSourceVersion: 1 } : {}) };
    },
  });
  return { managed, state, input: { workspace: 'test-cloud' } };
}

test('managed lifecycle discovers, pins, saves private credentials, calls and cleans up without control env variables', async t => {
  const { managed, state, input } = await fixture(t);
  const result = await managed.up(input);
  assert.match(result.worker, /^flujo-test-cloud-[a-f0-9]{8}$/);
  const up = state.calls.find(call => call.up).up;
  assert.equal(up.image, image);
  assert.equal(up.org, 'personal');
  assert.equal(up.region, 'iad');
  assert.deepEqual(up.flowIds, ['default-agent-flujo']);
  assert.ok(!JSON.stringify(result).includes(state.workerToken));
  const inventory = await managed.list();
  assert.equal(inventory[0].state, 'ready');
  assert.ok(!JSON.stringify(inventory).includes(state.workerToken));
  const response = await managed.call(result.worker, { request: { messages: [{ role: 'user', content: 'go' }] } });
  assert.equal(response.body, 'completed');
  assert.equal(state.calls.find(call => call.call).call.request.model, 'default-agent-flujo');
  const files = managed.paths(result.worker);
  assert.ok(!(await fs.readFile(files.journal, 'utf8')).includes(state.workerToken));
  await managed.down(result.worker);
  await assert.rejects(fs.lstat(files.credentials), { code: 'ENOENT' });
  assert.equal((await managed.list())[0].state, 'destroyed');
  await managed.down(result.worker);
});

test('preflight and discovery output are credential-free and create no persistent state', async t => {
  const { managed, state, input } = await fixture(t);
  assert.equal((await managed.workspaces()).workspaces[0].name, 'test-cloud');
  const result = await managed.preflight({ ...input, flowIds: ['FLUJO'] });
  assert.deepEqual(result.flows, [{ id: 'default-agent-flujo', name: 'FLUJO' }]);
  assert.equal(result.readyToDeploy, true);
  assert.ok(!JSON.stringify([result, await managed.sources(), await managed.workspaces()]).includes(sourceToken));
  await assert.rejects(fs.lstat(state.stateDirectory), { code: 'ENOENT' });
  assert.ok(!state.calls.some(call => call.up));
});

test('missing compatible official image fails before cloud or local state creation', async t => {
  const { managed, state, input } = await fixture(t);
  state.failImage = true;
  await assert.rejects(managed.up(input), /compatible official/);
  assert.equal(state.calls.length, 0);
  await assert.rejects(fs.lstat(state.stateDirectory), { code: 'ENOENT' });
});

test('multiple instances or billing organizations require explicit selection', async t => {
  const { managed, state, input } = await fixture(t);
  state.sources.push({ ...state.sources[0], source: 'http://127.0.0.1:43452' });
  await assert.rejects(managed.preflight(input), /Multiple local FLUJO/);
  state.sources.pop();
  state.organizations = { personal: 'Synthetic personal', team: 'Synthetic team' };
  await assert.rejects(managed.preflight(input), /billing organization/);
  assert.equal((await managed.preflight({ ...input, org: 'team' })).org, 'team');
  assert.ok(!state.calls.some(call => call.up));
});

test('ambiguous flow names fail before image resolution and provisioning', async t => {
  const { managed, state, input } = await fixture(t);
  state.flows.push({ id: 'other-flow', name: 'FLUJO' });
  await assert.rejects(managed.preflight({ ...input, flowIds: ['FLUJO'] }), /ambiguous/);
  await assert.rejects(managed.preflight(input), /ambiguous/);
  assert.equal(state.calls.length, 0);
});

test('failed provisioning retains credentials and journal for reconciliation', async t => {
  const { managed, state, input } = await fixture(t);
  state.failUp = true;
  await assert.rejects(managed.up({ ...input, app: 'synthetic-failed-worker' }), /Synthetic provisioning/);
  assert.equal((await managed.list())[0].state, 'failed');
  assert.equal((await readPrivateJson(managed.paths('synthetic-failed-worker').credentials)).token, state.workerToken);
});

test('reusing a managed app never replaces its saved control credential', async t => {
  const { managed, state, input } = await fixture(t);
  const result = await managed.up({ ...input, app: 'synthetic-same-worker' });
  const original = state.workerToken;
  await assert.rejects(managed.up({ ...input, app: result.worker }));
  assert.equal((await readPrivateJson(managed.paths(result.worker).credentials)).token, original);
  assert.equal(state.calls.filter(call => call.up).length, 1);
});

test('saved worker identity mismatch blocks calls and destruction', async t => {
  const { managed, state, input } = await fixture(t);
  const result = await managed.up(input);
  const store = new Journal(managed.paths(result.worker).journal);
  const record = await store.read();
  await store.save({ ...record, image: `ghcr.io/example/foreign@sha256:${'f'.repeat(64)}` });
  await assert.rejects(managed.call(result.worker, { request: {} }), /identities do not match/);
  await assert.rejects(managed.down(result.worker), /identities do not match/);
  assert.ok(!state.calls.some(call => call.call || call.down));
});

test('controller credentials in a model response are withheld', async t => {
  const { managed, state, input } = await fixture(t);
  const result = await managed.up(input);
  state.leak = true;
  await assert.rejects(managed.call(result.worker, { request: {} }), error =>
    /credential.*withheld/.test(error.message) && !error.message.includes(state.workerToken));
});

test('unsafe worker identifiers and remote source URLs are rejected without requests', async t => {
  const { managed, state } = await fixture(t);
  for (const id of ['../foreign', 'C:\\foreign', '', undefined]) assert.throws(() => managed.paths(id));
  await assert.rejects(managed.source({ source: 'https://example.com' }), /loopback/);
  assert.equal(state.calls.length, 0);
});

test('controller credentials cannot be stored inside a workspace that will be captured', async t => {
  const { managed, state, input } = await fixture(t);
  state.sources[0].dataRoot = path.dirname(state.stateDirectory);
  managed.directory = path.join(state.sources[0].dataRoot, 'workspaces', 'test-cloud', 'userdata', 'controller');
  await assert.rejects(managed.up(input), /outside the source workspace/);
  assert.equal(state.calls.length, 0);
});

test('explicit source and environment token cannot bypass discovery or workspace-state placement checks', async t => {
  const { managed, state, input } = await fixture(t);
  managed.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = sourceToken;
  state.sources[0].dataRoot = path.dirname(state.stateDirectory);
  managed.directory = path.join(state.sources[0].dataRoot, 'workspaces', 'test-cloud', 'userdata', 'controller');
  await assert.rejects(managed.up({ ...input, source: origin }), /outside the source workspace/);
  state.sources = [];
  await assert.rejects(managed.up({ ...input, source: origin }), /No registered local FLUJO/);
  assert.equal(state.calls.length, 0);
});

test('credential-write failure leaves a provably local attempt that down retires without Fly calls', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-prepared-only';
  const files = managed.paths(id);
  state.beforeWrite = async filename => { if (filename === files.credentials) throw new Error('Synthetic credential write failure.'); };
  await assert.rejects(managed.up({ ...input, app: id }), /credential write failure/);
  assert.equal((await readPrivateJson(files.metadata)).phase, 'preparing');
  await assert.rejects(fs.lstat(files.journal), { code: 'ENOENT' });
  assert.equal((await managed.list())[0].state, 'preparing');
  const calls = state.calls.length;
  assert.equal((await managed.down(id)).localOnly, true);
  assert.equal(state.calls.length, calls);
  assert.equal((await readPrivateJson(files.metadata)).retirement, 'local-preparation');
  assert.equal((await managed.list())[0].state, 'destroyed');
  assert.equal((await managed.down(id)).state, 'destroyed');
  assert.ok(!state.calls.some(call => call.up || call.down));
});

test('interruption after credential persistence removes only that preparing attempt credential', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-prepared-credential';
  const files = managed.paths(id);
  state.afterWrite = async filename => { if (filename === files.credentials) throw new Error('Synthetic interruption after credential write.'); };
  await assert.rejects(managed.up({ ...input, app: id }), /interruption after credential/);
  const metadata = await readPrivateJson(files.metadata);
  assert.equal((await readPrivateJson(files.credentials)).attemptId, metadata.attemptId);
  assert.equal(metadata.phase, 'preparing');
  assert.equal((await managed.down(id)).localOnly, true);
  await assert.rejects(fs.lstat(files.credentials), { code: 'ENOENT' });
  assert.ok(!state.calls.some(call => call.up || call.down));
});

test('a proven failed capture retires locally and preserves its journal for audit', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-failed-capture';
  const files = managed.paths(id);
  state.failCapture = true;
  await assert.rejects(managed.up({ ...input, app: id }), /capture failed/);
  const before = await new Journal(files.journal).read();
  const metadata = await readPrivateJson(files.metadata);
  assert.equal(metadata.phase, 'provisioning');
  assert.equal(metadata.journalOwner, before.owner);
  assert.equal(before.appCreated, false);
  const calls = state.calls.length;
  const result = await managed.down(id);
  assert.equal(result.localOnly, true);
  assert.equal(state.calls.length, calls);
  const after = await new Journal(files.journal).read();
  assert.equal(after.state, 'destroyed');
  assert.equal(after.owner, before.owner);
  assert.equal(after.appCreated, false);
  await assert.rejects(fs.lstat(files.credentials), { code: 'ENOENT' });
  assert.equal((await readPrivateJson(files.metadata)).retirement, 'local-capture');
  assert.equal((await managed.down(id)).state, 'destroyed');
});

test('a missing journal after provisioning may have begun retains recovery credentials', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-missing-journal';
  const files = managed.paths(id);
  state.failBeforeJournal = true;
  await assert.rejects(managed.up({ ...input, app: id }), /before journal creation/);
  const credential = await readPrivateJson(files.credentials);
  assert.equal((await readPrivateJson(files.metadata)).phase, 'provisioning');
  await assert.rejects(managed.down(id), /journal is missing.*creation may have begun/);
  assert.deepEqual(await readPrivateJson(files.credentials), credential);
  assert.ok(!state.calls.some(call => call.down));
});

test('the durable provisioning fence stays conservative even if its writer throws before bridge invocation', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-provisioning-fence';
  const files = managed.paths(id);
  state.afterWrite = async (filename, value) => {
    if (filename === files.metadata && value.phase === 'provisioning') throw new Error('Synthetic interruption after provisioning fence.');
  };
  await assert.rejects(managed.up({ ...input, app: id }), /provisioning fence/);
  assert.equal((await readPrivateJson(files.metadata)).phase, 'provisioning');
  await assert.rejects(managed.down(id), /creation may have begun/);
  assert.ok(await readPrivateJson(files.credentials));
  assert.ok(!state.calls.some(call => call.up || call.down));
});

test('uncertain app creation never takes the capture-only cleanup path', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-uncertain-create';
  const files = managed.paths(id);
  state.failCreateApp = true;
  await assert.rejects(managed.up({ ...input, app: id }), /uncertain app creation/);
  const credential = await readPrivateJson(files.credentials);
  await assert.rejects(managed.down(id), /No confirmed app ownership/);
  assert.deepEqual(await readPrivateJson(files.credentials), credential);
  assert.equal((await new Journal(files.journal).read()).stage, 'create-app');
  assert.equal(state.calls.filter(call => call.down).length, 1);
});

test('an orphan credential blocks a new attempt before metadata or journal can be created', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-orphan-credential';
  const files = managed.paths(id);
  const orphan = { format: 'flujo-worker-credential', version: 1, id, attemptId: randomUUID(), token: 'synthetic_prior_private_01234567890123456789' };
  await writePrivateJson(files.credentials, orphan, { exclusive: true });
  await assert.rejects(managed.up({ ...input, app: id }), /recovery artifact already exists/);
  assert.deepEqual(await readPrivateJson(files.credentials), orphan);
  await assert.rejects(fs.lstat(files.metadata), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(files.journal), { code: 'ENOENT' });
  assert.ok(!state.calls.some(call => call.up));
});

test('cleanup refuses an unrelated attempt credential even when the worker name matches', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-foreign-attempt';
  const files = managed.paths(id);
  state.afterWrite = async filename => { if (filename === files.credentials) throw new Error('Synthetic preparing interruption.'); };
  await assert.rejects(managed.up({ ...input, app: id }), /preparing interruption/);
  const unrelated = { ...(await readPrivateJson(files.credentials)), attemptId: randomUUID() };
  await writePrivateJson(files.credentials, unrelated);
  await assert.rejects(managed.down(id), /does not match this managed attempt/);
  assert.deepEqual(await readPrivateJson(files.credentials), unrelated);
  assert.equal((await readPrivateJson(files.metadata)).phase, 'preparing');
  assert.ok(!state.calls.some(call => call.down));
});

test('managed lock excludes down and a second up during the pre-journal credential window', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-concurrent-preparation';
  const files = managed.paths(id);
  let entered;
  let release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  state.beforeWrite = async filename => {
    if (filename === files.credentials) { entered(); await resume; }
  };
  const up = managed.up({ ...input, app: id });
  await waiting;
  try {
    await assert.rejects(fs.lstat(files.journal), { code: 'ENOENT' });
    await assert.rejects(managed.down(id), { code: 'MANAGED_BUSY' });
    await assert.rejects(managed.up({ ...input, app: id }), { code: 'MANAGED_BUSY' });
    assert.equal((await managed.list())[0].state, 'preparing');
  } finally { release(); }
  assert.equal((await up).state, 'ready');
  assert.equal(state.calls.filter(call => call.up).length, 1);
  assert.equal((await managed.down(id)).state, 'destroyed');
});

test('journal owner changes block calls and capture-only cleanup', async t => {
  const { managed, state, input } = await fixture(t);
  const id = 'synthetic-journal-replacement';
  const files = managed.paths(id);
  state.failCapture = true;
  await assert.rejects(managed.up({ ...input, app: id }), /capture failed/);
  const journal = new Journal(files.journal);
  await journal.save({ ...(await journal.read()), owner: randomUUID() });
  await assert.rejects(managed.call(id, { request: {} }), /identities do not match/);
  await assert.rejects(managed.down(id), /identities do not match/);
  assert.ok(await readPrivateJson(files.credentials));
  assert.ok(!state.calls.some(call => call.call || call.down));
});

test('interruption after confirmed destruction safely finishes credential removal on repeated down', async t => {
  const { managed, state, input } = await fixture(t);
  const { worker } = await managed.up(input);
  const files = managed.paths(worker);
  let failOnce = true;
  state.afterWrite = async (filename, value) => {
    if (filename === files.metadata && value.phase === 'destroyed' && failOnce) {
      failOnce = false;
      throw new Error('Synthetic interruption after retirement record.');
    }
  };
  await assert.rejects(managed.down(worker), /after retirement record/);
  assert.equal((await new Journal(files.journal).read()).state, 'destroyed');
  assert.ok(await readPrivateJson(files.credentials));
  assert.equal((await managed.down(worker)).state, 'destroyed');
  await assert.rejects(fs.lstat(files.credentials), { code: 'ENOENT' });
  assert.equal(state.calls.filter(call => call.down).length, 1);
});

test('operator journal contention never binds an unrelated failed capture journal to the managed attempt', async t => {
  for (const lockConflict of [false, true]) {
    await t.test(lockConflict ? 'operator holds the journal lock' : 'operator created the journal first', async t => {
      const { managed, state, input } = await fixture(t);
      const id = 'synthetic-operator-contention';
      const files = managed.paths(id);
      const foreignOwner = randomUUID();
      state.beforeJournal = async options => {
        await new Journal(options.journal).create({ format: 'flujo-cloud-journal', version: 1,
          owner: foreignOwner, app: options.app, org: options.org, region: options.region,
          workspace: options.workspace, image: options.image, state: 'failed', stage: 'snapshot', appCreated: false });
        if (lockConflict) throw new Error('This worker journal is locked by another command.');
        throw Object.assign(new Error('Synthetic journal already exists.'), { code: 'EEXIST' });
      };
      await assert.rejects(managed.up({ ...input, app: id }), /journal (?:is locked|already exists)/);
      const credential = await readPrivateJson(files.credentials);
      assert.equal((await readPrivateJson(files.metadata)).journalOwner, undefined);
      await assert.rejects(managed.down(id), /identities do not match/);
      await assert.rejects(managed.call(id, { request: {} }), /identities do not match/);
      assert.deepEqual(await readPrivateJson(files.credentials), credential);
      assert.equal((await new Journal(files.journal).read()).owner, foreignOwner);
      assert.equal((await new Journal(files.journal).read()).state, 'failed');
      assert.ok(!state.calls.some(call => call.down || call.call));
    });
  }
});

test('private preflight separates full capture from default flow choice and creates no recovery identity or credentials', async t => {
  const { managed, state, input } = await fixture(t);
  state.compatibility = { ...compatibility, revision: 'b'.repeat(40), workerSnapshotSourceVersion: 1 };
  state.flows.push({ id: 'other-flow', name: 'Other' });
  const result = await managed.preflight({ ...input, profile: 'private-workspace', flowIds: ['FLUJO'] });
  assert.equal(result.profile, 'private-workspace');
  assert.equal(result.captureScope, 'workspace');
  assert.deepEqual(result.flows, [{ id: 'default-agent-flujo', name: 'FLUJO' }]);
  assert.equal(result.portability, 'checked-during-full-capture-before-provisioning');
  assert.equal(Object.hasOwn(result, 'recoveryId'), false);
  assert.equal(Object.hasOwn(result, 'mcpPortable'), false);
  await assert.rejects(fs.stat(state.stateDirectory), { code: 'ENOENT' });
  assert.equal(state.calls.some(call => call.up), false);
});

test('private managed attempt stores one identity in metadata/journal and uses defaults without restricting later flow IDs', async t => {
  const { managed, state, input } = await fixture(t);
  state.compatibility = { ...compatibility, revision: 'b'.repeat(40), workerSnapshotSourceVersion: 1 };
  const result = await managed.up({ ...input, profile: 'private-workspace' });
  const files = managed.paths(result.worker),metadata = await readPrivateJson(files.metadata),journal = await new Journal(files.journal).read();
  assert.equal(metadata.profile, 'private-workspace');
  assert.match(metadata.recoveryId, /^[a-f0-9-]{36}$/);
  assert.equal(metadata.recoveryEpoch, 1);
  assert.equal(journal.recoveryId, metadata.recoveryId);
  assert.equal(journal.recoveryEpoch, metadata.recoveryEpoch);
  assert.deepEqual(journal.sourceCompatibility, metadata.sourceCompatibility);
  assert.equal(journal.sourceRevision, metadata.sourceRevision);
  assert.equal(journal.targetRevision, metadata.targetRevision);
  assert.equal(Object.hasOwn(journal, 'flowIds'), false);
  assert.deepEqual(metadata.defaultFlowIds, ['default-agent-flujo']);
  assert.equal(state.calls.find(call => call.up).up.recoveryId, metadata.recoveryId);
  await managed.call(result.worker, { request: { messages: [] } });
  assert.equal(state.calls.filter(call => call.call).at(-1).call.request.model, 'default-agent-flujo');
  await managed.call(result.worker, { request: { model: 'added-after-restore', messages: [] } });
  assert.equal(state.calls.filter(call => call.call).at(-1).call.request.model, 'added-after-restore');
  assert.deepEqual((await new Journal(files.journal).read()).defaultFlowIds, ['default-agent-flujo']);
  assert.equal((await readPrivateJson(files.metadata)).recoveryId, metadata.recoveryId);
  const credentials = await readPrivateJson(files.credentials);
  await assert.rejects(managed.up({ ...input, profile: 'private-workspace', app: result.worker }), /already exists/);
  assert.deepEqual(await readPrivateJson(files.credentials), credentials);
  assert.equal(state.calls.filter(call => call.up).length, 1);
});

test('private full workspace with no default or several defaults requires an explicit call model', async t => {
  for (const multiple of [false, true]) {
    const { managed, state, input } = await fixture(t);
    state.compatibility = { ...compatibility, revision: 'b'.repeat(40), workerSnapshotSourceVersion: 1 };
    state.flows = multiple ? [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] : [];
    const result = await managed.up({ ...input, profile: 'private-workspace', ...(multiple ? { flowIds: ['one', 'two'] } : {}) });
    await assert.rejects(managed.call(result.worker, { request: { messages: [] } }), /exact restored flow ID/);
    assert.equal(state.calls.some(call => call.call), false);
    await managed.call(result.worker, { request: { model: 'new-live-flow', messages: [] } });
    assert.equal(state.calls.filter(call => call.call).at(-1).call.request.model, 'new-live-flow');
  }
});

test('private profile/capability/unchecked-image errors stop before provisioning or saved control state', async t => {
  for (const variant of ['unknown', 'old-source', 'unchecked', 'identity', 'reserved-defaults']) {
    const { managed, state, input } = await fixture(t);
    state.compatibility = variant === 'old-source' ? compatibility
      : { ...compatibility, revision: 'b'.repeat(40), workerSnapshotSourceVersion: 1 };
    const extra = variant === 'unknown' ? { profile: 'unknown' }
      : variant === 'unchecked' ? { image }
        : variant === 'identity' ? { workspace: { toString: () => input.workspace } }
          : variant === 'reserved-defaults' ? { defaultFlowIds: ['default-agent-flujo'] } : {};
    await assert.rejects(managed.up({ ...input, profile: 'private-workspace', ...extra }));
    assert.equal(state.calls.some(call => call.up), false);
    await assert.rejects(fs.stat(state.stateDirectory), { code: 'ENOENT' });
  }
});

test('private model primitives and interrupted managed state cannot silently dispatch a default or replay', async t => {
  const { managed, state, input } = await fixture(t);
  state.compatibility = { ...compatibility, revision: 'b'.repeat(40), workerSnapshotSourceVersion: 1 };
  const result = await managed.up({ ...input, profile: 'private-workspace' });
  for (const model of [null, 0, '', [], { toString: () => 'default-agent-flujo' }]) {
    await assert.rejects(managed.call(result.worker, { request: { model, messages: [] } }), /exact restored flow ID/);
  }
  const files = managed.paths(result.worker),metadata = await readPrivateJson(files.metadata);
  await writePrivateJson(files.metadata, { ...metadata, phase: 'provisioning' });
  await assert.rejects(managed.call(result.worker, { request: { messages: [] } }), /incomplete or unknown/);
  assert.equal(state.calls.some(call => call.call), false);
  assert.equal((await readPrivateJson(files.metadata)).phase, 'provisioning');
});

test('private metadata/journal profile mismatch blocks calls and cleanup without changing prior identity or credential', async t => {
  const { managed, state, input } = await fixture(t);
  state.compatibility = { ...compatibility, revision: 'b'.repeat(40), workerSnapshotSourceVersion: 1 };
  const result = await managed.up({ ...input, profile: 'private-workspace' });
  const files = managed.paths(result.worker),metadata = await readPrivateJson(files.metadata),credentials = await readPrivateJson(files.credentials);
  const journalBytes = await fs.readFile(files.journal);
  await writePrivateJson(files.metadata, { ...metadata, recoveryEpoch: 2 });
  await assert.rejects(managed.call(result.worker, { request: { messages: [] } }), /identity changed|migration/);
  await assert.rejects(managed.down(result.worker), /identity changed|migration/);
  assert.deepEqual(await readPrivateJson(files.credentials), credentials);
  assert.deepEqual(await fs.readFile(files.journal), journalBytes);
  assert.equal(state.calls.some(call => call.call || call.down), false);
});

test('managed unknown-native source provenance persists without inferring a checkout revision or weakening target verification', async t => {
  const { managed, state, input } = await fixture(t);
  state.compatibility = { ...compatibility, workerSnapshotSourceVersion: 1 };
  const result = await managed.up({ ...input, profile: 'private-workspace' });
  const files = managed.paths(result.worker),metadata = await readPrivateJson(files.metadata),journal = await new Journal(files.journal).read();
  assert.equal(metadata.sourceRevision, null);
  assert.equal(metadata.sourceProvenance, 'unknown-native');
  assert.equal(metadata.targetRevision, 'b'.repeat(40));
  assert.deepEqual(journal.sourceCompatibility, state.compatibility);
  assert.equal(journal.sourceRevision, null);
  assert.equal(journal.sourceProvenance, 'unknown-native');
});

// Exercise the real ManagedCloud -> CloudBridge -> snapshot -> provisioning
// path. Only transport is synthetic; these fixtures open no sockets or services.
async function cloneFixture(t, { encrypted = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-hot-clone-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('flujo-hot-clone-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const worker = 'synthetic-clone-source';
  const contract = { ...compatibility, workerSnapshotSourceVersion: 1 };
  const revision = 'b'.repeat(40), bootstrapHash = '9'.repeat(64);
  const currentBytes = Buffer.from('synthetic changed workspace containing all flows and portable dependencies');
  const currentHash = sha256(currentBytes), session = randomUUID();
  let wireBytes = currentBytes, wireHash = currentHash;
  const state = { calls: [], requests: [], proxies: [], events: [], discoverCalls: 0,
    flows: [{ id: 'default-agent-flujo', name: 'FLUJO' }, { id: 'other-flow', name: 'Other Flow' }],
    snapshotState: 'ready', sourceRevision: revision };
  const apps = new Map(), machines = new Map(), secrets = new Map();
  const proxyApps = new Map();
  const value = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const fly = {
    async run(args, options = {}) {
      state.calls.push({ args, ...options });
      const [group, command] = args, app = value(args, '--app');
      state.events.push(`fly:${group}:${command}:${app ?? ''}`);
      if (group === 'orgs') return JSON.stringify([{ Slug: 'example-org' }]);
      if (group === 'apps' && command === 'list') return JSON.stringify([...apps.values()]);
      if (group === 'apps' && command === 'create') {
        await assertSourceLocked();
        assert.ok(state.events.includes('snapshot:finalized'));
        if (state.failCreateApp) throw new Error('Synthetic app creation acknowledgement lost.');
        const created = { ID: args[2], Name: args[2], Organization: { Slug: 'example-org' } };
        apps.set(args[2], created); return JSON.stringify(created);
      }
      if (group === 'secrets' && command === 'list') return JSON.stringify(secrets.get(app) ?? []);
      if (group === 'secrets' && command === 'import') {
        secrets.set(app, options.input.trim().split('\n').map(line => ({ Name: line.slice(0, line.indexOf('=')) })));
        state.targetToken = JSON.parse(options.input.split('\n').find(line => line.startsWith('FLUJO_SNAPSHOT_CONTROL_TOKEN=')).slice('FLUJO_SNAPSHOT_CONTROL_TOKEN='.length));
        if (encrypted) state.importedKey = JSON.parse(options.input.split('\n')
          .find(line => line.startsWith('FLUJO_WORKER_SNAPSHOT_KEY=')).slice('FLUJO_WORKER_SNAPSHOT_KEY='.length));
        return '';
      }
      if (group === 'volumes' && command === 'create') return JSON.stringify({ id: 'vol_target', name: args[2] });
      if (group === 'machine' && command === 'list') return JSON.stringify(machines.has(app) ? [machines.get(app)] : []);
      if (group === 'machine' && command === 'update') {
        machines.get(app).config = JSON.parse(await fs.readFile(value(args, '--machine-config'), 'utf8')); return '';
      }
      if (group === 'machine' && command === 'exec') return JSON.stringify({ exit_code: 0 });
      if (group === 'ssh' && command === 'sftp') { state.uploaded = await fs.readFile(args[3]); return ''; }
      throw new Error(`Unexpected synthetic command ${group} ${command}`);
    },
    async proxy(options) {
      const entry = { ...options, active: true, stopCalls: 0 };
      state.proxies.push(entry);
      const origin = `http://127.0.0.1:${options.localPort}`;
      proxyApps.set(origin, options.app);
      return { origin, check() {}, async stop() {
        entry.stopCalls += 1;
        state.events.push(`proxy:stop:${options.app}`);
        if (options.app === worker) {
          await state.onSourceStop?.();
          if (state.sourceStopUnknown) throw new Error('Synthetic proxy child did not close.');
          if (state.sourceStopNoReceipt) return;
        }
        entry.active = false;
        return { childClosed: true };
      } };
    },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); state.requests.push({ url, init });
    if (url.origin === 'https://api.machines.dev') {
      const app = decodeURIComponent(url.pathname.split('/')[3]);
      const { name, config } = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer synthetic_fly_api_token_0123456789');
      const machine = { id: 'target_machine', name, config, state: 'started', image_ref: { digest: image.split('@')[1] } };
      machines.set(app, machine); return Response.json(machine);
    }
    const app = proxyApps.get(url.origin);
    assert.ok(app, 'Every worker request uses an existing private proxy.');
    const token = app === worker ? sourceToken : state.targetToken;
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (url.pathname === '/api/worker/status') {
      if (app === worker) return Response.json({ mode: 'worker', state: 'ready', workspace: 'test-cloud', archiveSha256: bootstrapHash });
      await assertSourceLocked(); await state.onTargetReady?.();
      return Response.json({ mode: 'worker', state: 'ready', workspace: 'test-cloud', archiveSha256: wireHash });
    }
    assert.equal(app, worker);
    assert.equal(init.headers['x-flujo-workspace'], 'test-cloud');
    if (url.pathname === '/api/flow') return Response.json(state.flows);
    if (url.pathname === '/api/snapshot/info') return Response.json({ workspace: 'test-cloud', capability: 'available',
      workerCompatibility: { ...contract, ...(encrypted ? v2Native : {}),
        ...(state.sourceRevision === undefined ? {} : { revision: state.sourceRevision }) } });
    await assertSourceLocked();
    if (url.pathname === '/api/snapshot/begin') {
      assert.equal(init.method, 'POST');
      if (encrypted) {
        const selection = JSON.parse(init.body);
        assert.deepEqual(Object.keys(selection), ['recipientKey']);
        assert.equal(init.headers['Content-Type'], 'application/json');
        const saved = await readPrivateJson(`${managed.paths(state.targetApp).journal}.snapshot-key-v2/recipient-key.json`);
        assert.equal(selection.recipientKey, saved.key); state.retainedKey = saved;
        assert.equal(saved.attemptId, (await readPrivateJson(managed.paths(state.targetApp).metadata)).attemptId);
        const key = Buffer.from(selection.recipientKey, 'base64'), iv = Buffer.alloc(12, 3);
        const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2'));
        const data = Buffer.concat([cipher.update(currentBytes), cipher.final()]);
        wireBytes = Buffer.from(JSON.stringify({ format: 'flujo-workspace-encrypted', version: 2,
          iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
        wireHash = sha256(wireBytes); key.fill(0);
      } else { assert.equal(init.body, undefined); assert.equal(init.headers['Content-Type'], undefined); }
      state.events.push('snapshot:begin');
      if (state.beginUnknown) throw new Error('Synthetic begin acknowledgement lost.');
      return Response.json({ workspace: 'test-cloud', sessionId: session, state: 'beginning',
        ...(encrypted ? { encryptionVersion: 2 } : {}) }, { status: 202 });
    }
    assert.equal(url.searchParams.get('sessionId'), session);
    if (url.pathname === '/api/snapshot/status') return Response.json({ workspace: 'test-cloud', sessionId: session,
      state: state.snapshotState, sha256: wireHash, ...(encrypted ? { encryptionVersion: 2, archiveBytes: wireBytes.length } : {}) });
    if (url.pathname === '/api/snapshot/download') {
      await state.beforeDownload?.();
      return new Response(Buffer.from(wireBytes), { headers: { 'x-flujo-snapshot-sha256': state.badHash ? 'c'.repeat(64) : wireHash,
        ...(encrypted ? { 'content-type': 'application/vnd.flujo.workspace-snapshot+json',
          'content-length': String(wireBytes.length) } : {}) } });
    }
    if (url.pathname === '/api/snapshot/finalize') {
      state.events.push('snapshot:finalize-entered');
      if (state.finalizeUnknown) throw new Error('Synthetic finalize acknowledgement lost.');
      if (state.finalizeBadJson) return new Response(typeof state.finalizeBadJson === 'string' ? state.finalizeBadJson : 'not-json');
      if (state.finalizeReply) return Response.json(state.finalizeReply);
      state.events.push('snapshot:finalized');
      return Response.json({ workspace: 'test-cloud', sessionId: session, state: 'finalized',
        ...(encrypted ? { encryptionVersion: 2 } : {}) });
    }
    if (url.pathname === '/api/snapshot/abort') {
      state.events.push('snapshot:abort');
      await state.beforeAbort?.();
      if (state.abortBadJson) return new Response(state.abortBadJson);
      return Response.json({ workspace: 'test-cloud', sessionId: session, state: 'aborted',
        ...(encrypted ? { encryptionVersion: 2 } : {}) }, { status: state.abortRejected ? 409 : 200 });
    }
    throw new Error('Unexpected synthetic worker endpoint.');
  };
  const resolveImage = async ({ source, profile, image: explicit }) => {
    assert.equal(profile, 'private-workspace');
    if (explicit) return { image: explicit, mode: 'explicit', compatibility: 'unchecked' };
    return { image, mode: 'official', compatibility: 'verified', ...contract, revision,
      ...(encrypted ? { snapshotEnvelopeReadVersions: [1, 2], snapshotTransfer: snapshotTransferContract(v2Native) } : {}) };
  };
  let port = 46010;
  const bridge = new CloudBridge({ fly, fetchImpl, resolveImage, sleepImpl: async () => undefined, port: async () => port++ });
  const managed = new ManagedCloud({ directory: path.join(directory, 'controller'),
    env: { FLY_API_TOKEN: 'synthetic_fly_api_token_0123456789' }, fly, bridge, fetchImpl, resolveImage,
    writeJson: async (filename, value, options) => {
      if (value.format === 'flujo-managed-deployment' && value.id !== worker) state.targetApp = value.id;
      await state.beforeWrite?.(filename, value, options); await writePrivateJson(filename, value, options); },
    discover: async () => { state.discoverCalls += 1; return []; } });
  const files = managed.paths(worker);
  await ensurePrivateDirectory(managed.directory); await ensurePrivateDirectory(files.root);
  const owner = randomUUID(), attemptId = randomUUID(), recoveryId = randomUUID();
  const profile = { profile: 'private-workspace', recoveryId, recoveryEpoch: 7, defaultFlowIds: ['default-agent-flujo'],
    sourceCompatibility: contract, sourceRevision: revision, sourceProvenance: 'reported-native', targetRevision: revision };
  const record = { format: 'flujo-cloud-journal', version: 1, owner, app: worker, appId: worker, org: 'example-org', region: 'iad',
    workspace: 'test-cloud', image, authState: 'copied-workspace', state: 'ready', stage: 'ready', appCreated: true, ownershipConfirmed: true,
    volumeId: 'vol_source', volumeName: 'source-volume', machineId: 'source_machine', machineName: 'source-machine', archiveSha256: bootstrapHash, ...profile };
  const metadata = { format: 'flujo-managed-deployment', version: 1, id: worker, attemptId, phase: 'ready', journalOwner: owner,
    source: 'http://127.0.0.1:4200', workspace: 'test-cloud', org: 'example-org', region: 'iad', image, ...profile };
  const credentials = { format: 'flujo-worker-credential', version: 1, id: worker, attemptId, token: sourceToken };
  await new Journal(files.journal).create(record);
  await writePrivateJson(files.metadata, metadata); await writePrivateJson(files.credentials, credentials);
  apps.set(worker, { ID: worker, Name: worker, Organization: { Slug: 'example-org' } });
  machines.set(worker, { id: record.machineId, name: record.machineName, state: 'started',
    config: buildMachineConfig(record, { idle: false }), image_ref: { digest: image.split('@')[1] } });
  secrets.set(worker, [{ Name: `FLUJO_CLOUD_OWNER_${owner.replaceAll('-', '').toUpperCase()}` }]);
  const saved = await Promise.all([files.metadata, files.credentials, files.journal].map(filename => fs.readFile(filename)));
  async function assertSourceLocked() {
    await fs.lstat(files.operationLock); await fs.lstat(`${files.journal}.lock`);
    assert.ok(state.proxies.some(proxy => proxy.app === worker && proxy.active));
  }
  async function assertPreserved() {
    const current = await Promise.all([files.metadata, files.credentials, files.journal].map(filename => fs.readFile(filename)));
    assert.deepEqual(current, saved);
  }
  async function assertReleased() {
    await assert.rejects(fs.lstat(files.operationLock), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(`${files.journal}.lock`), { code: 'ENOENT' });
  }
  function assertNoProvision() {
    assert.equal(state.calls.some(({ args }) => args[0] === 'apps' && args[1] === 'create'), false);
    assert.equal(state.requests.some(({ url }) => url.origin === 'https://api.machines.dev'), false);
    assert.equal(state.requests.some(({ url }) => url.pathname === '/v1/chat/completions'), false);
  }
  return { managed, bridge, state, files, metadata, record, worker, machines, apps, secrets, session, currentHash,
    assertPreserved, assertReleased, assertNoProvision, assertSourceLocked, wireBytes: () => wireBytes, wireHash: () => wireHash,
    currentBytes };
}

test('managed hot clone bypasses empty local discovery, captures current whole workspace and preserves source bytes with fresh target identity', async t => {
  const f = await cloneFixture(t);
  await assert.rejects(f.managed.up({ workspace: 'test-cloud', profile: 'private-workspace' }), /No registered/);
  const result = await f.managed.clone(f.worker, { app: 'synthetic-clone-target', timeoutMs: 1000 });
  assert.equal(result.state, 'ready'); assert.equal(f.state.discoverCalls, 1);
  const target = await f.managed.deployment(result.worker), credential = await readPrivateJson(target.files.credentials);
  assert.notEqual(credential.token, sourceToken); assert.equal(credential.token, f.state.targetToken);
  assert.notEqual(target.metadata.attemptId, f.metadata.attemptId);
  assert.notEqual(target.metadata.recoveryId, f.metadata.recoveryId);
  assert.notEqual(target.journal.owner, f.record.owner);
  assert.equal(target.metadata.recoveryEpoch, 1); assert.equal(target.journal.archiveSha256, f.currentHash);
  assert.deepEqual(target.journal.defaultFlowIds, f.record.defaultFlowIds);
  assert.deepEqual(target.metadata.cloneSource, { workerId: f.worker, attemptId: f.metadata.attemptId,
    journalOwner: f.record.owner, recoveryId: f.metadata.recoveryId, recoveryEpoch: 7 });
  assert.equal(f.state.requests.filter(r => r.url.pathname === '/api/snapshot/begin').length, 1);
  assert.equal(f.state.requests.some(r => r.url.pathname === '/api/snapshot/abort'), false);
  assert.ok(f.state.events.indexOf('snapshot:finalized') < f.state.events.indexOf('fly:apps:create:'));
  assert.ok(f.state.events.indexOf('proxy:stop:synthetic-clone-target') < f.state.events.indexOf(`proxy:stop:${f.worker}`));
  assert.ok(f.state.proxies.every(proxy => !proxy.active && proxy.stopCalls === 1));
  await f.assertPreserved(); await f.assertReleased();
});

test('clone flow option changes target call default while full capture remains unselected and source default is immutable', async t => {
  const f = await cloneFixture(t);
  const result = await f.managed.clone(f.worker, { app: 'synthetic-clone-new-default', flowIds: ['Other Flow'], timeoutMs: 1000 });
  assert.deepEqual((await f.managed.deployment(result.worker)).journal.defaultFlowIds, ['other-flow']);
  assert.equal(f.state.requests.find(r => r.url.pathname === '/api/snapshot/begin').init.body, undefined);
  await f.assertPreserved(); await f.assertReleased();
});

test('v2 managed hot clone keeps full ciphertext and source bytes with distinct privately retained attempt key', async t => {
  const f = await cloneFixture(t, { encrypted: true });
  const result = await f.managed.clone(f.worker, { app: 'synthetic-v2-clone-target', flowIds: ['Other Flow'], timeoutMs: 1000 });
  const target = await f.managed.deployment(result.worker);
  const credential = await readPrivateJson(target.files.credentials);
  const keyRecord = await readPrivateJson(`${target.files.journal}.snapshot-key-v2/recipient-key.json`);
  assert.equal(keyRecord.attemptId, target.metadata.attemptId);
  assert.equal(keyRecord.journalOwner, target.journal.owner); assert.equal(keyRecord.app, result.worker);
  assert.equal(keyRecord.workspace, target.journal.workspace); assert.equal(keyRecord.image, target.journal.image);
  assert.notEqual(keyRecord.key, credential.token); assert.notEqual(credential.token, sourceToken);
  assert.notEqual(target.metadata.attemptId, f.metadata.attemptId); assert.notEqual(target.metadata.recoveryId, f.metadata.recoveryId);
  assert.notEqual(target.journal.owner, f.record.owner); assert.equal(target.metadata.recoveryEpoch, 1);
  assert.equal(f.state.importedKey, keyRecord.key);
  assert.deepEqual(f.state.uploaded, f.wireBytes()); assert.equal(target.journal.archiveSha256, sha256(f.state.uploaded));
  assert.notEqual(target.journal.archiveSha256, f.currentHash);
  const wire = JSON.parse(f.state.uploaded), key = Buffer.from(keyRecord.key, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wire.iv, 'base64'));
  decipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2')); decipher.setAuthTag(Buffer.from(wire.tag, 'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(wire.data, 'base64')), decipher.final()]), f.currentBytes); key.fill(0);
  assert.deepEqual(target.journal.defaultFlowIds, ['other-flow']);
  assert.equal(target.metadata.snapshotTransfer.encryptionVersion, 2);
  assert.equal(Object.hasOwn(f.metadata, 'snapshotTransfer'), false);
  assert.deepEqual(Object.keys(JSON.parse(f.state.requests.find(r => r.url.pathname === '/api/snapshot/begin').init.body)), ['recipientKey']);
  assert.equal(f.state.requests.filter(r => r.url.pathname === '/api/snapshot/begin').length, 1);
  assert.equal(f.state.discoverCalls, 0);
  for (const value of [target.metadata, target.journal, f.machines.get(result.worker).config,
    f.state.calls.map(call => call.args)]) assert.equal(JSON.stringify(value).includes(keyRecord.key), false);
  assert.ok(f.state.proxies.every(proxy => !proxy.active && proxy.stopCalls === 1));
  await f.assertPreserved(); await f.assertReleased();
});

test('v2 clone lost begin retains source/target holds and exact key without provisioning or implicit replay', async t => {
  const f = await cloneFixture(t, { encrypted: true }); f.state.beginUnknown = true;
  const target = 'synthetic-v2-clone-lost-begin';
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), { code: 'CLONE_SOURCE_CLEANUP_UNKNOWN' });
  const files = f.managed.paths(target), filename = `${files.journal}.snapshot-key-v2/recipient-key.json`;
  const before = await fs.readFile(filename);
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); await fs.lstat(files.operationLock);
  assert.equal(f.state.requests.filter(r => r.url.pathname === '/api/snapshot/begin').length, 1);
  f.assertNoProvision(); await f.assertPreserved();
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-forbidden-v2-replay' }), { code: 'MANAGED_BUSY' });
  assert.deepEqual(await fs.readFile(filename), before);
});

test('v2 clone preserves ready target and retained key when source proxy cleanup is unknown', async t => {
  const f = await cloneFixture(t, { encrypted: true }); f.state.sourceStopUnknown = true;
  const target = 'synthetic-v2-clone-source-close-unknown'; let ready;
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN'); ready = error.targetResult;
    assert.equal(ready.state, 'ready'); return true;
  });
  const stored = await f.managed.deployment(target);
  assert.equal(stored.metadata.phase, 'ready'); assert.equal(stored.journal.archiveSha256, f.wireHash());
  assert.equal((await readPrivateJson(`${stored.files.journal}.snapshot-key-v2/recipient-key.json`)).key, f.state.importedKey);
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`);
  assert.equal(f.state.calls.filter(({ args }) => args[0] === 'apps' && args[1] === 'create').length, 1);
  await f.assertPreserved();
});

test('clone source and identity overrides are refused without discovery, capture, provisioning or credential replacement', async t => {
  const f = await cloneFixture(t);
  for (const options of [{ source: 'https://example.invalid' }, { token: sourceToken }, { dataRoot: '/elsewhere' },
    { journal: 'other.json' }, { recoveryId: randomUUID() }, { recoveryEpoch: 2 }, { defaultFlowIds: [] },
    { profile: 'flow' }, { app: f.worker }, { workspace: 'other-workspace' }, { image }]) {
    await assert.rejects(f.managed.clone(f.worker, options), /override|always creates|differ|assigned workspace|verified official|provenance|contract/);
  }
  assert.equal(f.state.discoverCalls, 0); f.assertNoProvision();
  assert.equal(f.state.requests.some(r => r.url.pathname === '/api/snapshot/begin'), false);
  await f.assertPreserved(); await f.assertReleased();
});

test('clone refuses legacy, incomplete, foreign and drifted sources before opening a proxy or beginning a snapshot', async t => {
  const f = await cloneFixture(t), store = new Journal(f.files.journal);
  const machine = structuredClone(f.machines.get(f.worker)), app = structuredClone(f.apps.get(f.worker));
  const marker = structuredClone(f.secrets.get(f.worker));
  const variants = [
    async () => { await writePrivateJson(f.files.metadata, { ...f.metadata, phase: 'provisioning' }); },
    async () => { await store.save({ ...f.record, state: 'unknown' }); },
    async () => { await store.save({ ...f.record, stage: 'cleanup' }); },
    async () => { f.apps.get(f.worker).ID = 'foreign-app'; },
    async () => { f.secrets.set(f.worker, []); },
    async () => { f.machines.get(f.worker).state = 'stopped'; },
    async () => { f.machines.get(f.worker).image_ref.digest = `sha256:${'c'.repeat(64)}`; },
    async () => { f.machines.get(f.worker).config.env.FLUJO_WORKER_RECOVERY_ID = randomUUID(); },
  ];
  for (const change of variants) {
    await change();
    await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-refused-clone', timeoutMs: 1000 }), /ready|unknown|incomplete|identity changed|marker|not started|digest|configuration/);
    await writePrivateJson(f.files.metadata, f.metadata); await store.save(f.record);
    f.apps.set(f.worker, structuredClone(app)); f.secrets.set(f.worker, structuredClone(marker));
    f.machines.set(f.worker, structuredClone(machine));
  }
  // Legacy records retain their shape and cannot be silently promoted to this path.
  const fields = ['profile', 'recoveryId', 'recoveryEpoch', 'defaultFlowIds', 'sourceCompatibility', 'sourceRevision', 'sourceProvenance', 'targetRevision'];
  const legacyMetadata = { ...f.metadata }, legacyJournal = { ...f.record, flowIds: ['default-agent-flujo'] };
  for (const key of fields) { delete legacyMetadata[key]; delete legacyJournal[key]; }
  await writePrivateJson(f.files.metadata, legacyMetadata);
  await fs.writeFile(f.files.journal, `${JSON.stringify(legacyJournal)}\n`, { mode: 0o600 });
  const before = await fs.readFile(f.files.journal);
  await assert.rejects(f.managed.clone(f.worker), /ready private-workspace/);
  assert.deepEqual(await fs.readFile(f.files.journal), before);
  assert.equal(f.state.proxies.length, 0); f.assertNoProvision(); await f.assertReleased();
});

test('failed full capture and bad download refuse all provisioning and release locks only after matching abort and proxy close', async t => {
  const f = await cloneFixture(t);
  f.state.snapshotState = 'failed';
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-nonportable', timeoutMs: 1000 }), /snapshot did not complete/);
  f.state.snapshotState = 'ready'; f.state.badHash = true;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-bad-hash', timeoutMs: 1000 }), /integrity digest/);
  assert.equal(f.state.events.filter(e => e === 'snapshot:abort').length, 2);
  assert.equal(f.state.proxies.length, 2); f.assertNoProvision();
  await f.assertPreserved(); await f.assertReleased();
});

test('clone verifies finalized workspace/session/state and malformed acknowledgements cannot provision', async t => {
  const f = await cloneFixture(t);
  for (const [index, reply] of [{ workspace: 'other', sessionId: f.session, state: 'finalized' },
    { workspace: 'test-cloud', sessionId: randomUUID(), state: 'finalized' },
    { workspace: 'test-cloud', sessionId: f.session, state: 'ready' }].entries()) {
    f.state.finalizeReply = reply;
    await assert.rejects(f.managed.clone(f.worker, { app: `synthetic-clone-ack-${index}`, timeoutMs: 1000 }), /finalize returned no matching/);
    await f.assertReleased();
  }
  f.state.finalizeReply = null; f.state.finalizeBadJson = true;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-json-ack', timeoutMs: 1000 }), /terminal acknowledgement was invalid/);
  f.assertNoProvision(); await f.assertPreserved(); await f.assertReleased();
  assert.equal(f.state.events.filter(e => e === 'snapshot:abort').length, 4);
});

for (const stage of ['begin', 'finalize']) {
  test(`lost ${stage} acknowledgement with unconfirmed snapshot cleanup retains both source locks and never retries`, async t => {
    const f = await cloneFixture(t);
    f.state[`${stage}Unknown`] = true; f.state.abortRejected = true;
    await assert.rejects(f.managed.clone(f.worker, { app: `synthetic-clone-lost-${stage}`, timeoutMs: 1000 }), error => {
      assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN');
      assert.match(error.cause.message, /acknowledgement lost/);
      assert.ok(error.cleanupErrors.some(e => e.code === 'SNAPSHOT_CLEANUP_UNKNOWN')); return true;
    });
    await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`);
    await assert.rejects(f.managed.clone(f.worker), { code: 'MANAGED_BUSY' });
    await assert.rejects(f.managed.down(f.worker), { code: 'MANAGED_BUSY' });
    assert.equal(f.state.requests.filter(r => r.url.pathname === `/api/snapshot/${stage}`).length, 1);
    assert.equal(f.state.events.filter(e => e === 'snapshot:abort').length, stage === 'begin' ? 0 : 1);
    f.assertNoProvision(); await f.assertPreserved();
  });
}

test('a ready target survives unknown source proxy closure with its result and source lineage retained', async t => {
  const f = await cloneFixture(t); f.state.sourceStopUnknown = true;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-ready-unknown', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN');
    assert.equal(error.targetResult.worker, 'synthetic-clone-ready-unknown'); assert.equal(error.targetResult.state, 'ready'); return true;
  });
  const target = await f.managed.deployment('synthetic-clone-ready-unknown');
  assert.equal(target.metadata.phase, 'ready'); assert.equal(target.journal.state, 'ready');
  assert.equal(target.metadata.cloneSource.workerId, f.worker);
  await readPrivateJson(target.files.credentials);
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); await f.assertPreserved();
  assert.equal(f.state.calls.some(({ args }) => args[0] === 'apps' && args[1] === 'destroy'), false);
});

test('missing observed proxy-close receipt is uncertainty even after a successful target handoff', async t => {
  const f = await cloneFixture(t); f.state.sourceStopNoReceipt = true;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-missing-close', timeoutMs: 1000 }), { code: 'CLONE_SOURCE_CLEANUP_UNKNOWN' });
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); await f.assertPreserved();
});

test('target creation lost ACK preserves the target attempt without retry/deletion while confirmed source cleanup releases source locks', async t => {
  const f = await cloneFixture(t); f.state.failCreateApp = true;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-create-unknown', timeoutMs: 1000 }), /creation acknowledgement lost/);
  const target = await f.managed.deployment('synthetic-clone-create-unknown');
  assert.equal(target.metadata.phase, 'provisioning'); assert.equal(target.journal.state, 'failed'); assert.equal(target.journal.stage, 'create-app');
  await readPrivateJson(target.files.credentials);
  assert.equal(f.state.calls.filter(({ args }) => args[0] === 'apps' && args[1] === 'create').length, 1);
  assert.equal(f.state.calls.some(({ args }) => args[0] === 'apps' && args[1] === 'destroy'), false);
  await f.assertPreserved(); await f.assertReleased();
});

test('source managed and operator fences remain held through full capture and block competing calls/down/clone', async t => {
  const f = await cloneFixture(t);
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; }), released = new Promise(resolve => { resume = resolve; });
  f.state.beforeDownload = async () => { enter(); await released; };
  const cloning = f.managed.clone(f.worker, { app: 'synthetic-clone-concurrent', timeoutMs: 1000 });
  await Promise.race([entered, cloning.then(() => { throw new Error('Clone unexpectedly completed before the capture barrier.'); })]);
  try {
    await f.assertSourceLocked();
    await assert.rejects(f.managed.call(f.worker, { request: { messages: [] } }), { code: 'MANAGED_BUSY' });
    await assert.rejects(f.managed.down(f.worker), { code: 'MANAGED_BUSY' });
    await assert.rejects(f.managed.clone(f.worker), { code: 'MANAGED_BUSY' });
    await assert.rejects(f.bridge.call({ journal: f.files.journal, request: { messages: [] }, timeoutMs: 1000 },
      { FLUJO_CLOUD_CONTROL_TOKEN: sourceToken }), /journal is locked/);
    f.assertNoProvision();
  } finally { resume(); }
  assert.equal((await cloning).state, 'ready'); await f.assertPreserved(); await f.assertReleased();
});

test('existing operator lock blocks clone without a second source lock acquisition, proxy or native request', async t => {
  const f = await cloneFixture(t), filename = `${f.files.journal}.lock`;
  await fs.writeFile(filename, 'synthetic operator owns this lock', { flag: 'wx', mode: 0o600 });
  await assert.rejects(f.managed.clone(f.worker), /journal is locked/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'synthetic operator owns this lock');
  assert.equal(f.state.proxies.length, 0); assert.equal(f.state.requests.length, 0); f.assertNoProvision();
  await assert.rejects(fs.lstat(f.files.operationLock), { code: 'ENOENT' }); await f.assertPreserved();
});

test('mismatched finalize ACK followed by finalized-session abort refusal preserves the cause and both source locks', async t => {
  const f = await cloneFixture(t);
  f.state.finalizeReply = { workspace: 'test-cloud', sessionId: randomUUID(), state: 'finalized' };
  f.state.abortRejected = true;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-finalized-unknown', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN');
    assert.match(error.cause.message, /finalize returned no matching/);
    assert.match(error.cleanupErrors[0].cause.message, /HTTP 409/); return true;
  });
  assert.equal(f.state.events.filter(e => e === 'snapshot:finalize-entered').length, 1);
  assert.equal(f.state.events.filter(e => e === 'snapshot:abort').length, 1);
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); f.assertNoProvision(); await f.assertPreserved();
});

test('malformed finalize/abort ACKs never expose response fragments in the primary or cleanup cause', async t => {
  const f = await cloneFixture(t), marker = 'SYNTHETIC_PRIVATE_ACK_MARKER';
  f.state.finalizeBadJson = `${marker}: invalid JSON`; f.state.abortBadJson = `${marker}: invalid abort JSON`;
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-private-ack', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN');
    assert.match(error.cause.message, /terminal acknowledgement was invalid/);
    assert.match(error.cleanupErrors[0].cause.message, /terminal acknowledgement was invalid/);
    for (const value of [error, error.cause, ...error.cleanupErrors, error.cleanupErrors[0].cause]) {
      assert.equal(value.message.includes(marker), false); assert.equal(String(value.stack).includes(marker), false);
    }
    return true;
  });
  f.assertNoProvision(); await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); await f.assertPreserved();
});

test('a replacement source operator lock is never deleted and a ready target outcome remains accessible', async t => {
  const f = await cloneFixture(t), original = `${f.files.journal}.lock`;
  f.state.onSourceStop = async () => {
    await fs.rename(original, `${original}.displaced`);
    await fs.writeFile(original, 'replacement lock', { flag: 'wx', mode: 0o600 });
  };
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-replaced-lock', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN'); assert.equal(error.targetResult.state, 'ready');
    assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); assert.match(error.cause.cleanupCause.message, /identity changed/); return true;
  });
  assert.equal(await fs.readFile(original, 'utf8'), 'replacement lock'); await fs.lstat(f.files.operationLock);
  await f.assertPreserved();
});

test('an absent source operator lock is not recreated or claimed present; its managed fence and ready target are retained', async t => {
  const f = await cloneFixture(t), original = `${f.files.journal}.lock`;
  f.state.onSourceStop = async () => { await fs.unlink(original); };
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-missing-lock', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN'); assert.equal(error.targetResult.state, 'ready');
    assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN');
    assert.equal(error.message.includes('both source locks are retained'), false); return true;
  });
  await assert.rejects(fs.lstat(original), { code: 'ENOENT' }); await fs.lstat(f.files.operationLock);
  await f.assertPreserved();
});

test('managed cleanup preserves the ready target and replacement lock rather than replacing success with an opaque finally error', async t => {
  const f = await cloneFixture(t);
  f.state.onSourceStop = async () => {
    const lock = await readPrivateJson(f.files.operationLock);
    await writePrivateJson(f.files.operationLock, { ...lock, operationId: randomUUID() });
  };
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-managed-lock', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'MANAGED_LOCK_CLEANUP_UNKNOWN'); assert.equal(error.targetResult.state, 'ready');
    assert.match(error.cleanupCause.message, /identity changed/); return true;
  });
  await fs.lstat(f.files.operationLock); await assert.rejects(fs.lstat(`${f.files.journal}.lock`), { code: 'ENOENT' });
  assert.equal((await f.managed.deployment('synthetic-clone-managed-lock')).metadata.phase, 'ready'); await f.assertPreserved();
});

test('managed cleanup retains the primary snapshot/proxy failure and ready target when its own lock identity also changes', async t => {
  const f = await cloneFixture(t); f.state.sourceStopUnknown = true;
  f.state.onSourceStop = async () => {
    const lock = await readPrivateJson(f.files.operationLock);
    await writePrivateJson(f.files.operationLock, { ...lock, operationId: randomUUID() });
  };
  await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-clone-two-unknowns', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'MANAGED_LOCK_CLEANUP_UNKNOWN'); assert.equal(error.cause.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN');
    assert.equal(error.targetResult.state, 'ready'); assert.match(error.cause.cause.cleanupCause.message, /did not close/); return true;
  });
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); await f.assertPreserved();
});

test('ready target with missing target journal lock preserves its result and target managed fence while confirmed source cleanup releases source locks', async t => {
  const f = await cloneFixture(t), target = 'synthetic-clone-target-missing-lock';
  const files = f.managed.paths(target);
  f.state.onTargetReady = async () => { await fs.unlink(`${files.journal}.lock`); };
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN');
    assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); assert.equal(error.cause.cleanupCause.code, 'ENOENT');
    assert.equal(error.cause.taskResult.state, 'ready'); assert.equal(error.targetResult.worker, target);
    assert.equal(error.targetResult.state, 'ready'); assert.equal(error.reconciliationCause, undefined); return true;
  });
  const deployment = await f.managed.deployment(target);
  assert.equal(deployment.metadata.phase, 'ready'); assert.equal(deployment.journal.state, 'ready');
  assert.equal(deployment.metadata.journalOwner, deployment.journal.owner);
  assert.equal(deployment.metadata.cloneSource.workerId, f.worker); await readPrivateJson(files.credentials);
  await fs.lstat(files.operationLock); await assert.rejects(fs.lstat(`${files.journal}.lock`), { code: 'ENOENT' });
  await assert.rejects(f.managed.call(target, { request: { messages: [] } }), { code: 'MANAGED_BUSY' });
  await assert.rejects(f.managed.down(target), { code: 'MANAGED_BUSY' });
  await f.assertPreserved(); await f.assertReleased();
  assert.equal(f.state.calls.filter(({ args }) => args[0] === 'apps' && args[1] === 'create').length, 1);
  assert.equal(f.state.calls.some(({ args }) => args[0] === 'apps' && args[1] === 'destroy'), false);
});

test('ready target operator-lock replacement remains intact and cannot turn the original cleanup failure into a failed-state mismatch', async t => {
  const f = await cloneFixture(t), target = 'synthetic-clone-target-replaced-lock', files = f.managed.paths(target);
  f.state.onTargetReady = async () => {
    await fs.rename(`${files.journal}.lock`, `${files.journal}.lock.displaced`);
    await fs.writeFile(`${files.journal}.lock`, 'replacement target lock', { flag: 'wx', mode: 0o600 });
  };
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN');
    assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); assert.match(error.cause.cleanupCause.message, /identity changed/);
    assert.equal(error.targetResult.state, 'ready'); assert.equal(error.targetResult.worker, target);
    assert.equal(error.reconciliationCause, undefined); return true;
  });
  assert.equal(await fs.readFile(`${files.journal}.lock`, 'utf8'), 'replacement target lock'); await fs.lstat(files.operationLock);
  const deployment = await f.managed.deployment(target);
  assert.equal(deployment.metadata.phase, 'ready'); assert.equal(deployment.metadata.journalOwner, deployment.journal.owner);
  await f.assertPreserved(); await f.assertReleased();
});

test('failed target capture plus target journal cleanup failure retains the original capture cause and target hold without replay', async t => {
  const f = await cloneFixture(t), target = 'synthetic-clone-target-failed-lock', files = f.managed.paths(target);
  f.state.badHash = true;
  f.state.beforeAbort = async () => { await fs.unlink(`${files.journal}.lock`); };
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN');
    assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); assert.match(error.cause.cause.message, /integrity digest/);
    assert.equal(error.targetResult, undefined); assert.equal(error.reconciliationCause, undefined); return true;
  });
  const deployment = await f.managed.deployment(target);
  assert.equal(deployment.metadata.phase, 'provisioning'); assert.equal(deployment.journal.state, 'failed');
  assert.equal(deployment.journal.stage, 'snapshot'); await readPrivateJson(files.credentials); await fs.lstat(files.operationLock);
  assert.equal(f.state.requests.filter(r => r.url.pathname === '/api/snapshot/begin').length, 1);
  assert.equal(f.state.requests.filter(r => r.url.pathname === '/api/snapshot/abort').length, 1);
  f.assertNoProvision(); await f.assertPreserved(); await f.assertReleased();
});

test('target and source cleanup uncertainty retain their separate fences and one matching ready target result', async t => {
  const f = await cloneFixture(t), target = 'synthetic-clone-target-source-unknown', files = f.managed.paths(target);
  f.state.onTargetReady = async () => { await fs.unlink(`${files.journal}.lock`); };
  f.state.sourceStopUnknown = true;
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN'); assert.equal(error.targetResult.worker, target);
    assert.equal(error.targetResult.state, 'ready'); assert.equal(error.cause.code, 'PROXY_CLEANUP_UNKNOWN');
    assert.equal(error.cause.cause.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN');
    assert.equal(error.cause.cause.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); return true;
  });
  await fs.lstat(files.operationLock); await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`);
  await assert.rejects(fs.lstat(`${files.journal}.lock`), { code: 'ENOENT' });
  assert.equal((await f.managed.deployment(target)).metadata.phase, 'ready'); await f.assertPreserved();
});

test('ready target metadata binding failure preserves the observed ready result and original journal cleanup cause without granting another operation', async t => {
  const f = await cloneFixture(t), target = 'synthetic-clone-target-binding-unknown', files = f.managed.paths(target);
  f.state.onTargetReady = async () => { await fs.unlink(`${files.journal}.lock`); };
  const cause = new Error('Synthetic ready metadata binding failed.');
  f.state.beforeWrite = async (filename, value) => { if (filename === files.metadata && value.phase === 'ready') throw cause; };
  await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN');
    assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); assert.equal(error.cause.taskResult.state, 'ready');
    assert.equal(error.targetResult.state, 'ready'); assert.equal(error.reconciliationCause, cause); return true;
  });
  assert.equal((await readPrivateJson(files.metadata)).phase, 'provisioning');
  assert.equal((await new Journal(files.journal).read()).state, 'ready');
  await fs.lstat(files.operationLock); await readPrivateJson(files.credentials);
  await assert.rejects(f.managed.call(target, { request: { messages: [] } }), { code: 'MANAGED_BUSY' });
  await assert.rejects(f.managed.down(target), { code: 'MANAGED_BUSY' }); await f.assertPreserved(); await f.assertReleased();
});

test('normal successful target bridge outcome survives final ready binding write or missing-journal failure behind its managed fence', async t => {
  for (const failure of ['write', 'missing-journal']) {
    await t.test(failure, async t => {
      const f = await cloneFixture(t), target = `synthetic-clone-normal-binding-${failure}`, files = f.managed.paths(target);
      const cause = new Error('Synthetic final ready metadata write failed.');
      if (failure === 'write') {
        f.state.beforeWrite = async (filename, value) => { if (filename === files.metadata && value.phase === 'ready') throw cause; };
      } else {
        const up = f.bridge.up.bind(f.bridge);
        f.bridge.up = async (...args) => {
          const result = await up(...args);
          assert.equal(result.state, 'ready');
          await fs.rename(files.journal, `${files.journal}.displaced`);
          return result;
        };
      }
      await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
        assert.equal(error.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN'); assert.equal(error.targetWorker, target);
        assert.equal(error.targetResult.worker, target); assert.equal(error.targetResult.app, target);
        assert.equal(error.targetResult.state, 'ready'); assert.equal(error.targetResult.workspace, 'test-cloud');
        assert.equal(error.targetResult.machineId, 'target_machine'); assert.equal(error.targetResult.journal, files.journal);
        assert.equal(error.cause, error.reconciliationCause);
        if (failure === 'write') assert.equal(error.cause, cause);
        else assert.match(error.cause.message, /outcome is incomplete/);
        return true;
      });
      const metadata = await readPrivateJson(files.metadata);
      assert.equal(metadata.phase, 'provisioning'); assert.equal(metadata.journalOwner, undefined);
      assert.equal(metadata.cloneSource.workerId, f.worker); await readPrivateJson(files.credentials);
      const journal = await new Journal(failure === 'write' ? files.journal : `${files.journal}.displaced`).read();
      assert.equal(journal.state, 'ready'); assert.equal(journal.stage, 'ready'); assert.equal(journal.machineId, 'target_machine');
      await fs.lstat(files.operationLock); await assert.rejects(fs.lstat(`${files.journal}.lock`), { code: 'ENOENT' });
      if (failure === 'missing-journal') await assert.rejects(fs.lstat(files.journal), { code: 'ENOENT' });
      await assert.rejects(f.managed.call(target, { request: { messages: [] } }), { code: 'MANAGED_BUSY' });
      await assert.rejects(f.managed.down(target), { code: 'MANAGED_BUSY' });
      await assert.rejects(f.managed.clone(target, { app: 'synthetic-forbidden-target-replay' }), { code: 'MANAGED_BUSY' });
      await f.assertPreserved(); await f.assertReleased();
      assert.equal(f.state.calls.filter(({ args }) => args[0] === 'apps' && args[1] === 'create').length, 1);
      assert.equal(f.state.requests.filter(({ url }) => url.pathname === '/api/snapshot/begin').length, 1);
      assert.equal(f.state.requests.some(({ url }) => url.pathname === '/v1/chat/completions'), false);
      assert.equal(f.state.calls.some(({ args }) => args[0] === 'apps' && args[1] === 'destroy'), false);
    });
  }
});

test('target reconciliation result survives missing or replaced source journal-lock cleanup after confirmed source proxy close', async t => {
  for (const failure of ['missing', 'replaced']) {
    await t.test(failure, async t => {
      const f = await cloneFixture(t), target = `synthetic-clone-source-lock-${failure}`, files = f.managed.paths(target);
      f.state.onTargetReady = async () => { await fs.unlink(`${files.journal}.lock`); };
      f.state.onSourceStop = async () => {
        if (failure === 'missing') await fs.unlink(`${f.files.journal}.lock`);
        else {
          await fs.rename(`${f.files.journal}.lock`, `${f.files.journal}.lock.displaced`);
          await fs.writeFile(`${f.files.journal}.lock`, 'replacement source lock', { flag: 'wx', mode: 0o600 });
        }
      };
      await assert.rejects(f.managed.clone(f.worker, { app: target, timeoutMs: 1000 }), error => {
        assert.equal(error.code, 'CLONE_SOURCE_CLEANUP_UNKNOWN'); assert.equal(error.targetResult.worker, target);
        assert.equal(error.targetResult.state, 'ready'); assert.equal(error.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN');
        assert.equal(error.cause.cause.code, 'MANAGED_TARGET_RECONCILIATION_UNKNOWN');
        assert.equal(error.cause.cause.cause.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN');
        assert.equal(error.cause.cause.cause.cleanupCause.code, 'ENOENT');
        assert.equal(error.targetResult, error.cause.targetResult);
        assert.equal(error.targetResult, error.cause.cause.targetResult);
        assert.equal(error.cleanupErrors.length, 1); assert.equal(error.cleanupErrors[0], error.cause);
        if (failure === 'missing') assert.equal(error.cause.cleanupCause.code, 'ENOENT');
        else assert.match(error.cause.cleanupCause.message, /identity changed/);
        return true;
      });
      const sourceProxy = f.state.proxies.find(proxy => proxy.app === f.worker);
      assert.equal(sourceProxy.active, false); assert.equal(sourceProxy.stopCalls, 1);
      await fs.lstat(f.files.operationLock); await fs.lstat(files.operationLock);
      await assert.rejects(fs.lstat(`${files.journal}.lock`), { code: 'ENOENT' });
      if (failure === 'missing') await assert.rejects(fs.lstat(`${f.files.journal}.lock`), { code: 'ENOENT' });
      else {
        assert.equal(await fs.readFile(`${f.files.journal}.lock`, 'utf8'), 'replacement source lock');
        await fs.lstat(`${f.files.journal}.lock.displaced`);
      }
      assert.equal((await f.managed.deployment(target)).metadata.phase, 'ready'); await f.assertPreserved();
      await assert.rejects(f.managed.call(target, { request: { messages: [] } }), { code: 'MANAGED_BUSY' });
      await assert.rejects(f.managed.down(target), { code: 'MANAGED_BUSY' });
      await assert.rejects(f.managed.clone(f.worker, { app: 'synthetic-forbidden-source-replay' }), { code: 'MANAGED_BUSY' });
      assert.equal(f.state.calls.filter(({ args }) => args[0] === 'apps' && args[1] === 'create').length, 1);
      assert.equal(f.state.requests.filter(({ url }) => url.pathname === '/api/snapshot/begin').length, 1);
      assert.equal(f.state.requests.some(({ url }) => url.pathname === '/v1/chat/completions'), false);
      assert.equal(f.state.calls.some(({ args }) => args[0] === 'apps' && args[1] === 'destroy'), false);
    });
  }
});
