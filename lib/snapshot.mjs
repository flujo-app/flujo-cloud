import { sha256 } from './envelope.mjs';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { encryptSnapshotResponse, spoolSnapshot, verifyEncryptedSnapshotFile } from './snapshot-file.mjs';
import { assertTransferContract, encryptedSizeLimit, transferArchiveLimit } from './transfer.mjs';

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
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Snapshot exceeds the bridge size limit.');
  }
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

async function terminalAcknowledgement(response, { workspace, sessionId, state, encryptionVersion }) {
  let result;
  try { result = JSON.parse((await boundedBody(response, 64 * 1024)).toString('utf8')); }
  catch { throw new Error('Snapshot terminal acknowledgement was invalid or oversized.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.workspace !== workspace || result.sessionId !== sessionId || result.state !== state
    || (encryptionVersion !== undefined && result.encryptionVersion !== encryptionVersion)) {
    throw new Error(`Snapshot ${state === 'finalized' ? 'finalize' : 'abort'} returned no matching terminal session.`);
  }
}

export async function captureSnapshot({ origin, workspace, token, flowIds, recipientKey: suppliedKey, outputPath, scope = 'selected-flows', fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 300_000, maxBytes = 256 * 1024 * 1024,
  onCleanupUncertain,
  transfer,
  onRecipientKey,
}) {
  if (onCleanupUncertain !== undefined && typeof onCleanupUncertain !== 'function') {
    throw new Error('Snapshot cleanup observation must be an internal callback.');
  }
  if (!['selected-flows', 'workspace'].includes(scope)
    || (scope === 'workspace' && flowIds !== undefined)) {
    throw new Error('Full-workspace capture must omit flowIds; unknown or mixed capture scope is refused.');
  }
  origin = loopbackOrigin(origin);
  if (transfer !== undefined) assertTransferContract(transfer);
  if (transfer && (typeof workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)
    || typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{32,}$/.test(token))) {
    throw new Error('Encrypted snapshot requires primitive assigned workspace and control credential.');
  }
  if (transfer && typeof onRecipientKey !== 'function') {
    throw new Error('Encrypted transfer requires a trusted private key-retention callback before begin.');
  }
  if (transfer && (typeof outputPath !== 'string' || outputPath.length === 0)) {
    throw new Error('Encrypted transfer requires a private spool path before capture.');
  }
  const archiveLimit = transfer === undefined ? maxBytes : transferArchiveLimit(transfer, maxBytes);
  const wireLimit = transfer === undefined ? maxBytes : encryptedSizeLimit(archiveLimit);
  // This key is created before begin and never comes from the source response.
  // Its buffer transfers to the bridge only after successful logical finalize.
  if (suppliedKey !== undefined && (!Buffer.isBuffer(suppliedKey) || suppliedKey.length !== 32)) throw new Error('Invalid snapshot recipient key.');
  const recipientKey = suppliedKey ?? (transfer === undefined ? undefined : randomBytes(32));
  const selection = { ...(flowIds?.length ? { flowIds } : {}),
    ...(recipientKey ? { recipientKey: recipientKey.toString('base64') } : {}) };
  const hasSelection = Object.keys(selection).length > 0;
  const headers = { Authorization: `Bearer ${token}`, 'x-flujo-workspace': workspace };
  const request = async (endpoint, method = 'GET', sessionId) => {
    const url = new URL(`/api/snapshot/${endpoint}`, origin);
    url.searchParams.set('workspace', workspace);
    if (sessionId) url.searchParams.set('sessionId', sessionId);
    try {
      return await fetchImpl(url, {
        method,
        headers: endpoint === 'begin' && hasSelection ? { ...headers, 'Content-Type': 'application/json' } : headers,
        ...(endpoint === 'begin' && hasSelection ? { body: JSON.stringify(selection) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (transfer) throw new Error('Encrypted snapshot request failed. Transport details are withheld.');
      throw error;
    }
  };
  let sessionId;
  let beginEntered = false;
  let finalized = false;
  let captureError;
  let spooled = false, activeDownload;
  const sessionJson = async response => {
    if (!transfer) return response.json();
    try {
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 64 * 1024)));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch { throw new Error('Encrypted snapshot session response was invalid or oversized.'); }
  };
  try {
    if (recipientKey && transfer && onRecipientKey) {
      const retained = Buffer.from(recipientKey);
      try { await onRecipientKey(retained); }
      finally { retained.fill(0); }
    }
    beginEntered = true;
    const response = await request('begin', 'POST');
    if (response.status !== 202) throw new Error(`Local snapshot begin failed (HTTP ${response.status}).`);
    const initial = await sessionJson(response);
    const candidate = initial.sessionId;
    const validSession = transfer ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i : /^[0-9a-f-]{36}$/i;
    if (typeof candidate !== 'string' || !validSession.test(candidate)) throw new Error('Snapshot server returned an invalid session ID.');
    sessionId = candidate;
    if (transfer && (initial.workspace !== workspace || initial.encryptionVersion !== 2)) {
      throw new Error('Encrypted snapshot begin does not match the requested workspace and version.');
    }
    const deadline = Date.now() + timeoutMs;
    let status;
    while (Date.now() < deadline) {
      const statusResponse = await request('status', 'GET', sessionId);
      if (!statusResponse.ok) throw new Error(`Local snapshot status failed (HTTP ${statusResponse.status}).`);
      status = await sessionJson(statusResponse);
      if (status.workspace !== workspace || status.sessionId !== sessionId) throw new Error('Snapshot identity does not match the requested workspace.');
      if (transfer && (status.encryptionVersion !== 2
        || !['beginning', 'staging', 'ready', 'failed', 'aborted', 'finalized'].includes(status.state))) {
        throw new Error('Encrypted snapshot status has an unsupported version or state.');
      }
      if (status.state === 'ready') break;
      if (['failed', 'aborted', 'finalized'].includes(status.state)) throw new Error('Local snapshot did not complete. Inspect its status in FLUJO.');
      await sleep(500);
    }
    if (status?.state !== 'ready') throw new Error('Local snapshot timed out.');
    if (transfer && (!Number.isSafeInteger(status.archiveBytes) || status.archiveBytes < 1 || status.archiveBytes > wireLimit)) {
      throw new Error('Encrypted snapshot ready size exceeds the negotiated transfer limit.');
    }
    const download = await request('download', 'GET', sessionId);
    activeDownload = download;
    if (!download.ok) throw new Error(`Local snapshot download failed (HTTP ${download.status}).`);
    const expected = download.headers.get('x-flujo-snapshot-sha256');
    if (!/^[0-9a-f]{64}$/.test(expected ?? '') || expected !== status.sha256) throw new Error('Snapshot download lacks a matching integrity digest.');
    if (transfer && (download.headers.get('content-type') !== 'application/vnd.flujo.workspace-snapshot+json'
      || download.headers.get('content-length') !== String(status.archiveBytes))) {
      await download.body?.cancel().catch(() => undefined);
      throw new Error('Encrypted snapshot download does not match its negotiated type and size.');
    }
    let artifact;
    if (outputPath) {
      if (!recipientKey) throw new Error('A private recipient key is required for snapshot spooling.');
      const encrypted = !!transfer || status.encrypted === true || ['1', 'true'].includes(download.headers.get('x-flujo-snapshot-encrypted'));
      const plaintextSha256 = download.headers.get('x-flujo-snapshot-plaintext-sha256') ?? status.plaintextSha256;
      if (encrypted && !transfer && (status.recipientKeyUsed !== true
        || download.headers.get('x-flujo-snapshot-recipient-key-used') !== 'true'
        || !/^[0-9a-f]{64}$/.test(plaintextSha256 ?? '')
        || (status.plaintextSha256 !== undefined && status.plaintextSha256 !== plaintextSha256))) {
        throw new Error('Encrypted snapshot lacks an acknowledged recipient key and plaintext digest.');
      }
      if (encrypted) {
        artifact = await spoolSnapshot(download, outputPath, transfer ? wireLimit : Math.ceil(archiveLimit / 3) * 4 + 32768, expected);
        spooled = true;
        if (transfer && artifact.size !== status.archiveBytes) throw new Error('Encrypted snapshot wire size does not match its ready session.');
        await verifyEncryptedSnapshotFile(outputPath, recipientKey, transfer ? undefined : plaintextSha256, archiveLimit, expected,
          { version: transfer ? 2 : 1 });
        delete artifact.prefix;
      } else {
        artifact = await encryptSnapshotResponse(download, outputPath, recipientKey, archiveLimit, expected);
        spooled = true;
        await verifyEncryptedSnapshotFile(outputPath, recipientKey, expected, archiveLimit, artifact.wireSha256);
      }
      Object.assign(artifact, { encrypted: true, sourceEncrypted: encrypted,
        plaintextSha256: encrypted ? plaintextSha256 : expected,
        ...(transfer ? { encryptionVersion: 2 } : {}) });
    } else {
      const bytes = await boundedBody(download, wireLimit);
      if (sha256(bytes) !== expected) throw new Error('Snapshot download failed SHA-256 verification.');
      if (bytes.subarray(0, 64).toString('ascii').trimStart().startsWith('{')) {
        bytes.fill(0); throw new Error('Encrypted snapshots require a private spool path.');
      }
      artifact = { bytes, sha256: expected, ...(transfer ? { key: recipientKey, encryptionVersion: 2 } : {}) };
    }
    const finalize = await request('finalize', 'POST', sessionId);
    if (!finalize.ok) throw new Error(`Local snapshot finalize failed (HTTP ${finalize.status}).`);
    if (onCleanupUncertain || transfer) {
      await terminalAcknowledgement(finalize, { workspace, sessionId, state: 'finalized',
        ...(transfer ? { encryptionVersion: 2 } : {}) });
    }
    finalized = true;
    return artifact;
  } catch (error) {
    captureError = error;
    throw error;
  } finally {
    if (!finalized) { try { await activeDownload?.body?.cancel(); } catch {} }
    if (spooled && !finalized) await fs.unlink(outputPath).catch(() => undefined);
    if (!finalized) recipientKey?.fill(0);
    let cleanupError;
    if (!finalized && sessionId) {
      try {
        const aborted = await request('abort', 'POST', sessionId);
        if (onCleanupUncertain || transfer) {
          if (!aborted.ok) throw new Error(`Snapshot abort was not confirmed (HTTP ${aborted.status}).`);
          await terminalAcknowledgement(aborted, { workspace, sessionId, state: 'aborted',
            ...(transfer ? { encryptionVersion: 2 } : {}) });
        }
      } catch (error) {
        // Preserve the original capture error. Clone's outer source fence
        // records this separate cleanup uncertainty and retains both locks.
        cleanupError = Object.assign(new Error('Source snapshot abort cleanup is unconfirmed.', { cause: error }),
          { code: 'SNAPSHOT_CLEANUP_UNKNOWN' });
      }
    } else if (!finalized && beginEntered && (onCleanupUncertain || transfer)) {
      cleanupError = Object.assign(new Error('Source snapshot begin entered without a confirmed session identity.'),
        { code: 'SNAPSHOT_CLEANUP_UNKNOWN' });
    }
    if (cleanupError) {
      onCleanupUncertain?.(cleanupError);
      // V2 target admission needs the explicit unknown code even when clone
      // separately records the source hold; retain the primary cause too.
      if (transfer) {
        throw Object.assign(new Error('Encrypted source snapshot cleanup is unconfirmed; reconcile the original session.',
          { cause: captureError ?? cleanupError }), { code: 'SNAPSHOT_CLEANUP_UNKNOWN', cleanupCause: cleanupError });
      }
    }
  }
}
