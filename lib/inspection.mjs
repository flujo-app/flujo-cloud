/** A fixed projection of sequential GET observations, never runtime acceptance. */
export const INSPECTION_LIMITS = Object.freeze({
  flows: 100, models: 200, servers: 200, nodesPerFlow: 256, edgesPerFlow: 512,
  nodes: 2048, edges: 4096, idChars: 128, nameChars: 160, position: 1_000_000,
});

const NODE_TYPES = new Set(['start', 'process', 'finish', 'mcp', 'subflow', 'resource', 'signal', 'trigger', 'static']);
const PROVIDERS = new Set(['openai', 'azure', 'openrouter', 'requesty', 'anthropic', 'gemini', 'mistral', 'xai', 'ollama', 'litellm', 'claude-subscription', 'codex']);
const ADAPTERS = new Set(['openai', 'openai-responses', 'azure', 'gemini', 'anthropic', 'claude-cli', 'codex-cli']);
const TRANSPORTS = new Set(['stdio', 'sse', 'streamable', 'websocket']);
const STATES = new Set(['not-started', 'restoring', 'locked', 'installing', 'ready', 'error']);
const SERVER_STATES = new Set(['not-started', 'installing', 'connecting', 'connected', 'disconnected', 'disabled', 'ready', 'error', 'unknown']);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|[a-z][a-z0-9+.-]*:\/\//iu;
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length <= INSPECTION_LIMITS.idChars
  && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) && !UNSAFE_TEXT.test(value);
const name = value => typeof value === 'string' && value.length <= INSPECTION_LIMITS.nameChars
  && value.trim().length > 0 && value.isWellFormed() && !UNSAFE_TEXT.test(value);
const unavailable = () => ({ values: [], marker: { available: false, truncated: false } });

function collection(input, maximum, project, identity) {
  if (!Array.isArray(input)) return unavailable();
  const values = [];
  const seen = new Set();
  let truncated = input.length > maximum;
  for (let index = 0; index < Math.min(input.length, maximum); index += 1) {
    const raw = input[index];
    if (!object(raw)) return unavailable();
    const projected = project(raw);
    if (!projected || seen.has(projected.value[identity])) return unavailable();
    seen.add(projected.value[identity]);
    values.push(projected.value);
    truncated ||= projected.truncated === true;
  }
  return { values, marker: { available: true, truncated } };
}

function model(raw) {
  const modelId = own(raw, 'id');
  const modelName = own(raw, 'name');
  if (!id(modelId) || !name(modelName)) return null;
  const value = { id: modelId, name: modelName };
  let truncated = false;
  for (const [key, validate] of [['displayName', name], ['provider', value => PROVIDERS.has(value)],
    ['adapter', value => ADAPTERS.has(value)], ['supportsTools', value => typeof value === 'boolean']]) {
    const item = own(raw, key);
    if (item === undefined) continue;
    if (validate(item)) value[key] = item;
    else truncated = true;
  }
  return { value, truncated };
}

function server(raw) {
  const serverName = own(raw, 'name');
  if (!name(serverName)) return null;
  const value = { name: serverName };
  let truncated = false;
  for (const [key, validate] of [['transport', value => TRANSPORTS.has(value)],
    ['disabled', value => typeof value === 'boolean']]) {
    const item = own(raw, key);
    if (item === undefined) continue;
    if (validate(item)) value[key] = item;
    else truncated = true;
  }
  return { value, truncated };
}

function topology(raw, inventories, budget) {
  const rawNodes = own(raw, 'nodes');
  const rawEdges = own(raw, 'edges');
  const failed = () => ({ nodes: [], edges: [], topology: { available: false, truncated: false } });
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) return failed();
  const maximumNodes = Math.min(INSPECTION_LIMITS.nodesPerFlow, budget.nodes);
  const maximumEdges = Math.min(INSPECTION_LIMITS.edgesPerFlow, budget.edges);
  const truncatedNodes = rawNodes.length > maximumNodes;
  let truncated = truncatedNodes || rawEdges.length > maximumEdges;
  const nodes = [];
  const nodeIds = new Set();
  for (let index = 0; index < Math.min(rawNodes.length, maximumNodes); index += 1) {
    const item = rawNodes[index];
    if (!object(item)) return failed();
    const nodeId = own(item, 'id');
    if (!id(nodeId) || nodeIds.has(nodeId)) return failed();
    nodeIds.add(nodeId);
    const data = own(item, 'data');
    const kind = object(data) ? own(data, 'type') : undefined;
    const node = { id: nodeId, type: NODE_TYPES.has(kind) ? kind : 'unknown' };
    const position = own(item, 'position');
    if (position !== undefined) {
      if (!object(position)) return failed();
      const x = own(position, 'x');
      const y = own(position, 'y');
      if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= INSPECTION_LIMITS.position)) return failed();
      node.position = { x, y };
    }
    const properties = object(data) ? own(data, 'properties') : undefined;
    if (object(properties)) {
      for (const [field, known] of [['boundModel', inventories.models], ['boundServer', inventories.servers], ['subflowId', inventories.flows]]) {
        const binding = own(properties, field);
        if (typeof binding === 'string' && known.has(binding)) node[field] = binding;
      }
    }
    nodes.push(node);
  }
  const edges = [];
  const edgeIds = new Set();
  for (let index = 0; index < Math.min(rawEdges.length, maximumEdges); index += 1) {
    const item = rawEdges[index];
    if (!object(item)) return failed();
    const source = own(item, 'source');
    const target = own(item, 'target');
    if (!id(source) || !id(target)) return failed();
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      if (!truncatedNodes) return failed();
      truncated = true;
      continue;
    }
    const edge = { source, target };
    for (const key of ['id', 'sourceHandle', 'targetHandle']) {
      const value = own(item, key);
      if (value == null) continue;
      if (!id(value) || (key === 'id' && edgeIds.has(value))) return failed();
      edge[key] = value;
      if (key === 'id') edgeIds.add(value);
    }
    edges.push(edge);
  }
  budget.nodes -= nodes.length;
  budget.edges -= edges.length;
  return { nodes, edges, topology: { available: true, truncated } };
}

function workerIdentity(record, status) {
  if (!object(record)) throw new Error('Invalid saved worker observation identity.');
  const app = own(record, 'app');
  const machineId = own(record, 'machineId');
  const workspace = own(record, 'workspace');
  const image = own(record, 'image');
  const savedProfile = own(record, 'profile');
  if (!id(app) || !id(machineId) || typeof workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)
    || typeof image !== 'string' || image.length > 256
    || !/^[a-z0-9.-]+\/[A-Za-z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image)
    || (savedProfile !== undefined && savedProfile !== 'flow' && savedProfile !== 'private-workspace')) {
    throw new Error('Invalid saved worker observation identity.');
  }
  let state = 'unknown';
  if (status !== undefined) {
    if (!object(status) || own(status, 'mode') !== 'worker' || own(status, 'workspace') !== workspace || !STATES.has(own(status, 'state'))
      || (own(record, 'archiveSha256') !== undefined && own(status, 'archiveSha256') !== own(record, 'archiveSha256'))) {
      throw new Error('Worker observation does not match the saved identity.');
    }
    state = own(status, 'state');
  }
  return { app, machineId, workspace, image, profile: savedProfile ?? 'flow', state };
}

/** Inputs are already bounded GET results; unknown fields are never read or copied. */
export function projectWorkerInventory({ flows, models, servers, status, record, observedAt }) {
  if (typeof observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw new Error('Worker observation requires a canonical UTC timestamp.');
  }
  const worker = workerIdentity(record, status);
  const projectedModels = collection(models, INSPECTION_LIMITS.models, model, 'id');
  const projectedServers = collection(servers, INSPECTION_LIMITS.servers, server, 'name');
  const projectedFlows = collection(flows, INSPECTION_LIMITS.flows, raw => {
    const flowId = own(raw, 'id');
    const flowName = own(raw, 'name');
    return id(flowId) && name(flowName) ? { value: { id: flowId, name: flowName } } : null;
  }, 'id');
  const inventories = { models: new Set(projectedModels.values.map(item => item.id)),
    servers: new Set(projectedServers.values.map(item => item.name)), flows: new Set(projectedFlows.values.map(item => item.id)) };
  const budget = { nodes: INSPECTION_LIMITS.nodes, edges: INSPECTION_LIMITS.edges };
  for (let index = 0; index < projectedFlows.values.length; index += 1) {
    const graph = topology(flows[index], inventories, budget);
    const flow = projectedFlows.values[index];
    flow.nodes = graph.nodes;
    flow.edges = graph.edges;
    flow.topology = graph.topology;
    projectedFlows.marker.truncated ||= graph.topology.truncated;
  }
  const statuses = status && own(status, 'servers');
  if (Array.isArray(statuses) && statuses.length <= INSPECTION_LIMITS.servers) {
    const byName = new Map();
    const ambiguous = new Set();
    for (const item of statuses) {
      if (!object(item) || !name(own(item, 'name')) || !SERVER_STATES.has(own(item, 'status'))) continue;
      const serverName = own(item, 'name');
      if (byName.has(serverName)) ambiguous.add(serverName);
      byName.set(serverName, own(item, 'status'));
    }
    for (const item of projectedServers.values) {
      if (byName.has(item.name) && !ambiguous.has(item.name)) item.status = byName.get(item.name);
    }
  }
  const kind = worker.profile === 'private-workspace' ? 'defaults' : 'legacy-scope';
  const selectionKey = kind === 'defaults' ? 'defaultFlowIds' : 'flowIds';
  const recorded = Object.hasOwn(record, selectionKey);
  const savedSelection = kind === 'legacy-scope' && !recorded ? [] : own(record, selectionKey);
  if (!Array.isArray(savedSelection) || savedSelection.length > INSPECTION_LIMITS.flows
    || savedSelection.some(value => !id(value)) || new Set(savedSelection).size !== savedSelection.length) {
    throw new Error('Invalid saved worker call selection.');
  }
  return { format: 'flujo-worker-observation', version: 1, observedAt, worker,
    collections: { flows: projectedFlows.marker, models: projectedModels.marker, servers: projectedServers.marker },
    flows: projectedFlows.values, models: projectedModels.values, servers: projectedServers.values,
    callSelection: { kind, recorded, flowIds: savedSelection.slice() },
    observation: { consistency: 'sequential', qualification: false } };
}
