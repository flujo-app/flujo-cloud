import { sha256 } from './envelope.mjs';
import { promises as fs } from 'node:fs';
import { encryptSnapshotResponse, spoolSnapshot, verifyEncryptedSnapshotFile } from './snapshot-file.mjs';

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

export async function captureSnapshot({ origin, workspace, token, flowIds, recipientKey, outputPath, fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 300_000, maxBytes = 256 * 1024 * 1024,
}) {
  origin = loopbackOrigin(origin);
  if (recipientKey !== undefined && (!Buffer.isBuffer(recipientKey) || recipientKey.length !== 32)) {
    throw new Error('Invalid snapshot recipient key.');
  }
  const selection = { ...(flowIds?.length ? { flowIds } : {}),
    ...(recipientKey ? { recipientKey: recipientKey.toString('base64') } : {}) };
  const hasSelection = Object.keys(selection).length > 0;
  const headers = { Authorization: `Bearer ${token}`, 'x-flujo-workspace': workspace };
  const request = (endpoint, method = 'GET', sessionId) => {
    const url = new URL(`/api/snapshot/${endpoint}`, origin);
    url.searchParams.set('workspace', workspace);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    return fetchImpl(url, {
      method,
      headers: endpoint === 'begin' && hasSelection ? { ...headers, 'Content-Type': 'application/json' } : headers,
      ...(endpoint === 'begin' && hasSelection ? { body: JSON.stringify(selection) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
  };
  let sessionId;
  let finalized = false;
  let spooled = false;
  let activeDownload;
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
    activeDownload = download;
    if (!download.ok) throw new Error(`Local snapshot download failed (HTTP ${download.status}).`);
    const expected = download.headers.get('x-flujo-snapshot-sha256');
    if (!/^[0-9a-f]{64}$/.test(expected ?? '') || expected !== status.sha256) throw new Error('Snapshot download lacks a matching integrity digest.');
    const encrypted = status.encrypted === true || ['1', 'true'].includes(download.headers.get('x-flujo-snapshot-encrypted'));
    const plaintextSha256 = download.headers.get('x-flujo-snapshot-plaintext-sha256') ?? status.plaintextSha256;
    if (encrypted && (!recipientKey || status.recipientKeyUsed !== true
      || download.headers.get('x-flujo-snapshot-recipient-key-used') !== 'true'
      || !/^[0-9a-f]{64}$/.test(plaintextSha256 ?? '')
      || (status.plaintextSha256 !== undefined && status.plaintextSha256 !== plaintextSha256))) {
      await download.body?.cancel();
      throw new Error('Encrypted snapshot lacks an acknowledged recipient key and plaintext digest.');
    }
    let artifact;
    if (outputPath) {
      if (!recipientKey) throw new Error('A private recipient key is required for snapshot spooling.');
      if (encrypted) {
        // maxBytes remains the plaintext limit, not its base64 wire expansion.
        artifact = await spoolSnapshot(download, outputPath, Math.ceil(maxBytes / 3) * 4 + 32768, expected);
        spooled = true;
        await verifyEncryptedSnapshotFile(outputPath, recipientKey, plaintextSha256, maxBytes, expected);
        delete artifact.prefix;
      } else {
        artifact = await encryptSnapshotResponse(download, outputPath, recipientKey, maxBytes, expected);
        spooled = true;
        await verifyEncryptedSnapshotFile(outputPath, recipientKey, expected, maxBytes, artifact.wireSha256);
      }
      artifact.encrypted = true;
      artifact.sourceEncrypted = encrypted;
      artifact.plaintextSha256 = encrypted ? plaintextSha256 : expected;
    } else {
      if (encrypted) {
        await download.body?.cancel();
        throw new Error('Encrypted snapshots require a private spool path.');
      }
      const bytes = await boundedBody(download, maxBytes);
      if (sha256(bytes) !== expected) throw new Error('Snapshot download failed SHA-256 verification.');
      if (bytes.subarray(0, 64).toString('ascii').trimStart().startsWith('{')) {
        bytes.fill(0);
        throw new Error('Encrypted snapshot requires explicit recipient-key acknowledgement.');
      }
      artifact = { bytes, sha256: expected, wireSha256: expected, plaintextSha256: expected, encrypted: false };
    }
    const finalize = await request('finalize', 'POST', sessionId);
    if (!finalize.ok) throw new Error(`Local snapshot finalize failed (HTTP ${finalize.status}).`);
    finalized = true;
    return artifact;
  } finally {
    if (!finalized) { try { await activeDownload?.body?.cancel(); } catch { /* Preserve primary failure. */ } }
    if (sessionId && !finalized) await request('abort', 'POST', sessionId).catch(() => undefined);
    if (spooled && !finalized) await fs.unlink(outputPath).catch(() => undefined);
  }
}
