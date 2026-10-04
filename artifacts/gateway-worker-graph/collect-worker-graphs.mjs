import { performance } from 'node:perf_hooks';
import { projectGatewayInventory } from './project-inventory.mjs';

const STATES = new Set(['not-started', 'restoring', 'locked', 'installing', 'ready', 'error']);
const ROUTES = Object.freeze([
  ['flows', '/api/flow', 8 * 1024 * 1024],
  ['models', '/api/model', 2 * 1024 * 1024],
  ['servers', '/api/mcp/servers', 2 * 1024 * 1024],
]);
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const empty = () => projectGatewayInventory({});

class ObservationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function configuredWorker(value, id, role) {
  if (!object(value)) throw new Error('Invalid configured worker.');
  const rawOrigin = own(value, 'origin'), token = own(value, 'token'), workspace = own(value, 'workspace');
  let url;
  try { url = new URL(rawOrigin); } catch { throw new Error('Invalid configured worker.'); }
  if (typeof rawOrigin !== 'string' || rawOrigin.length > 512 || url.protocol !== 'https:'
    || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || ![url.origin, url.origin + '/'].includes(rawOrigin)
    || typeof token !== 'string' || token.length < 32 || token.length > 4096
    || /[\u0000-\u0020\u007f-\u009f]/u.test(token)
    || typeof workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)
    || workspace.includes(token) || url.origin.includes(token)) {
    throw new Error('Invalid configured worker.');
  }
  return { id, roles: [role], origin: url.origin, token, workspace };
}

function configuration(config) {
  if (!object(config)) throw new Error('Invalid worker graph configuration.');
  const workers = own(config, 'workers');
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > 2) {
    throw new Error('Invalid worker graph configuration.');
  }
  const selected = workers.map((worker, index) => configuredWorker(worker, `worker-${index + 1}`, index === 0 ? 'developer' : 'reviewer'));
  const codeWorker = own(config, 'codeWorker');
  if (codeWorker !== undefined) selected.push(configuredWorker(codeWorker, 'code-worker', 'code-developer'));
  const tokens = selected.map(worker => worker.token);
  if (selected.some(worker => tokens.some(token => worker.workspace.includes(token) || worker.origin.includes(token)))) {
    throw new Error('Invalid worker graph configuration.');
  }
  const unique = [];
  for (const worker of selected) {
    const previous = unique.find(item => item.origin === worker.origin && item.workspace === worker.workspace && item.token === worker.token);
    if (previous) previous.roles.push(...worker.roles);
    else unique.push(worker);
  }
  return unique;
}

function discard(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}

async function readJson(response, maximum, signal) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && /^\d+$/.test(length) && Number(length) > maximum) {
    discard(response.body); throw new ObservationError('BODY_LIMIT');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new ObservationError('INVALID_RESPONSE');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const aborted = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new ObservationError('TIMEOUT');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new ObservationError('TIMEOUT');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ObservationError('INVALID_RESPONSE');
      size += value.byteLength;
      if (size > maximum) throw new ObservationError('BODY_LIMIT');
      chunks.push(value);
    }
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw new ObservationError('INVALID_RESPONSE'); }
    return result;
  } finally {
    signal.removeEventListener('abort', aborted);
    aborted();
    try { reader.releaseLock(); } catch {}
  }
}

async function getJson(worker, route, maximum, fetchImpl, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new ObservationError('TIMEOUT');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ObservationError('TIMEOUT')); }, Math.ceil(remaining));
  });
  const request = (async () => {
    let response;
    try {
      const url = new URL(route, worker.origin);
      url.searchParams.set('workspace', worker.workspace);
      response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + worker.token, 'x-flujo-workspace': worker.workspace,
          Origin: worker.origin, Accept: 'application/json' } });
      if (controller.signal.aborted) { discard(response?.body); throw new ObservationError('TIMEOUT'); }
      if (!response || !Number.isInteger(response.status)) throw new ObservationError('INVALID_RESPONSE');
      if (response.status === 401 || response.status === 403) {
        discard(response.body); throw new ObservationError('AUTHENTICATION_REFUSED');
      }
      if (response.status < 200 || response.status >= 300) {
        discard(response.body); throw new ObservationError('HTTP_UNAVAILABLE');
      }
      return await readJson(response, maximum, controller.signal);
    } catch (error) {
      if (error instanceof ObservationError) throw error;
      throw new ObservationError(controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_UNAVAILABLE');
    }
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}

function errorCode(error) { return error instanceof ObservationError ? error.code : 'INVALID_RESPONSE'; }
const canonicalTime = () => new Date().toISOString();

/**
 * Collect sequential metadata from the gateway's trusted, server-side worker configuration.
 * The caller supplies its existing workers/codeWorker object; no credentials are returned.
 * No Fly ownership, Machine pinning, clone/lifecycle or provider qualification is performed.
 * This module performs only four fixed GET routes per ready worker, with no retries.
 */
export async function collectGatewayWorkerGraphs(config, { fetchImpl = globalThis.fetch,
  timeoutMs = 10_000, includeUiLinks = false } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000
    || typeof includeUiLinks !== 'boolean') throw new Error('Invalid graph observation options.');
  const selected = configuration(config), tokens = selected.map(worker => worker.token);
  const report = { format: 'flujo-gateway-worker-graphs', version: 1, observedAt: canonicalTime(),
    source: { kind: fetchImpl === globalThis.fetch ? 'configured-worker-http' : 'injected-http', sample: false,
      ownershipVerified: false, machineRouting: 'configured-app-origin' },
    observation: { consistency: 'sequential', qualification: false }, workers: [] };
  const deadline = performance.now() + timeoutMs;
  for (const worker of selected) {
    const observation = { id: worker.id, roles: worker.roles.slice(), workspace: worker.workspace,
      observedAt: canonicalTime(), status: { available: false, state: 'unknown' }, ...empty() };
    if (includeUiLinks) observation.links = [{ kind: 'flujo-ui', href: worker.origin + '/' }];
    let status;
    try {
      status = await getJson(worker, '/api/worker/status', 128 * 1024, fetchImpl, deadline);
      if (!object(status) || own(status, 'mode') !== 'worker' || !STATES.has(own(status, 'state'))) {
        throw new ObservationError('INVALID_STATUS');
      }
      if (own(status, 'workspace') !== worker.workspace) throw new ObservationError('WORKSPACE_MISMATCH');
      observation.status = { available: true, state: own(status, 'state') };
      if (own(status, 'state') !== 'ready') throw new ObservationError('WORKER_NOT_READY');
    } catch (error) {
      observation.status.code = errorCode(error);
      report.workers.push(observation); continue;
    }
    const raw = { status }, errors = {};
    let stopped;
    for (const [key, route, maximum] of ROUTES) {
      if (stopped) { errors[key] = stopped; continue; }
      try { raw[key] = await getJson(worker, route, maximum, fetchImpl, deadline); }
      catch (error) {
        errors[key] = errorCode(error);
        if (errors[key] === 'AUTHENTICATION_REFUSED' || errors[key] === 'TIMEOUT') stopped = errors[key];
      }
    }
    Object.assign(observation, projectGatewayInventory(raw));
    for (const [key] of ROUTES) {
      if (!observation.collections[key].available && !errors[key]) errors[key] = 'INVALID_INVENTORY';
    }
    const serialized = JSON.stringify(observation);
    if (tokens.some(token => serialized.includes(token))) {
      Object.assign(observation, empty());
      observation.status = { available: false, state: 'unknown', code: 'KNOWN_SECRET_REFUSED' };
    } else if (Object.keys(errors).length) observation.errors = errors;
    report.workers.push(observation);
  }
  return report;
}
