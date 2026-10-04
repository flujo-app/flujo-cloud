import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGatewayInventory, GRAPH_LIMITS } from './project-inventory.mjs';

const node = (id, type = 'process', properties = {}) => ({ id, data: { type, properties }, position: { x: 10, y: 20 } });
const input = () => ({
  status: { mode: 'worker', state: 'ready', workspace: 'fictional-workspace', servers: [{ name: 'files', status: 'connected' }] },
  flows: [{ id: 'flow_1', name: 'Review', nodes: [node('start_1', 'start'),
    node('process_1', 'process', { boundModel: 'model_1', boundServer: 'files', subflowId: 'flow_2' })],
    edges: [{ id: 'edge_1', source: 'start_1', target: 'process_1', sourceHandle: 'output', targetHandle: 'input' }] },
  { id: 'flow_2', name: 'Helper', nodes: [], edges: [] }],
  models: [{ id: 'model_1', name: 'fictional-model', displayName: 'Work model', provider: 'codex', adapter: 'codex-cli', supportsTools: true }],
  servers: [{ name: 'files', transport: 'stdio', disabled: false }] });

test('gateway projection returns only bounded metadata without identity, selection, authority or mutation', () => {
  const raw = input(), secret = 'FICTIONAL_SECRET_DO_NOT_COPY';
  raw.record = { app: secret, machineId: secret, image: secret, token: secret, flowIds: ['flow_1'] };
  raw.observedAt = secret;
  raw.status.error = secret;
  raw.status.servers[0].error = secret;
  raw.flows[0].description = secret;
  raw.flows[0].history = [{ prompt: secret }];
  raw.flows[0].nodes[1].data.label = secret;
  Object.assign(raw.flows[0].nodes[1].data.properties, { promptTemplate: secret, toolParameterPresets: { value: secret }, origins: [secret] });
  raw.flows[0].edges[0].data = { secret };
  Object.assign(raw.models[0], { ApiKey: secret, baseUrl: secret, promptTemplate: secret });
  Object.assign(raw.servers[0], { env: { KEY: secret }, args: [secret], headers: { Authorization: secret }, oauthClientSecret: secret, serverUrl: secret });
  const before = JSON.stringify(raw), result = projectGatewayInventory(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(Object.keys(result), ['collections', 'flows', 'models', 'servers']);
  assert.deepEqual(result.flows[0].nodes[1], { id: 'process_1', type: 'process', position: { x: 10, y: 20 },
    boundModel: 'model_1', boundServer: 'files', subflowId: 'flow_2', targetSemantics: 'configured-potential' });
  assert.deepEqual(result.servers, [{ name: 'files', transport: 'stdio', disabled: false, status: 'connected', statusSource: 'bootstrap-reported' }]);
});

test('unavailable inventories remain different from available empty inventories without worker context', () => {
  assert.deepEqual(projectGatewayInventory(), { collections: { flows: { available: false, truncated: false },
    models: { available: false, truncated: false }, servers: { available: false, truncated: false } }, flows: [], models: [], servers: [] });
  const raw = input();
  delete raw.flows;
  raw.models = { error: 'fictional failure' };
  raw.servers = [];
  const result = projectGatewayInventory(raw);
  assert.deepEqual(result.collections, { flows: { available: false, truncated: false },
    models: { available: false, truncated: false }, servers: { available: true, truncated: false } });
  assert.deepEqual(result.flows, []);
});

test('malformed and duplicate model identities suppress the collection and its graph bindings', () => {
  for (const invalid of [[null], [{ id: 'bad id', name: 'Invalid' }], [{ id: 'a', name: 'A' }, { id: 'a', name: 'Other' }]]) {
    const raw = input(); raw.models = invalid;
    const result = projectGatewayInventory(raw);
    assert.deepEqual(result.collections.models, { available: false, truncated: false });
    assert.deepEqual(result.models, []);
    assert.equal('boundModel' in result.flows[0].nodes[1], false);
  }
});

test('duplicate flow and server identities are unavailable instead of ambiguous binding targets', () => {
  const raw = input(); raw.flows.push(structuredClone(raw.flows[0])); raw.servers.push({ name: 'files' });
  const result = projectGatewayInventory(raw);
  assert.deepEqual(result.collections.flows, { available: false, truncated: false });
  assert.deepEqual(result.collections.servers, { available: false, truncated: false });
  assert.deepEqual(result.flows, []); assert.deepEqual(result.servers, []);
});

test('unknown node types remain opaque and unmatched bindings never escape into output', () => {
  const raw = input();
  raw.flows[0].nodes[1].data = { type: 'future-private-kind', properties: { boundModel: 'missing', boundServer: 'missing', subflowId: 'missing' } };
  const result = projectGatewayInventory(raw);
  assert.deepEqual(result.flows[0].nodes[1], { id: 'process_1', type: 'unknown', position: { x: 10, y: 20 } });
  assert.deepEqual(result.flows[0].topology, { available: true, truncated: false });
});

test('missing, malformed, duplicate and dangling graph records are explicitly unavailable', () => {
  for (const change of [flow => delete flow.nodes, flow => flow.nodes.push(node('start_1')),
    flow => flow.nodes[0].position.x = Infinity, flow => flow.nodes[0].position.y = GRAPH_LIMITS.position + 1,
    flow => flow.edges[0].target = 'missing', flow => flow.edges[0].sourceHandle = 'https://fictional.invalid/path',
    flow => flow.edges.push(structuredClone(flow.edges[0]))]) {
    const raw = input(); change(raw.flows[0]);
    const flow = projectGatewayInventory(raw).flows[0];
    assert.equal(flow.id, 'flow_1');
    assert.deepEqual(flow.topology, { available: false, truncated: false });
    assert.deepEqual(flow.nodes, []); assert.deepEqual(flow.edges, []);
  }
});

test('model and aggregate node caps keep a deterministic prefix with truthful truncation', () => {
  const raw = input();
  raw.models = Array.from({ length: GRAPH_LIMITS.models + 1 }, (_, index) => ({ id: `model_${index}`, name: `Model ${index}` }));
  raw.flows = Array.from({ length: 10 }, (_, index) => ({ id: `flow_${index}`, name: `Flow ${index}`,
    nodes: Array.from({ length: 256 }, (_, offset) => node(`node_${offset}`)), edges: [] }));
  const result = projectGatewayInventory(raw);
  assert.equal(result.models.length, 200); assert.equal(result.models.at(-1).id, 'model_199');
  assert.deepEqual(result.collections.models, { available: true, truncated: true });
  assert.equal(result.flows.reduce((count, flow) => count + flow.nodes.length, 0), 2048);
  assert.deepEqual(result.flows[8].topology, { available: true, truncated: true });
  assert.equal(result.flows[8].nodes.length, 0); assert.equal(result.collections.flows.truncated, true);
});

test('edges cannot reference nodes omitted by truncation', () => {
  const raw = input(); raw.flows[0].nodes = Array.from({ length: 257 }, (_, index) => node(`node_${index}`));
  raw.flows[0].edges = [{ source: 'node_0', target: 'node_256' }, { source: 'node_0', target: 'node_1' }];
  const flow = projectGatewayInventory(raw).flows[0];
  assert.equal(flow.nodes.length, 256); assert.deepEqual(flow.edges, [{ source: 'node_0', target: 'node_1' }]);
  assert.deepEqual(flow.topology, { available: true, truncated: true });
});

test('flow, server, per-flow edge and aggregate edge caps bound the complete result', () => {
  const raw = input();
  raw.flows = Array.from({ length: 101 }, (_, index) => ({ id: `flow_${index}`, name: `Flow ${index}`, nodes: [], edges: [] }));
  raw.servers = Array.from({ length: 201 }, (_, index) => ({ name: `Server ${index}`, transport: 'websocket', disabled: false }));
  let result = projectGatewayInventory(raw);
  assert.equal(result.flows.length, 100); assert.equal(result.servers.length, 200);
  assert.equal(result.collections.flows.truncated, true); assert.equal(result.collections.servers.truncated, true);
  raw.flows = Array.from({ length: 9 }, (_, index) => ({ id: `flow_${index}`, name: `Flow ${index}`,
    nodes: [node('a'), node('b')], edges: Array.from({ length: 513 }, (_, offset) => ({ id: `edge_${offset}`, source: 'a', target: 'b' })) }));
  result = projectGatewayInventory(raw);
  assert.equal(result.flows[0].edges.length, 512);
  assert.equal(result.flows.reduce((count, flow) => count + flow.edges.length, 0), 4096);
  assert.equal(result.flows[8].edges.length, 0); assert.equal(result.flows[8].topology.truncated, true);
});

test('allowlisted enums preserve false and absence without inventing readiness from ambiguous status', () => {
  const raw = input(); raw.models[0].provider = 'unrecognized-provider'; raw.models[0].adapter = 'unrecognized-adapter';
  raw.models[0].supportsTools = false; raw.servers[0].transport = 'future-transport';
  raw.status.servers = [{ name: 'files', status: 'connected' }, { name: 'files', status: 'error' }];
  const result = projectGatewayInventory(raw);
  assert.deepEqual(result.models, [{ id: 'model_1', name: 'fictional-model', displayName: 'Work model', supportsTools: false }]);
  assert.deepEqual(result.servers, [{ name: 'files', disabled: false }]);
  assert.equal(result.collections.models.truncated, true); assert.equal(result.collections.servers.truncated, true);
});

test('missing, malformed, unknown and oversized status lists cannot add a fabricated server status', () => {
  for (const status of [undefined, null, 'ready', [], { servers: 'connected' },
    { servers: [{ name: 'files', status: 'future-state', error: 'FICTIONAL_PRIVATE_ERROR' }] },
    { servers: Array.from({ length: 201 }, () => ({ name: 'files', status: 'connected' })) }]) {
    const raw = input(); raw.status = status;
    assert.deepEqual(projectGatewayInventory(raw).servers, [{ name: 'files', transport: 'stdio', disabled: false }]);
  }
});

test('unsafe text and identity bounds refuse collection entries or unavailable topology', () => {
  for (const invalid of ['bad\nname', 'bad\u202ename', 'bad\u2066name', 'x'.repeat(161), 'https://fictional.invalid/model', '\ud800']) {
    const raw = input(); raw.models[0].name = invalid;
    assert.equal(projectGatewayInventory(raw).collections.models.available, false);
  }
  for (const invalid of ['bad id', 'x'.repeat(129), 'https://fictional.invalid/node', 'bad\u202enode']) {
    const raw = input(); raw.flows[0].nodes[0].id = invalid;
    assert.deepEqual(projectGatewayInventory(raw).flows[0].topology, { available: false, truncated: false });
  }
});

test('unknown private accessors and required-field accessors are not evaluated', () => {
  const raw = input();
  Object.defineProperty(raw.models[0], 'ApiKey', { get() { throw new Error('must not read secrets'); } });
  Object.defineProperty(raw.servers[0], 'env', { get() { throw new Error('must not read environment'); } });
  Object.defineProperty(raw, 'record', { get() { throw new Error('must not read worker identity'); } });
  assert.equal(projectGatewayInventory(raw).models[0].id, 'model_1');
  Object.defineProperty(raw.models[0], 'name', { get() { throw new Error('must not invoke accessor'); } });
  assert.deepEqual(projectGatewayInventory(raw).collections.models, { available: false, truncated: false });
});

test('static parallel and singular targets remain potential configuration alongside opaque dynamic overrides', () => {
  const raw = input(), secret = 'FICTIONAL_DYNAMIC_EXPRESSION_OR_BRIEF';
  raw.flows[0].nodes[1].data = { type: 'subflow', properties: {
    subflowId: 'flow_1', parallelSubflowIds: ['flow_2'], parallelSubflowIdsVar: secret,
    allowCallerFanout: true, spawnBriefs: [secret], handoff: { parallelFlows: [secret] }, runVars: { secret } } };
  const result = projectGatewayInventory(raw), projected = result.flows[0].nodes[1];
  assert.deepEqual(projected, { id: 'process_1', type: 'subflow', position: { x: 10, y: 20 },
    subflowId: 'flow_1', parallelSubflowIds: ['flow_2'], dynamicTargetsConfigured: true,
    callerFanoutAllowed: true, spawnBriefsConfigured: true, targetSemantics: 'configured-potential' });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal('effectiveTarget' in projected, false);
});

test('empty parallel configuration keeps singular target and false flags without resolving runtime inputs', () => {
  const raw = input();
  Object.assign(raw.flows[0].nodes[1].data.properties, { parallelSubflowIds: [], parallelSubflowIdsVar: ' ',
    allowCallerFanout: false, spawnBriefs: [] });
  const projected = projectGatewayInventory(raw).flows[0].nodes[1];
  assert.equal(projected.subflowId, 'flow_2');
  assert.deepEqual(projected.parallelSubflowIds, []);
  assert.equal(projected.dynamicTargetsConfigured, false);
  assert.equal(projected.callerFanoutAllowed, false);
  assert.equal(projected.spawnBriefsConfigured, false);
  assert.equal(projected.targetSemantics, 'configured-potential');
});

test('parallel static targets are matched, deduplicated and capped with a truthful partial topology marker', () => {
  const raw = input();
  raw.flows.push(...Array.from({ length: 40 }, (_, index) => ({ id: `parallel_${index}`, name: `Parallel ${index}`, nodes: [], edges: [] })));
  raw.flows[0].nodes[1].data.properties.parallelSubflowIds = Array.from({ length: 40 }, (_, index) => `parallel_${index}`);
  let result = projectGatewayInventory(raw);
  assert.equal(result.flows[0].nodes[1].parallelSubflowIds.length, 32);
  assert.equal(result.flows[0].nodes[1].parallelSubflowIds.at(-1), 'parallel_31');
  assert.equal(result.flows[0].topology.truncated, true);
  assert.equal(result.collections.flows.truncated, true);
  raw.flows[0].nodes[1].data.properties.parallelSubflowIds = ['flow_2', 'missing', 'flow_2', 'https://fictional.invalid/target'];
  result = projectGatewayInventory(raw);
  assert.deepEqual(result.flows[0].nodes[1].parallelSubflowIds, ['flow_2']);
  assert.equal(result.flows[0].topology.truncated, true);
});

test('caller fanout requires exact true and malformed subflow metadata is omitted or marked partial', () => {
  const raw = input();
  Object.assign(raw.flows[0].nodes[1].data.properties, { parallelSubflowIds: 'FICTIONAL_PRIVATE_VALUE',
    parallelSubflowIdsVar: { private: true }, allowCallerFanout: 'true', spawnBriefs: 'FICTIONAL_PRIVATE_BRIEF' });
  const result = projectGatewayInventory(raw), projected = result.flows[0].nodes[1];
  assert.equal(projected.callerFanoutAllowed, false);
  assert.equal('parallelSubflowIds' in projected, false);
  assert.equal('dynamicTargetsConfigured' in projected, false);
  assert.equal('spawnBriefsConfigured' in projected, false);
  assert.equal(result.flows[0].topology.truncated, true);
  assert.equal(JSON.stringify(result).includes('FICTIONAL_PRIVATE'), false);
});

test('failed and connected server states carry bootstrap provenance rather than active health evidence', () => {
  const raw = input();
  for (const status of ['failed', 'connected']) {
    raw.status.servers = [{ name: 'files', status, error: 'FICTIONAL_PRIVATE_ERROR' }];
    assert.deepEqual(projectGatewayInventory(raw).servers,
      [{ name: 'files', transport: 'stdio', disabled: false, status, statusSource: 'bootstrap-reported' }]);
  }
});

test('preexisting node truncation does not suppress metadata projection for retained nodes', () => {
  const raw = input();
  raw.flows[0].nodes = Array.from({ length: 257 }, (_, index) => node(`node_${index}`, 'subflow',
    { parallelSubflowIds: ['flow_2'], parallelSubflowIdsVar: 'FICTIONAL_VARIABLE_NAME' }));
  raw.flows[0].edges = [];
  const result = projectGatewayInventory(raw);
  assert.equal(result.flows[0].topology.truncated, true);
  assert.deepEqual(result.flows[0].nodes[0].parallelSubflowIds, ['flow_2']);
  assert.equal(result.flows[0].nodes[0].dynamicTargetsConfigured, true);
  assert.equal(JSON.stringify(result).includes('FICTIONAL_VARIABLE_NAME'), false);
});
