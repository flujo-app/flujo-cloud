import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertPrivateDirectory, readPrivateJson } from './private-files.mjs';
import { boundedBody, controlToken, loopbackOrigin } from './snapshot.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const proofMessage = (nonce, instanceId, origin) => `flujo-local-instance:v1\n${nonce}\n${instanceId}\n${origin}`;

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function localInstanceDirectory(env = process.env) {
  return path.resolve(env.FLUJO_LOCAL_INSTANCE_DIR || path.join(os.homedir(), '.flujo', 'instances'));
}

function descriptorValid(record, filename) {
  if (!record || record.format !== 'flujo-local-instance' || record.version !== 1
    || !uuid.test(record.instanceId ?? '') || filename !== `${record.instanceId}.json`
    || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || typeof record.appRoot !== 'string' || !path.isAbsolute(record.appRoot)
    || typeof record.dataRoot !== 'string' || !path.isAbsolute(record.dataRoot)) return false;
  try {
    if (record.origin !== loopbackOrigin(record.origin) || !record.origin.startsWith('http://')) return false;
    controlToken(record.token, 'Local instance token');
    return true;
  } catch { return false; }
}

async function prove(record, { fetchImpl, timeoutMs }) {
  const nonce = randomBytes(32).toString('hex');
  const url = new URL('/api/cloud/instance', record.origin);
  url.searchParams.set('nonce', nonce);
  try {
    // Discovery never sends a bearer to a merely advertised port. The server
    // must first prove possession of the private descriptor's credential.
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = JSON.parse((await boundedBody(response, 8192)).toString('utf8'));
    if (body.format !== 'flujo-local-instance-proof' || body.version !== 1 || body.nonce !== nonce
      || body.instanceId !== record.instanceId || body.origin !== record.origin
      || typeof body.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.proof)) return false;
    const expected = createHmac('sha256', record.token).update(proofMessage(nonce, record.instanceId, record.origin)).digest();
    const actual = Buffer.from(body.proof, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

/** Read-only discovery. Callers must resolve ambiguity before selecting a source. */
export async function discoverSources({ source, workspace, env = process.env,
  directory = localInstanceDirectory(env), fetchImpl = fetch, timeoutMs = 10_000,
  readRecord = readPrivateJson, isProcessAlive = processIsAlive } = {}) {
  const selected = source === undefined ? undefined : loopbackOrigin(source);
  if (workspace !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) throw new Error('Invalid workspace name.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid discovery timeout.');
  try { await assertPrivateDirectory(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Local FLUJO instance directory is not private or available.'); }
  const names = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && uuid.test(entry.name.slice(0, -5)))
    .map((entry) => entry.name).sort();
  const candidates = new Array(names.length);
  let nextIndex = 0;
  const inspect = async (name, index) => {
    let record;
    try { record = await readRecord(path.join(directory, name)); } catch { return; }
    if (!descriptorValid(record, name) || (selected && record.origin !== selected) || !isProcessAlive(record.pid)) return;
    if (!(await prove(record, { fetchImpl, timeoutMs }))) return;
    const candidate = { source: record.origin, instanceId: record.instanceId, pid: record.pid,
      appRoot: record.appRoot, dataRoot: record.dataRoot };
    // The token is available to the controller, but absent from JSON/status
    // output and object spreads by default.
    Object.defineProperty(candidate, 'token', { value: record.token, enumerable: false });
    candidates[index] = candidate;
  };
  // Stale registrations from crashes must not disable discovery. Bound work in
  // flight, skip provably dead children, and still prove every surviving record.
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
    while (nextIndex < names.length) {
      const index = nextIndex++;
      await inspect(names[index], index);
    }
  }));
  return candidates.filter(Boolean);
}
