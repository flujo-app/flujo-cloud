import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedCloud } from '../lib/managed.mjs';
import { Journal } from '../lib/journal.mjs';
import { readPrivateJson, writePrivateJson } from '../lib/private-files.mjs';

const sourceToken = 'synthetic_source_private_01234567890123456789';
const origin = 'http://127.0.0.1:43451';
const image = `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`;
const compatibility = { applicationVersion: '3.45.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };

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
        workspace: options.workspace, image: options.image, flowIds: options.flowIds,
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
    if (request.pathname === '/api/snapshot/info') return Response.json({ workspace: 'test-cloud', capability: 'available', workerCompatibility: compatibility });
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
    resolveImage: async ({ source, image: explicit }) => {
      assert.deepEqual(source, compatibility);
      if (state.failImage) throw new Error('No compatible official worker image.');
      return { image: explicit || image, mode: 'official', applicationVersion: '3.45.0', revision: 'b'.repeat(40) };
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
