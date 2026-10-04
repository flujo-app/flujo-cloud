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

test('six distinct default and large profile entries collect at most 24 fixed GETs with explicit roles', async () => {
  const input = config();
  input.codeWorker = { ...input.workers[0], origin: 'https://code.example.test', workspace: 'fixture-code', token: 'FICTIONAL_CODE_TOKEN_1234567890123456' };
  input.largeWorkers = [
    { ...input.workers[0], origin: 'https://large-dev.example.test', workspace: 'fixture-large-dev', token: 'FICTIONAL_LARGE_DEV_TOKEN_123456789' },
    { ...input.workers[1], origin: 'https://large-review.example.test', workspace: 'fixture-large-review', token: 'FICTIONAL_LARGE_REVIEW_TOKEN_123456' },
  ];
  input.largeCodeWorker = { ...input.codeWorker, origin: 'https://large-code.example.test', workspace: 'fixture-large-code', token: 'FICTIONAL_LARGE_CODE_TOKEN_123456789' };
  const before = JSON.stringify(input), fake = fixture();
  const report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl });
  assert.equal(JSON.stringify(input), before);
  assert.equal(fake.calls.length, 24); assert.equal(report.workers.length, 6);
  assert.deepEqual(report.workers.map(worker => worker.id), ['worker-1', 'worker-2', 'code-worker', 'large-worker-1', 'large-worker-2', 'large-code-worker']);
  assert.deepEqual(report.workers.map(worker => worker.roles), [['developer'], ['reviewer'], ['code-developer'], ['large-developer'], ['large-reviewer'], ['large-code-developer']]);
  const entries = [...input.workers, input.codeWorker, ...input.largeWorkers, input.largeCodeWorker];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index], calls = fake.calls.slice(index * 4, index * 4 + 4);
    assert.deepEqual(calls.map(call => call.url.pathname), ['/api/worker/status', '/api/flow', '/api/model', '/api/mcp/servers']);
    for (const call of calls) {
      assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error');
      assert.equal(call.url.origin, entry.origin); assert.equal(call.url.searchParams.get('workspace'), entry.workspace);
      assert.equal(call.options.headers.Authorization, 'Bearer ' + entry.token);
      assert.equal(call.options.headers['x-flujo-workspace'], entry.workspace);
    }
  }
  const wire = JSON.stringify(report);
  for (const entry of entries) { assert.equal(wire.includes(entry.token), false); assert.equal(wire.includes(entry.origin), false); }
  assert.equal(report.observation.consistency, 'sequential'); assert.equal(report.observation.qualification, false);
});

test('deduplicates all six configured profile roles only by exact origin, workspace and token', async () => {
  const input = config(), base = input.workers[0];
  input.workers = [base, { ...base }]; input.codeWorker = { ...base };
  input.largeWorkers = [{ ...base }, { ...base }]; input.largeCodeWorker = { ...base };
  const fake = fixture(), report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl, includeUiLinks: true });
  assert.equal(fake.calls.length, 4); assert.equal(report.workers.length, 1);
  assert.equal(report.workers[0].id, 'worker-1');
  assert.deepEqual(report.workers[0].roles, ['developer', 'reviewer', 'code-developer', 'large-developer', 'large-reviewer', 'large-code-developer']);
  assert.deepEqual(report.workers[0].links, [{ kind: 'flujo-ui', href: base.origin + '/' }]);

  const distinct = config();
  distinct.largeWorkers = [
    { ...distinct.workers[0], workspace: 'fixture-other-workspace' },
    { ...distinct.workers[0], token: 'FICTIONAL_OTHER_CONTROL_TOKEN_12345678' },
  ];
  distinct.largeCodeWorker = { ...distinct.workers[1] };
  const otherFake = fixture(), other = await collectGatewayWorkerGraphs(distinct, { fetchImpl: otherFake.fetchImpl });
  assert.equal(otherFake.calls.length, 16); assert.equal(other.workers.length, 4);
  assert.deepEqual(other.workers.map(worker => worker.roles), [['developer'], ['reviewer', 'large-code-developer'], ['large-developer'], ['large-reviewer']]);
  assert.equal(otherFake.calls[8].options.headers['x-flujo-workspace'], 'fixture-other-workspace');
  assert.equal(otherFake.calls[12].options.headers.Authorization, 'Bearer ' + distinct.largeWorkers[1].token);
});

test('malformed or oversized large profiles refuse before any transport, even when targets would deduplicate', async () => {
  for (const change of [
    value => value.largeWorkers = null,
    value => value.largeWorkers = [],
    value => value.largeWorkers = { 0: value.workers[0], length: 1 },
    value => value.largeWorkers = [value.workers[0], value.workers[0], value.workers[0]],
    value => value.largeWorkers = Array(1),
    value => value.largeWorkers = [{ ...value.workers[0], origin: 'http://large.example.test' }],
    value => value.largeWorkers = [{ ...value.workers[0], workspace: '../PRIVATE' }],
    value => value.largeWorkers = [{ ...value.workers[0], token: 'short' }],
    value => value.largeCodeWorker = null,
    value => value.largeCodeWorker = [],
    value => value.largeCodeWorker = { ...value.workers[0], origin: 'https://large.example.test/?secret=PRIVATE' },
    value => Object.defineProperty(value, 'largeWorkers', { get() { throw new Error('PRIVATE getter'); } }),
    value => Object.defineProperty(value, 'largeCodeWorker', { get() { throw new Error('PRIVATE getter'); } }),
    value => { value.largeCodeWorker = { ...value.workers[0], token: 'FICTIONAL_LARGE_CROSS_TOKEN_12345678' }; value.workers[1].workspace = value.largeCodeWorker.token; },
  ]) {
    const input = config(); change(input); const fake = fixture();
    await assert.rejects(collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl }), /^Error: Invalid (configured worker|worker graph configuration)\.$/);
    assert.equal(fake.calls.length, 0);
  }
});

test('all large-profile token forms are collected before another target projects reflected labels', async () => {
  for (const token of ['FICTIONAL_LARGE_REFLECTED_TOKEN_123456', 'synthetic"large_token_012345678901234567890', 'synthetic\\large_token_012345678901234567890']) {
    const input = config();
    input.largeWorkers = [{ ...input.workers[0], origin: 'https://large.example.test' }];
    input.largeCodeWorker = { ...input.workers[0], origin: 'https://large-code.example.test', token };
    const fake = fixture(url => url.origin === input.workers[0].origin && url.pathname === '/api/model'
      ? json([{ id: 'model_1', name: token }]) : json(values('fixture-dev')[url.pathname]));
    const report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl });
    assert.equal(fake.calls.length, 16);
    const first = report.workers[0];
    assert.equal(first.status.code, 'KNOWN_SECRET_REFUSED');
    assert.deepEqual(first.flows, []); assert.deepEqual(first.models, []); assert.deepEqual(first.servers, []);
    assert.equal(report.workers[3].status.state, 'ready');
    const wire = JSON.stringify(report);
    assert.equal(wire.includes(token), false); assert.equal(wire.includes(JSON.stringify(token).slice(1, -1)), false);
  }
});

test('known whole-token URI, base64 and hex encodings from another profile refuse projected labels', async () => {
  const token = 'FiCtIoNaL!"\\~(+):/_Token_???_01234567890123456789';
  const base64 = Buffer.from(token, 'utf8').toString('base64');
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_');
  assert.ok(base64.endsWith('=')); assert.notEqual(base64url, base64);
  const uriForms = [encodeURIComponent(token), encodeURI(token), new URLSearchParams({ key: token }).toString().slice(4)];
  const labels = [...uriForms.flatMap(value => [value,
    value.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()),
    value.replace(/%[0-9A-F]{2}/g, (part, offset) => offset % 2 ? part.toLowerCase() : part),
  ]), base64, base64.replace(/=+$/, ''), base64url, base64url.replace(/=+$/, ''),
  Buffer.from(token, 'utf8').toString('hex'), Buffer.from(token, 'utf8').toString('hex').toUpperCase()];
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index], input = config();
    input.largeCodeWorker = { ...input.workers[0], origin: 'https://large-code.example.test', token };
    const fake = fixture(url => url.origin === input.workers[0].origin && url.pathname === '/api/model'
      ? json([{ id: 'model_1', name: label }]) : json(values('fixture-dev')[url.pathname]));
    const report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl });
    assert.equal(fake.calls.length, 12);
    const first = report.workers[0];
    assert.equal(first.status.code, 'KNOWN_SECRET_REFUSED', `known whole-token encoding case ${index}`);
    assert.deepEqual(first.flows, []); assert.deepEqual(first.models, []); assert.deepEqual(first.servers, []);
    const wire = JSON.stringify(report);
    assert.equal(wire.includes(label), false); assert.equal(wire.includes(JSON.stringify(label).slice(1, -1)), false);
  }
  // Only percent-escape hex is case-insensitive. Changing unescaped credential
  // letters produces a different value and must not be treated as this token.
  const different = encodeURIComponent(token).toLowerCase(), input = config();
  input.largeCodeWorker = { ...input.workers[0], origin: 'https://large-code.example.test', token };
  const fake = fixture(url => url.origin === input.workers[0].origin && url.pathname === '/api/model'
    ? json([{ id: 'model_1', name: different }]) : json(values('fixture-dev')[url.pathname]));
  const report = await collectGatewayWorkerGraphs(input, { fetchImpl: fake.fetchImpl });
  assert.equal(report.workers[0].status.state, 'ready');
  assert.equal(report.workers[0].models[0].name, different);
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
