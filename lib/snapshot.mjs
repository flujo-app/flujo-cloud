import { sha256 } from './envelope.mjs';

export function loopbackOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Source must be a loopback HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Source must be a loopback HTTP(S) origin without credentials, paths, or query parameters.');
  }
  return url.origin;
}

export function controlToken(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/=-]{32,}$/.test(value)) {
    throw new Error(`${name} must be a token of at least 32 ASCII letters, digits, or base64/url-safe characters.`);
  }
  return value;
}

export async function boundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Snapshot exceeds the bridge size limit.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Snapshot exceeds the bridge size limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function captureSnapshot({ origin, workspace, token, flowIds, fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 300_000, maxBytes = 256 * 1024 * 1024,
}) {
  origin = loopbackOrigin(origin);
  const headers = { Authorization: `Bearer ${token}`, 'x-flujo-workspace': workspace };
  const request = (endpoint, method = 'GET', sessionId) => {
    const url = new URL(`/api/snapshot/${endpoint}`, origin);
    url.searchParams.set('workspace', workspace);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    return fetchImpl(url, {
      method,
      headers: endpoint === 'begin' && flowIds?.length ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(endpoint === 'begin' && flowIds?.length ? { body: JSON.stringify({ flowIds }) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
  };
  let sessionId;
  let finalized = false;
  try {
    const response = await request('begin', 'POST');
    if (response.status !== 202) throw new Error(`Local snapshot begin failed (HTTP ${response.status}).`);
    const initial = await response.json();
    sessionId = initial.sessionId;
    if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Snapshot server returned an invalid session ID.');
    const deadline = Date.now() + timeoutMs;
    let status;
    while (Date.now() < deadline) {
      const statusResponse = await request('status', 'GET', sessionId);
      if (!statusResponse.ok) throw new Error(`Local snapshot status failed (HTTP ${statusResponse.status}).`);
      status = await statusResponse.json();
      if (status.workspace !== workspace || status.sessionId !== sessionId) throw new Error('Snapshot identity does not match the requested workspace.');
      if (status.state === 'ready') break;
      if (['failed', 'aborted', 'finalized'].includes(status.state)) throw new Error('Local snapshot did not complete. Inspect its status in FLUJO.');
      await sleep(500);
    }
    if (status?.state !== 'ready') throw new Error('Local snapshot timed out.');
    const download = await request('download', 'GET', sessionId);
    if (!download.ok) throw new Error(`Local snapshot download failed (HTTP ${download.status}).`);
    const expected = download.headers.get('x-flujo-snapshot-sha256');
    if (!/^[0-9a-f]{64}$/.test(expected ?? '') || expected !== status.sha256) throw new Error('Snapshot download lacks a matching integrity digest.');
    const bytes = await boundedBody(download, maxBytes);
    if (sha256(bytes) !== expected) throw new Error('Snapshot download failed SHA-256 verification.');
    const finalize = await request('finalize', 'POST', sessionId);
    if (!finalize.ok) throw new Error(`Local snapshot finalize failed (HTTP ${finalize.status}).`);
    finalized = true;
    return { bytes, sha256: expected };
  } finally {
    if (sessionId && !finalized) await request('abort', 'POST', sessionId).catch(() => undefined);
  }
}
