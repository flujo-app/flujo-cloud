/** Bounded metadata projection only: no worker identity, transport or authority. */
export const GRAPH_LIMITS = Object.freeze({
  flows: 100, models: 200, servers: 200, nodesPerFlow: 256, edgesPerFlow: 512,
  nodes: 2048, edges: 4096, idChars: 128, nameChars: 160, position: 1_000_000,
});

const NODE_TYPES = new Set(['start', 'process', 'finish', 'mcp', 'subflow', 'resource', 'signal', 'trigger', 'static']);
const PROVIDERS = new Set(['openai', 'azure', 'openrouter', 'requesty', 'anthropic', 'gemini', 'mistral', 'xai', 'ollama', 'litellm', 'claude-subscription', 'codex']);
const ADAPTERS = new Set(['openai', 'openai-responses', 'azure', 'gemini', 'anthropic', 'claude-cli', 'codex-cli']);
const TRANSPORTS = new Set(['stdio', 'sse', 'streamable', 'websocket']);
const SERVER_STATES = new Set(['not-started', 'installing', 'connecting', 'connected', 'disconnected', 'disabled', 'ready', 'error', 'failed', 'unknown']);
const MAX_PARALLEL_TARGETS = 32;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|[a-z][a-z0-9+.-]*:\/\//iu;
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length <= GRAPH_LIMITS.idChars
  && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) && !UNSAFE_TEXT.test(value);
const name = value => typeof value === 'string' && value.length <= GRAPH_LIMITS.nameChars
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

function subflowMetadata(properties, node, knownFlows) {
  let truncated = false;
  const singular = own(properties, 'subflowId');
  if (typeof singular === 'string' && knownFlows.has(singular)) node.subflowId = singular;
  const parallel = own(properties, 'parallelSubflowIds');
  if (parallel !== undefined) {
    if (Array.isArray(parallel)) {
      const targets = [], seen = new Set();
      truncated ||= parallel.length > MAX_PARALLEL_TARGETS;
      for (let index = 0; index < Math.min(parallel.length, MAX_PARALLEL_TARGETS); index += 1) {
        const target = parallel[index];
        if (typeof target !== 'string' || !knownFlows.has(target) || seen.has(target)) { truncated = true; continue; }
        seen.add(target); targets.push(target);
      }
      node.parallelSubflowIds = targets;
    } else truncated = true;
  }
  const variable = own(properties, 'parallelSubflowIdsVar');
  if (variable !== undefined) {
    if (typeof variable === 'string') node.dynamicTargetsConfigured = variable.trim().length > 0;
    else truncated = true;
  }
  const callerFanout = own(properties, 'allowCallerFanout');
  if (callerFanout !== undefined) {
    node.callerFanoutAllowed = callerFanout === true;
    truncated ||= typeof callerFanout !== 'boolean';
  }
  const briefs = own(properties, 'spawnBriefs');
  if (briefs !== undefined) {
    if (Array.isArray(briefs)) node.spawnBriefsConfigured = briefs.length > 0;
    else truncated = true;
  }
  if (['subflowId', 'parallelSubflowIds', 'dynamicTargetsConfigured', 'callerFanoutAllowed', 'spawnBriefsConfigured']
    .some(key => Object.hasOwn(node, key))) node.targetSemantics = 'configured-potential';
  // Dynamic variables, caller handoffs and briefs may override these static targets.
  // Presence flags reveal no expressions/briefs and never assert an effective spawn.
  return truncated;
}

function topology(raw, inventories, budget) {
  const rawNodes = own(raw, 'nodes');
  const rawEdges = own(raw, 'edges');
  const failed = () => ({ nodes: [], edges: [], topology: { available: false, truncated: false } });
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) return failed();
  const maximumNodes = Math.min(GRAPH_LIMITS.nodesPerFlow, budget.nodes);
  const maximumEdges = Math.min(GRAPH_LIMITS.edgesPerFlow, budget.edges);
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
      if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= GRAPH_LIMITS.position)) return failed();
      node.position = { x, y };
    }
    const properties = object(data) ? own(data, 'properties') : undefined;
    if (object(properties)) {
      for (const [field, known] of [['boundModel', inventories.models], ['boundServer', inventories.servers]]) {
        const binding = own(properties, field);
        if (typeof binding === 'string' && known.has(binding)) node[field] = binding;
      }
      const partialTargets = subflowMetadata(properties, node, inventories.flows);
      truncated ||= partialTargets;
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

/** Inputs are already bounded GET results; unknown fields are never read or copied. */
export function projectGatewayInventory({ flows, models, servers, status } = {}) {
  const projectedModels = collection(models, GRAPH_LIMITS.models, model, 'id');
  const projectedServers = collection(servers, GRAPH_LIMITS.servers, server, 'name');
  const projectedFlows = collection(flows, GRAPH_LIMITS.flows, raw => {
    const flowId = own(raw, 'id');
    const flowName = own(raw, 'name');
    return id(flowId) && name(flowName) ? { value: { id: flowId, name: flowName } } : null;
  }, 'id');
  const inventories = { models: new Set(projectedModels.values.map(item => item.id)),
    servers: new Set(projectedServers.values.map(item => item.name)), flows: new Set(projectedFlows.values.map(item => item.id)) };
  const budget = { nodes: GRAPH_LIMITS.nodes, edges: GRAPH_LIMITS.edges };
  for (let index = 0; index < projectedFlows.values.length; index += 1) {
    const graph = topology(flows[index], inventories, budget);
    const flow = projectedFlows.values[index];
    flow.nodes = graph.nodes;
    flow.edges = graph.edges;
    flow.topology = graph.topology;
    projectedFlows.marker.truncated ||= graph.topology.truncated;
  }
  const statuses = object(status) ? own(status, 'servers') : undefined;
  if (Array.isArray(statuses) && statuses.length <= GRAPH_LIMITS.servers) {
    const byName = new Map();
    const ambiguous = new Set();
    for (const item of statuses) {
      if (!object(item) || !name(own(item, 'name')) || !SERVER_STATES.has(own(item, 'status'))) continue;
      const serverName = own(item, 'name');
      if (byName.has(serverName)) ambiguous.add(serverName);
      byName.set(serverName, own(item, 'status'));
    }
    for (const item of projectedServers.values) {
      if (byName.has(item.name) && !ambiguous.has(item.name)) {
        item.status = byName.get(item.name);
        item.statusSource = 'bootstrap-reported';
      }
    }
  }
  return { collections: { flows: projectedFlows.marker, models: projectedModels.marker, servers: projectedServers.marker },
    flows: projectedFlows.values, models: projectedModels.values, servers: projectedServers.values };
}
