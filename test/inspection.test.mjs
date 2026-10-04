import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkerInventory, INSPECTION_LIMITS } from '../lib/inspection.mjs';

const record = () => ({ app: 'fictional-worker', machineId: 'machine_1', workspace: 'test-cloud',
  image: `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`, flowIds: ['flow_1'], archiveSha256: 'b'.repeat(64) });
const node = (id, type = 'process', properties = {}) => ({ id, data: { type, properties }, position: { x: 10, y: 20 } });
const input = () => ({ record: record(), observedAt: '2026-10-04T12:00:00.000Z',
  status: { mode: 'worker', state: 'ready', workspace: 'test-cloud', archiveSha256: 'b'.repeat(64),
    servers: [{ name: 'files', status: 'connected' }] },
  flows: [{ id: 'flow_1', name: 'Review', nodes: [node('start_1', 'start'),
    node('process_1', 'process', { boundModel: 'model_1', boundServer: 'files', subflowId: 'flow_2' })],
    edges: [{ id: 'edge_1', source: 'start_1', target: 'process_1', sourceHandle: 'output', targetHandle: 'input' }] },
  { id: 'flow_2', name: 'Helper', nodes: [], edges: [] }],
  models: [{ id: 'model_1', name: 'fictional-model', displayName: 'Work model', provider: 'codex', adapter: 'codex-cli', supportsTools: true }],
  servers: [{ name: 'files', transport: 'stdio', disabled: false }] });

test('projects only safe inventory and topology, with no private configuration or input mutation', () => {
  const raw = input();
  const secret = 'FICTIONAL_SECRET_DO_NOT_COPY';
  raw.record.token = secret;
  raw.status.error = secret;
  raw.status.servers[0].error = secret;
  raw.flows[0].description = secret;
  raw.flows[0].history = [{ prompt: secret }];
  raw.flows[0].nodes[1].data.label = secret;
  Object.assign(raw.flows[0].nodes[1].data.properties, { promptTemplate: secret, toolParameterPresets: { value: secret }, origins: [secret] });
  raw.flows[0].edges[0].data = { secret };
  Object.assign(raw.models[0], { ApiKey: secret, baseUrl: secret, promptTemplate: secret });
  Object.assign(raw.servers[0], { env: { KEY: secret }, args: [secret], headers: { Authorization: secret }, oauthClientSecret: secret, serverUrl: secret });
  const before = JSON.stringify(raw);
  const result = projectWorkerInventory(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.flows[0].nodes[1], { id: 'process_1', type: 'process', position: { x: 10, y: 20 },
    boundModel: 'model_1', boundServer: 'files', subflowId: 'flow_2' });
  assert.deepEqual(result.servers, [{ name: 'files', transport: 'stdio', disabled: false, status: 'connected' }]);
  assert.deepEqual(result.callSelection, { kind: 'legacy-scope', recorded: true, flowIds: ['flow_1'] });
  assert.deepEqual(result.observation, { consistency: 'sequential', qualification: false });
});

test('unavailable inventories differ from reported empty inventories', () => {
  const raw = input();
  delete raw.flows;
  raw.models = { error: 'fictional upstream failure' };
  raw.servers = [];
  const result = projectWorkerInventory(raw);
  assert.deepEqual(result.collections, { flows: { available: false, truncated: false },
    models: { available: false, truncated: false }, servers: { available: true, truncated: false } });
  assert.deepEqual(result.flows, []);
  assert.equal(result.observation.qualification, false);
});

test('malformed or duplicate inventory identities do not become apparently empty qualified collections', () => {
  for (const invalid of [[null], [{ id: 'bad id', name: 'Invalid' }], [{ id: 'a', name: 'A' }, { id: 'a', name: 'Other' }]]) {
    const raw = input();
    raw.models = invalid;
    const result = projectWorkerInventory(raw);
    assert.deepEqual(result.collections.models, { available: false, truncated: false });
    assert.deepEqual(result.models, []);
    assert.equal('boundModel' in result.flows[0].nodes[1], false);
  }
});

test('unknown node kinds remain opaque and unmatched bindings are omitted', () => {
  const raw = input();
  raw.flows[0].nodes[1].data = { type: 'future-private-kind', properties: { boundModel: 'missing', boundServer: 'missing', subflowId: 'missing' } };
  const result = projectWorkerInventory(raw);
  assert.deepEqual(result.flows[0].nodes[1], { id: 'process_1', type: 'unknown', position: { x: 10, y: 20 } });
  assert.deepEqual(result.flows[0].topology, { available: true, truncated: false });
});

test('missing, malformed, duplicate and dangling graph data is explicitly unavailable', () => {
  for (const change of [flow => delete flow.nodes, flow => flow.nodes.push(node('start_1')),
    flow => flow.nodes[0].position.x = Infinity, flow => flow.edges[0].target = 'missing',
    flow => flow.edges[0].sourceHandle = 'https://private.invalid/path']) {
    const raw = input();
    change(raw.flows[0]);
    const flow = projectWorkerInventory(raw).flows[0];
    assert.equal(flow.id, 'flow_1');
    assert.deepEqual(flow.topology, { available: false, truncated: false });
    assert.deepEqual(flow.nodes, []);
    assert.deepEqual(flow.edges, []);
  }
});

test('collection and aggregate graph bounds retain a deterministic prefix and truthful truncation', () => {
  const raw = input();
  raw.models = Array.from({ length: INSPECTION_LIMITS.models + 1 }, (_, index) => ({ id: `model_${index}`, name: `Model ${index}` }));
  raw.flows = Array.from({ length: 10 }, (_, index) => ({ id: `flow_${index}`, name: `Flow ${index}`,
    nodes: Array.from({ length: 256 }, (_, offset) => node(`node_${offset}`)), edges: [] }));
  const result = projectWorkerInventory(raw);
  assert.equal(result.models.length, 200);
  assert.equal(result.models.at(-1).id, 'model_199');
  assert.deepEqual(result.collections.models, { available: true, truncated: true });
  assert.equal(result.flows.reduce((count, flow) => count + flow.nodes.length, 0), 2048);
  assert.deepEqual(result.flows[8].topology, { available: true, truncated: true });
  assert.equal(result.flows[8].nodes.length, 0);
  assert.equal(result.collections.flows.truncated, true);
});

test('node truncation cannot leave edges pointing at omitted nodes', () => {
  const raw = input();
  raw.flows[0].nodes = Array.from({ length: 257 }, (_, index) => node(`node_${index}`));
  raw.flows[0].edges = [{ source: 'node_0', target: 'node_256' }, { source: 'node_0', target: 'node_1' }];
  const flow = projectWorkerInventory(raw).flows[0];
  assert.equal(flow.nodes.length, 256);
  assert.deepEqual(flow.edges, [{ source: 'node_0', target: 'node_1' }]);
  assert.deepEqual(flow.topology, { available: true, truncated: true });
});

test('flow, server and edge caps are enforced across the complete observation', () => {
  const raw = input();
  raw.flows = Array.from({ length: 101 }, (_, index) => ({ id: `flow_${index}`, name: `Flow ${index}`, nodes: [], edges: [] }));
  raw.servers = Array.from({ length: 201 }, (_, index) => ({ name: `Server ${index}`, transport: 'websocket', disabled: false }));
  let result = projectWorkerInventory(raw);
  assert.equal(result.flows.length, 100);
  assert.equal(result.servers.length, 200);
  assert.equal(result.collections.flows.truncated, true);
  assert.equal(result.collections.servers.truncated, true);
  raw.flows = Array.from({ length: 9 }, (_, index) => ({ id: `flow_${index}`, name: `Flow ${index}`,
    nodes: [node('a'), node('b')], edges: Array.from({ length: 513 }, (_, offset) => ({ id: `edge_${offset}`, source: 'a', target: 'b' })) }));
  result = projectWorkerInventory(raw);
  assert.equal(result.flows[0].edges.length, 512);
  assert.equal(result.flows.reduce((count, flow) => count + flow.edges.length, 0), 4096);
  assert.equal(result.flows[8].edges.length, 0);
  assert.equal(result.flows[8].topology.truncated, true);
});

test('safe enum projection preserves absence and false without inventing provider readiness', () => {
  const raw = input();
  raw.models[0].provider = 'unrecognized-private-provider';
  raw.models[0].adapter = 'unrecognized-private-adapter';
  raw.models[0].supportsTools = false;
  raw.servers[0].transport = 'future-transport';
  raw.status.servers = [{ name: 'files', status: 'connected' }, { name: 'files', status: 'error' }];
  const result = projectWorkerInventory(raw);
  assert.deepEqual(result.models, [{ id: 'model_1', name: 'fictional-model', displayName: 'Work model', supportsTools: false }]);
  assert.deepEqual(result.servers, [{ name: 'files', disabled: false }]);
  assert.equal(result.collections.models.truncated, true);
  assert.equal(result.collections.servers.truncated, true);
});

test('identity, time and saved call scope are validated without reflecting invalid input', () => {
  for (const change of [raw => raw.status.workspace = 'other', raw => raw.status.archiveSha256 = 'wrong',
    raw => raw.record.image = 'https://private.invalid/image', raw => raw.record.flowIds = ['invalid id'],
    raw => raw.observedAt = '2026-02-30T12:00:00.000Z']) {
    const raw = input();
    change(raw);
    assert.throws(() => projectWorkerInventory(raw), /Invalid saved|does not match|canonical UTC/);
  }
  const raw = input();
  raw.record.profile = 'private-workspace';
  raw.record.defaultFlowIds = ['saved_not_observed'];
  const result = projectWorkerInventory(raw);
  assert.deepEqual(result.callSelection, { kind: 'defaults', recorded: true, flowIds: ['saved_not_observed'] });
  delete raw.status;
  assert.equal(projectWorkerInventory(raw).worker.state, 'unknown');
});

test('absent legacy call scope is unrecorded, while malformed legacy scope and absent private defaults refuse', () => {
  const raw = input();
  delete raw.record.flowIds;
  let result = projectWorkerInventory(raw);
  assert.deepEqual(result.callSelection, { kind: 'legacy-scope', recorded: false, flowIds: [] });
  assert.equal(result.flows.length, 2);
  assert.equal(result.observation.qualification, false);
  raw.record.flowIds = [];
  assert.deepEqual(projectWorkerInventory(raw).callSelection, { kind: 'legacy-scope', recorded: true, flowIds: [] });
  for (const invalid of [null, undefined, 'flow_1', ['invalid id'], ['flow_1', 'flow_1']]) {
    raw.record.flowIds = invalid;
    assert.throws(() => projectWorkerInventory(raw), /Invalid saved worker call selection/);
  }
  delete raw.record.flowIds;
  raw.record.profile = 'private-workspace';
  assert.throws(() => projectWorkerInventory(raw), /Invalid saved worker call selection/);
  raw.record.defaultFlowIds = [];
  result = projectWorkerInventory(raw);
  assert.deepEqual(result.callSelection, { kind: 'defaults', recorded: true, flowIds: [] });
});

test('control characters and oversized labels cannot enter output; unknown-field accessors are never invoked', () => {
  for (const invalid of ['bad\nname', 'bad\u202ename', 'x'.repeat(161), 'https://private.invalid/model']) {
    const raw = input();
    raw.models[0].name = invalid;
    assert.equal(projectWorkerInventory(raw).collections.models.available, false);
  }
  const raw = input();
  Object.defineProperty(raw.models[0], 'ApiKey', { get() { throw new Error('must not read secrets'); } });
  assert.equal(projectWorkerInventory(raw).models[0].id, 'model_1');
});
