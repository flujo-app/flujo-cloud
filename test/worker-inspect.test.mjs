import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CloudBridge, buildMachineConfig } from '../lib/bridge.mjs';
import { ManagedCloud } from '../lib/managed.mjs';
import { Journal } from '../lib/journal.mjs';
import { ensurePrivateDirectory, writePrivateJson } from '../lib/private-files.mjs';

const token = 'synthetic_inspection_token_01234567890123456789';
const image = `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`;

async function fixture(t, { privateWorkspace = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-inspection-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith('flujo-inspection-test-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const worker = 'synthetic-inspect-worker', owner = randomUUID(), attemptId = randomUUID();
  const profile = privateWorkspace ? { profile: 'private-workspace', recoveryId: randomUUID(), recoveryEpoch: 7,
    defaultFlowIds: ['flow-a'], sourceRevision: 'b'.repeat(40), targetRevision: 'b'.repeat(40), sourceProvenance: 'reported-native',
    sourceCompatibility: { applicationVersion: '3.45.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1, workerSnapshotSourceVersion: 1 } } : {};
  const record = { format: 'flujo-cloud-journal', version: 1, owner, app: worker, appId: worker, org: 'example-org', region: 'iad',
    workspace: 'test-cloud', image, authState: 'copied-workspace', state: 'ready', stage: 'ready', appCreated: true, ownershipConfirmed: true,
    volumeId: 'vol_source', volumeName: 'source-volume', machineId: 'source_machine', machineName: 'source-machine', archiveSha256: '9'.repeat(64),
    ...profile, ...(!privateWorkspace ? { flowIds: ['flow-a'] } : {}) };
  const metadata = { format: 'flujo-managed-deployment', version: 1, id: worker, attemptId, phase: 'ready', journalOwner: owner,
    source: 'http://127.0.0.1:4200', workspace: record.workspace, org: record.org, region: record.region, image, ...profile };
  const state = { commands: [], requests: [], proxies: [], status: { mode: 'worker', state: 'ready', workspace: record.workspace, archiveSha256: record.archiveSha256 },
    flows: [{ id: 'flow-a', name: 'Demo', nodes: [{ id: 'start', data: { type: 'Start', properties: { prompt: 'synthetic-private-prompt' } } }], edges: [] },
      { id: 'flow-extra', name: 'Unselected', nodes: [], edges: [] }],
    models: [{ id: 'model-a', name: 'Demo model', provider: 'ollama', adapter: 'openai', ApiKey: 'synthetic-private-api-key', baseUrl: 'https://private.invalid/v1' }],
    servers: [{ name: 'test-server', transport: 'stdio', command: 'private-command', args: ['private-argument'], env: { TOKEN: 'private-value' } }] };
  const machine = { id: record.machineId, name: record.machineName, state: 'started', config: buildMachineConfig(record, { idle: false }), image_ref: { digest: image.split('@')[1] } };
  const app = { ID: worker, Name: worker, Organization: { Slug: record.org } };
  const fly = { async run(args) {
    state.commands.push(args);
    if (args[0] === 'apps' && args[1] === 'list') return JSON.stringify([app]);
    if (args[0] === 'secrets' && args[1] === 'list') return JSON.stringify([{ Name: `FLUJO_CLOUD_OWNER_${owner.replaceAll('-', '').toUpperCase()}` }]);
    if (args[0] === 'machine' && args[1] === 'list') return JSON.stringify([machine]);
    throw new Error('Unexpected inspection mutation command.');
  }, async proxy(options) {
    state.proxies.push(options);
    if (state.proxyAcquisitionUnknown) throw new Error('Synthetic private proxy acquisition cause.');
    return { origin: 'http://127.0.0.1:46010', check() {}, async stop() {
      state.stopCalls = (state.stopCalls ?? 0) + 1; await state.onStop?.();
      if (state.stopUnknown) throw new Error('Synthetic unobserved child close.');
      return state.noCloseReceipt ? undefined : { childClosed: true };
    } };
  } };
  const fetchImpl = async (input, init) => {
    const url = new URL(input); state.requests.push({ url, init });
    assert.equal(url.origin, 'http://127.0.0.1:46010');
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['x-flujo-workspace'], record.workspace); assert.equal(url.searchParams.get('workspace'), record.workspace);
    await fs.lstat(files.operationLock); await fs.lstat(`${files.journal}.lock`);
    if (state.onRequest) { const override = await state.onRequest(url, init); if (override !== undefined) return override; }
    if (url.pathname === '/api/worker/status') return Response.json(state.status, { status: state.statusCode ?? 200 });
    if (url.pathname === '/api/flow') return Response.json(state.flows);
    if (url.pathname === '/api/model') return Response.json(state.models);
    if (url.pathname === '/api/mcp/servers') return Response.json(state.servers);
    throw new Error('Unexpected inspection endpoint.');
  };
  const bridge = new CloudBridge({ fly, fetchImpl, port: async () => 46010, sleepImpl: async () => undefined });
  const managed = new ManagedCloud({ directory: path.join(directory, 'controller'), env: {}, fly, bridge, fetchImpl,
    discover: async () => { throw new Error('Inspection must not discover a local source.'); } });
  const files = managed.paths(worker);
  await ensurePrivateDirectory(managed.directory); await ensurePrivateDirectory(files.root);
  await new Journal(files.journal).create(record);
  await writePrivateJson(files.metadata, metadata);
  await writePrivateJson(files.credentials, { format: 'flujo-worker-credential', version: 1, id: worker, attemptId, token });
  const filenames = [files.journal, files.metadata, files.credentials];
  const saved = await Promise.all(filenames.map(filename => fs.readFile(filename)));
  const preserved = async () => assert.deepEqual(await Promise.all(filenames.map(filename => fs.readFile(filename))), saved);
  const released = async () => { await assert.rejects(fs.lstat(files.operationLock), { code: 'ENOENT' }); await assert.rejects(fs.lstat(`${files.journal}.lock`), { code: 'ENOENT' }); };
  return { managed, bridge, state, files, record, metadata, machine, app, worker, preserved, released };
}

for (const privateWorkspace of [false, true]) test(`inspection observes both inventories without widening ${privateWorkspace ? 'private defaults' : 'legacy call scope'}`, async t => {
  const f = await fixture(t, { privateWorkspace }); const report = await f.managed.inspect(f.worker);
  assert.equal(report.format, 'flujo-worker-observation');
  assert.deepEqual(f.state.requests.map(x => x.url.pathname), ['/api/worker/status', '/api/flow', '/api/model', '/api/mcp/servers']);
  assert.deepEqual(f.state.commands.map(args => args.slice(0, 2)), [['apps', 'list'], ['secrets', 'list'], ['machine', 'list']]);
  assert.equal(f.state.proxies.length, 1); assert.equal(f.state.proxies[0].machineId, f.record.machineId); assert.equal(f.state.stopCalls, 1);
  assert.equal(report.flows.length, 2); assert.deepEqual(report.callSelection.flowIds, ['flow-a']);
  const text = JSON.stringify(report);
  for (const marker of [token, 'synthetic-private-prompt', 'synthetic-private-api-key', 'private.invalid', 'private-command', 'private-argument', 'private-value']) assert.equal(text.includes(marker), false);
  await f.preserved(); await f.released();
});

test('legacy incomplete journal and stopped or drifted Machines refuse before proxy or native requests', async t => {
  const f = await fixture(t);
  for (const mutation of [() => { f.machine.state = 'stopped'; }, () => { f.machine.state = 'started'; f.machine.image_ref.digest = `sha256:${'c'.repeat(64)}`; },
    () => { f.machine.image_ref.digest = f.record.image.split('@')[1]; f.machine.config.services = [{}]; }]) {
    mutation(); await assert.rejects(f.managed.inspect(f.worker)); await f.released();
  }
  assert.equal(f.state.proxies.length, 0); assert.equal(f.state.requests.length, 0); await f.preserved();
  await new Journal(f.files.journal).save({ ...f.record, state: 'failed' });
  await assert.rejects(f.managed.inspect(f.worker), /ready managed worker/); await f.released();
});

test('status identity, readiness and authorization must pass before inventory', async t => {
  const f = await fixture(t);
  for (const change of [{ workspace: 'other-workspace' }, { archiveSha256: '8'.repeat(64) }, { state: 'locked' }, { mode: 'local' }]) {
    f.state.status = { mode: 'worker', state: 'ready', workspace: f.record.workspace, archiveSha256: f.record.archiveSha256, ...change };
    const start = f.state.requests.length; await assert.rejects(f.managed.inspect(f.worker), /Authenticated worker status/);
    assert.equal(f.state.requests.length - start, 1); await f.released();
  }
  f.state.statusCode = 401; await assert.rejects(f.managed.inspect(f.worker), { code: 'INSPECTION_AUTH_REFUSED' });
  await f.preserved(); await f.released();
});

test('missing, malformed and oversized inventories remain unavailable; authorization refusal aborts', async t => {
  const f = await fixture(t);
  f.state.onRequest = async url => url.pathname === '/api/model' ? Response.json({ private: token }, { status: 404 })
    : url.pathname === '/api/mcp/servers' ? new Response('invalid-secret-value') : undefined;
  let report = await f.managed.inspect(f.worker);
  assert.equal(report.collections.models.available, false); assert.equal(report.collections.servers.available, false);
  f.state.onRequest = async url => url.pathname === '/api/model' ? new Response('[]', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) : undefined;
  report = await f.managed.inspect(f.worker); assert.equal(report.collections.models.available, false);
  f.state.onRequest = async url => url.pathname === '/api/model' ? Response.json({ private: token }, { status: 403 }) : undefined;
  const start = f.state.requests.length; await assert.rejects(f.managed.inspect(f.worker), { code: 'INSPECTION_AUTH_REFUSED' });
  assert.deepEqual(f.state.requests.slice(start).map(x => x.url.pathname), ['/api/worker/status', '/api/flow', '/api/model']);
  await f.preserved(); await f.released();
});

test('inspection holds both fences against concurrent managed/operator commands until its body completes', async t => {
  const f = await fixture(t); let arrived;
  const arrival = new Promise(resolve => { arrived = resolve; });
  let release; const barrier = new Promise(resolve => { release = resolve; });
  f.state.onRequest = async (url, init) => {
    if (url.pathname !== '/api/flow') return;
    arrived(); await barrier; return Response.json(f.state.flows);
  };
  const running = f.managed.inspect(f.worker);
  await arrival;
  try {
    for (const operation of [() => f.managed.inspect(f.worker), () => f.managed.call(f.worker, { request: { model: 'flow-a' } }), () => f.managed.down(f.worker)]) {
      await assert.rejects(operation(), { code: 'MANAGED_BUSY' });
    }
    await assert.rejects(new Journal(f.files.journal).locked(async () => assert.fail('operator lock must prevent entry')), /locked by another command/);
  } finally { release(); }
  await running; assert.equal(f.state.stopCalls, 1); await f.preserved(); await f.released();
});

test('stalled response body is aborted at the HTTP deadline and closes the proxy', async t => {
  const f = await fixture(t);
  f.state.onRequest = async (url, init) => {
    if (url.pathname !== '/api/flow') return;
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => { f.state.aborted = true; controller.error(new Error('synthetic abort')); }, { once: true });
    } }));
  };
  await assert.rejects(f.managed.inspect(f.worker, { timeoutMs: 1000 }), { code: 'INSPECTION_TIMEOUT' });
  assert.equal(f.state.aborted, true); assert.equal(f.state.stopCalls, 1); await f.preserved(); await f.released();
});

for (const noCloseReceipt of [false, true]) test(`uncertain proxy closure retains both fences and sanitized observation (${noCloseReceipt ? 'no receipt' : 'failed close'})`, async t => {
  const f = await fixture(t); f.state.noCloseReceipt = noCloseReceipt; f.state.stopUnknown = !noCloseReceipt;
  await assert.rejects(f.managed.inspect(f.worker), error => {
    assert.equal(error.code, 'PROXY_CLEANUP_UNKNOWN'); assert.equal(error.taskResult.format, 'flujo-worker-observation');
    assert.equal(JSON.stringify(error.taskResult).includes(token), false); return true;
  });
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`);
  await assert.rejects(f.managed.inspect(f.worker), { code: 'MANAGED_BUSY' }); await f.preserved();
});

test('replaced inner lock is preserved; missing inner lock is not fabricated', async t => {
  for (const missing of [false, true]) {
    const f = await fixture(t); const lock = `${f.files.journal}.lock`;
    f.state.onStop = async () => {
      if (missing) await fs.unlink(lock);
      else { await fs.rename(lock, `${lock}.displaced`); await fs.writeFile(lock, 'replacement lock', { flag: 'wx', mode: 0o600 }); }
    };
    await assert.rejects(f.managed.inspect(f.worker), error => {
      assert.equal(error.code, 'JOURNAL_LOCK_CLEANUP_UNKNOWN'); assert.equal(error.taskResult.format, 'flujo-worker-observation'); return true;
    });
    await fs.lstat(f.files.operationLock);
    if (missing) await assert.rejects(fs.lstat(lock), { code: 'ENOENT' }); else assert.equal(await fs.readFile(lock, 'utf8'), 'replacement lock');
    await f.preserved();
  }
});

test('known controller credential in a displayed label is withheld before partial observation can escape', async t => {
  const f = await fixture(t); f.state.flows[0].name = token; f.state.stopUnknown = true;
  await assert.rejects(f.managed.inspect(f.worker), error => {
    assert.equal(error.code, 'PROXY_CLEANUP_UNKNOWN'); assert.equal(error.taskResult, undefined);
    assert.match(error.cause.message, /controller credential/); return true;
  });
  await f.preserved();
});

test('initial proxy connection failures repeat only the bootstrap GET and remain bounded', async t => {
  const f = await fixture(t); let attempts = 0;
  f.state.onRequest = async url => {
    if (url.pathname === '/api/worker/status' && ++attempts < 3) throw new Error('Synthetic initial connection refusal.');
  };
  await f.managed.inspect(f.worker);
  assert.deepEqual(f.state.requests.map(x => x.url.pathname), ['/api/worker/status', '/api/worker/status', '/api/worker/status', '/api/flow', '/api/model', '/api/mcp/servers']);
  f.state.onRequest = async () => { throw new Error('Synthetic persistent connection refusal.'); };
  const start = f.state.requests.length;
  await assert.rejects(f.managed.inspect(f.worker), { code: 'INSPECTION_UNREACHABLE' });
  assert.equal(f.state.requests.length - start, 3); await f.preserved(); await f.released();
});

test('journal revalidation refuses a stale expected record before any Fly or worker reads', async t => {
  const f = await fixture(t);
  await assert.rejects(f.managed.operation(f.worker, 'inspection-fixture', async () => f.bridge.inspect({ journal: f.files.journal,
    expectedRecord: { ...f.record, stage: 'different-stage' } }, { FLUJO_CLOUD_CONTROL_TOKEN: token })), /journal changed/);
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.proxies.length, 0); assert.equal(f.state.requests.length, 0);
  await f.preserved(); await f.released();
});

test('unconfirmed proxy acquisition is an explicit reconciliation error with both fences preserved', async t => {
  const f = await fixture(t); f.state.proxyAcquisitionUnknown = true;
  await assert.rejects(f.managed.inspect(f.worker), { code: 'INSPECTION_CLEANUP_UNKNOWN' });
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`);
  assert.equal(f.state.requests.length, 0); await f.preserved();
});

test('combined proxy and managed-lock uncertainty preserves the projected observation and changed lock', async t => {
  const f = await fixture(t); f.state.stopUnknown = true;
  f.state.onStop = async () => {
    const lock = JSON.parse(await fs.readFile(f.files.operationLock, 'utf8'));
    await writePrivateJson(f.files.operationLock, { ...lock, operationId: randomUUID() });
  };
  await assert.rejects(f.managed.inspect(f.worker), error => {
    assert.equal(error.code, 'MANAGED_LOCK_CLEANUP_UNKNOWN'); assert.equal(error.cause.code, 'PROXY_CLEANUP_UNKNOWN');
    assert.equal(error.taskResult.format, 'flujo-worker-observation'); assert.equal(JSON.stringify(error.taskResult).includes(token), false); return true;
  });
  await fs.lstat(f.files.operationLock); await fs.lstat(`${f.files.journal}.lock`); await f.preserved();
});
