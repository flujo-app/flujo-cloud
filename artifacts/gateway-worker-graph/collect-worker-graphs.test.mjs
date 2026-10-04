import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGatewayWorkerGraphs } from './collect-worker-graphs.mjs';

const config = () => ({ workers: [
  { origin: 'https://worker-1.example.test', token: 'FICTIONAL_WORKER_ONE_TOKEN_123456789', workspace: 'fixture-dev', role: 'developer', model: 'model_1' },
  { origin: 'https://worker-2.example.test', token: 'FICTIONAL_WORKER_TWO_TOKEN_123456789', workspace: 'fixture-dev', role: 'reviewer', model: 'model_1' },
] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const values = workspace => ({
  '/api/worker/status': { mode: 'worker', workspace, state: 'ready', servers: [{ name: 'files', status: 'ready' }] },
  '/api/flow': [{ id: 'flow_1', name: 'Review', nodes: [
    { id: 'start_1', data: { type: 'start', properties: { privatePrompt: 'PRIVATE' } } },
    { id: 'process_1', data: { type: 'process', properties: { boundModel: 'model_1', boundServer: 'files' } }, position: { x: 10, y: 20 } },
  ], edges: [{ source: 'start_1', target: 'process_1' }] }],
  '/api/model': [{ id: 'model_1', name: 'Fixture model', provider: 'codex', adapter: 'codex-cli', ApiKey: 'PRIVATE', baseUrl: 'https://private.example.test' }],
  '/api/mcp/servers': [{ name: 'files', transport: 'stdio', env: { TOKEN: 'PRIVATE' }, args: ['PRIVATE'] }],
});
function fixture(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options });
    return handler ? await handler(parsed, options, calls) : json(values(parsed.searchParams.get('workspace'))[parsed.pathname]);
  };
  return { calls, fetchImpl };
}

test('collects two configured targets with fixed authenticated GETs, safe projections and no ownership claims', async () => {
  const input = config(), before = JSON.stringify(input), fake = fixture();
  const report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl });
  assert.equal(JSON.stringify(input), before);
  assert.equal(fake.calls.length, 8);
  assert.deepEqual(fake.calls.map(call => call.url.pathname), ['/api/worker/status', '/api/flow', '/api/model', '/api/mcp/servers', '/api/worker/status', '/api/flow', '/api/model', '/api/mcp/servers']);
  for (const call of fake.calls) {
    const worker = input.workers.find(item => item.origin === call.url.origin);
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.url.searchParams.get('workspace'), worker.workspace);
    assert.equal(call.options.headers['x-flujo-workspace'], worker.workspace);
    assert.equal(call.options.headers.Authorization, 'Bearer ' + worker.token);
    assert.equal(call.options.headers.Origin, worker.origin);
  }
  assert.equal(report.format, 'flujo-gateway-worker-graphs');
  assert.deepEqual(report.source, { kind: 'injected-http', sample: false, ownershipVerified: false, machineRouting: 'configured-app-origin' });
  assert.deepEqual(report.observation, { consistency: 'sequential', qualification: false });
  assert.deepEqual(report.workers.map(worker => worker.roles), [['developer'], ['reviewer']]);
  const first = report.workers[0];
  assert.deepEqual(first.status, { available: true, state: 'ready' });
  assert.equal(first.flows[0].nodes[1].boundModel, 'model_1');
  assert.equal(first.flows[0].nodes[1].boundServer, 'files');
  assert.deepEqual(first.flows[0].edges, [{ source: 'start_1', target: 'process_1' }]);
  const serialized = JSON.stringify(report);
  for (const text of ['PRIVATE', ...input.workers.map(worker => worker.token), ...input.workers.map(worker => worker.origin)]) assert.equal(serialized.includes(text), false);
  for (const key of ['machineId', 'image', 'callSelection', 'links']) assert.equal(Object.hasOwn(first, key), false);
});

test('code developer on the same configured target shares one observation instead of inventing another Machine', async () => {
  const input = config(); input.codeWorker = { ...input.workers[0], model: 'different-code-model', processNodeId: 'code-process' };
  const fake = fixture(), report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl, includeUiLinks: true });
  assert.equal(report.workers.length, 2); assert.equal(fake.calls.length, 8);
  assert.deepEqual(report.workers[0].roles, ['developer', 'code-developer']);
  assert.deepEqual(report.workers[0].links, [{ kind: 'flujo-ui', href: input.workers[0].origin + '/' }]);
  assert.equal(JSON.stringify(report.workers[0].links).includes(input.workers[0].token), false);
});

test('distinct configured code target is collected but never claimed to be a verified physical worker', async () => {
  const input = config(); input.codeWorker = { ...input.workers[0], origin: 'https://code.example.test' };
  const fake = fixture(), report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls.length, 12); assert.equal(report.workers.length, 3);
  assert.deepEqual(report.workers[2].roles, ['code-developer']);
  assert.equal(report.source.ownershipVerified, false);
});

test('unavailable model inventory preserves available topology and drops unmatched model binding', async () => {
  const input = config(); input.workers = [input.workers[0]];
  const fake = fixture(url => url.pathname === '/api/model' ? json({ secret: 'PRIVATE' }, 503) : json(values('fixture-dev')[url.pathname]));
  const worker = (await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl })).workers[0];
  assert.deepEqual(worker.collections.models, { available: false, truncated: false });
  assert.equal(worker.collections.flows.available, true); assert.equal(worker.collections.servers.available, true);
  assert.equal(Object.hasOwn(worker.flows[0].nodes[1], 'boundModel'), false);
  assert.equal(worker.flows[0].nodes[1].boundServer, 'files');
  assert.equal(worker.errors.models, 'HTTP_UNAVAILABLE');
});

test('authentication refusal stops further collection requests for that target, without echoing remote error bodies', async () => {
  const input = config(); input.workers = [input.workers[0]];
  const fake = fixture(url => url.pathname === '/api/model' ? json({ error: input.workers[0].token }, 401) : json(values('fixture-dev')[url.pathname]));
  const worker = (await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl })).workers[0];
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(worker.errors, { models: 'AUTHENTICATION_REFUSED', servers: 'AUTHENTICATION_REFUSED' });
  assert.equal(JSON.stringify(worker).includes(input.workers[0].token), false);
});

test('workspace mismatch, nonready status, refusal and transport failure never dispatch inventory or inference', async () => {
  for (const [handler, code] of [
    [() => json({ mode: 'worker', state: 'ready', workspace: 'other' }), 'WORKSPACE_MISMATCH'],
    [() => json({ mode: 'worker', state: 'locked', workspace: 'fixture-dev' }), 'WORKER_NOT_READY'],
    [() => json({}, 403), 'AUTHENTICATION_REFUSED'],
    [() => { throw new Error('PRIVATE transport error'); }, 'TRANSPORT_UNAVAILABLE'],
    [() => json({ state: 'ready', workspace: 'fixture-dev' }), 'INVALID_STATUS'],
  ]) {
    const input = config(); input.workers = [input.workers[0]];
    const fake = fixture(handler), worker = (await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl })).workers[0];
    assert.equal(fake.calls.length, 1); assert.equal(worker.status.code, code);
    assert.equal(worker.collections.flows.available, false); assert.deepEqual(worker.flows, []);
    assert.equal(JSON.stringify(worker).includes('PRIVATE'), false);
  }
});

test('declared and streamed body bounds and malformed JSON preserve unavailable markers', async () => {
  const variants = [
    () => new Response('{}', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } })),
    () => new Response('{invalid'),
    () => new Response(new Uint8Array([0xff, 0xfe])),
    () => json({ flows: [] }),
  ];
  for (let index = 0; index < variants.length; index++) {
    const input = config(); input.workers = [input.workers[0]];
    const fake = fixture(url => url.pathname === '/api/flow' ? variants[index]() : json(values('fixture-dev')[url.pathname]));
    const worker = (await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl })).workers[0];
    assert.equal(worker.collections.flows.available, false);
    assert.equal(worker.errors.flows, index < 2 ? 'BODY_LIMIT' : index === 4 ? 'INVALID_INVENTORY' : 'INVALID_RESPONSE');
  }
});

test('known worker token in an otherwise printable projected label refuses the entire target inventory', async () => {
  const input = config(); input.workers = [input.workers[0]];
  const fake = fixture(url => url.pathname === '/api/model' ? json([{ id: 'model_1', name: input.workers[0].token }]) : json(values('fixture-dev')[url.pathname]));
  const worker = (await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl })).workers[0];
  assert.equal(worker.status.code, 'KNOWN_SECRET_REFUSED');
  assert.deepEqual(worker.flows, []); assert.deepEqual(worker.models, []); assert.deepEqual(worker.servers, []);
  assert.equal(JSON.stringify(worker).includes(input.workers[0].token), false);
});

test('JSON-escaped quote and backslash token values are refused before any observation is returned', async () => {
  for (const token of ['synthetic"token_012345678901234567890', 'synthetic\\token_012345678901234567890']) {
    const input = config(); input.workers = [{ ...input.workers[0], token }];
    const fake = fixture(url => url.pathname === '/api/model' ? json([{ id: 'model_1', name: token }]) : json(values('fixture-dev')[url.pathname]));
    const worker = (await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl })).workers[0];
    assert.equal(worker.status.code, 'KNOWN_SECRET_REFUSED');
    assert.deepEqual(worker.models, []); assert.deepEqual(worker.flows, []);
    const serialized = JSON.stringify(worker);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(JSON.stringify(token).slice(1, -1)), false);
  }
});

test('a single deadline bounds a never-settling fetch and all remaining targets, with zero retries', async () => {
  const input = config(), calls = [];
  const started = performance.now();
  const report = await collectGatewayWorkerGraphs(input, { timeoutMs: 1000, fetchImpl: (url, options) => { calls.push({ url, options }); return new Promise(() => {}); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, true);
  assert.ok(performance.now() - started < 3000);
  assert.deepEqual(report.workers.map(worker => worker.status.code), ['TIMEOUT', 'TIMEOUT']);
});

test('deadline covers a stalled response body even when cancellation never settles', async () => {
  const input = config(); input.workers = [input.workers[0]];
  const fake = fixture(url => url.pathname === '/api/flow'
    ? new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }))
    : json(values('fixture-dev')[url.pathname]));
  const started = performance.now(), worker = (await collectGatewayWorkerGraphs(input, { timeoutMs: 1000, fetchImpl: fake.fetchImpl })).workers[0];
  assert.ok(performance.now() - started < 3000); assert.equal(fake.calls.length, 2);
  assert.deepEqual(worker.errors, { flows: 'TIMEOUT', models: 'TIMEOUT', servers: 'TIMEOUT' });
});

test('configuration/options refuse before transport, without echoing origins or credential values', async () => {
  for (const change of [
    value => value.workers[0].origin = 'https://secret:password@worker.example.test',
    value => value.workers[0].origin = 'https://worker.example.test/?token=PRIVATE',
    value => value.workers[0].origin = 'http://worker.example.test',
    value => value.workers[0].workspace = '../PRIVATE',
    value => value.workers[0].token = 'short',
    value => value.workers = [],
    value => value.workers[0].workspace = value.workers[1].token,
  ]) {
    const input = config(); change(input); const fake = fixture();
    await assert.rejects(collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl }), /^Error: Invalid (configured worker|worker graph configuration)\.$/);
    assert.equal(fake.calls.length, 0);
  }
  const fake = fixture();
  for (const options of [{ timeoutMs: 999 }, { timeoutMs: 30_001 }, { includeUiLinks: 'true' }, { fetchImpl: null }]) {
    await assert.rejects(collectGatewayWorkerGraphs(config(), { fetchImpl: fake.fetchImpl, ...options }), /Invalid graph observation options/);
  }
  assert.equal(fake.calls.length, 0);
});
