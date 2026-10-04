import { createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertPrivateDirectory, ensurePrivateDirectory, writePrivateJson } from './private-files.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const CAPABILITY = Object.freeze({
  format: 'flujo-workspace-encrypted', cipher: 'aes-256-gcm', writeVersion: 2,
  readVersions: Object.freeze([1, 2]), legacyPlaintextRead: true,
  recipientKeyRequired: true, recipientKeyBytes: 32, recipientKeyEncoding: 'base64',
  v2Aad: 'flujo:workspace-snapshot:v2', v2Digest: 'sha256-encrypted-wire', v1Digest: 'sha256-plaintext-zip',
});
const LIMIT_KEYS = ['maxFileBytes', 'maxUncompressedBytes', 'maxManifestBytes', 'maxArchiveBytes', 'maxEncryptedBytes', 'maxMembers'];
const DEFAULT_TARGET_LIMITS = Object.freeze({ maxFileBytes: 268435456, maxUncompressedBytes: 1073741824,
  maxManifestBytes: 8388608, maxArchiveBytes: 1082130432, maxEncryptedBytes: 1442844672, maxMembers: 65534 });
const LIMIT_OVERRIDES = new Set(['FLUJO_SNAPSHOT_MAX_FILE_BYTES', 'FLUJO_SNAPSHOT_MAX_BYTES']);
const failure = () => new Error('Encrypted snapshot transfer contract is invalid or unsupported.');

export function encryptedSizeLimit(maxArchiveBytes) {
  const result = 4 * Math.ceil(maxArchiveBytes / 3) + 4096;
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || !Number.isSafeInteger(result)) throw failure();
  return result;
}

/** Absence preserves the old client-envelope path. A present but unsupported contract never downgrades. */
export function snapshotTransferContract(compatibility) {
  if (!record(compatibility)) throw failure();
  if (!Object.hasOwn(compatibility, 'snapshotEncryption')) {
    if (Object.hasOwn(compatibility, 'snapshotLimits')) throw failure();
    return undefined;
  }
  const capability = compatibility.snapshotEncryption;
  if (!record(capability) || Object.keys(capability).length !== Object.keys(CAPABILITY).length
    || Object.entries(CAPABILITY).some(([key, value]) => !Object.hasOwn(capability, key)
      || (Array.isArray(value) ? !Array.isArray(capability[key]) || capability[key].length !== 2
        || capability[key].some((item, index) => item !== value[index]) : capability[key] !== value))) throw failure();
  const limits = compatibility.snapshotLimits;
  if (!record(limits) || Object.keys(limits).length !== LIMIT_KEYS.length
    || LIMIT_KEYS.some(key => !Object.hasOwn(limits, key) || !Number.isSafeInteger(limits[key]) || limits[key] < 1)
    || limits.maxManifestBytes !== 8 * 1024 * 1024 || limits.maxMembers !== 65_534
    || limits.maxArchiveBytes !== limits.maxUncompressedBytes + limits.maxManifestBytes
    || limits.maxEncryptedBytes !== encryptedSizeLimit(limits.maxArchiveBytes)) throw failure();
  return { encryptionVersion: 2, digest: 'sha256-encrypted-wire',
    capability: { ...CAPABILITY, readVersions: [...CAPABILITY.readVersions] },
    limits: Object.fromEntries(LIMIT_KEYS.map(key => [key, limits[key]])) };
}

export function assertTransferContract(transfer) {
  if (!record(transfer) || Object.keys(transfer).sort().join(',') !== 'capability,digest,encryptionVersion,limits'
    || transfer.encryptionVersion !== 2 || transfer.digest !== 'sha256-encrypted-wire') throw failure();
  const normalized = snapshotTransferContract({ snapshotEncryption: transfer.capability, snapshotLimits: transfer.limits });
  if (!normalized) throw failure();
}

export function transferFields(value) {
  if (!Object.hasOwn(value, 'snapshotTransfer')) return {};
  assertTransferContract(value.snapshotTransfer);
  return { snapshotTransfer: snapshotTransferContract({ snapshotEncryption: value.snapshotTransfer.capability,
    snapshotLimits: value.snapshotTransfer.limits }) };
}

export function assertSameTransfer(left, right) {
  for (const value of [left, right]) if (Object.hasOwn(value, 'snapshotTransfer')) assertTransferContract(value.snapshotTransfer);
  if (JSON.stringify(left.snapshotTransfer) !== JSON.stringify(right.snapshotTransfer)) {
    throw new Error('Snapshot transfer contract changed; implicit migration or downgrade is refused.');
  }
}

/** Only the official resolver may produce the target contract after OCI config/digest verification. */
export function assertRecipientImage(transfer, resolved) {
  if (transfer === undefined) return;
  assertTransferContract(transfer);
  if (!record(resolved) || resolved.mode !== 'official' || resolved.compatibility !== 'verified'
    || typeof resolved.image !== 'string' || !/^ghcr\.io\/mario-andreschak\/flujo@sha256:[a-f0-9]{64}$/.test(resolved.image)
    || typeof resolved.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resolved.revision)
    || !Array.isArray(resolved.snapshotEnvelopeReadVersions) || resolved.snapshotEnvelopeReadVersions.length !== 2
    || resolved.snapshotEnvelopeReadVersions[0] !== 1 || resolved.snapshotEnvelopeReadVersions[1] !== 2) {
    throw new Error('Recipient-encrypted transfer requires an officially verified immutable target image.');
  }
  if (resolved.snapshotTransfer === undefined) {
    throw new Error('The immutable target restore bounds are not qualified; encrypted capture remains held.');
  }
  assertTransferContract(resolved.snapshotTransfer);
  if (JSON.stringify(transfer.capability) !== JSON.stringify(resolved.snapshotTransfer.capability)
    || LIMIT_KEYS.some(key => transfer.limits[key] > resolved.snapshotTransfer.limits[key])) {
    throw new Error('Source encrypted snapshot bounds or capability exceed the verified target restore contract.');
  }
}

/** The paired native publication contract binds its exact defaults and rejects image-level overrides. */
export function recipientImageContract(limitsLabel, config) {
  if (typeof limitsLabel !== 'string' || limitsLabel !== JSON.stringify(DEFAULT_TARGET_LIMITS)
    || !record(config) || Object.keys(config).some(key => key.toLowerCase() === 'env' && key !== 'Env')
    || (config.Env != null && (!Array.isArray(config.Env) || config.Env.some(value => typeof value !== 'string'
      || /^(?:FLUJO_SNAPSHOT_MAX_FILE_BYTES|FLUJO_SNAPSHOT_MAX_BYTES)(?:=|$)/.test(value))))) {
    throw new Error('The official image does not have the exact paired restore defaults without unqualified overrides.');
  }
  return snapshotTransferContract({ snapshotEncryption: CAPABILITY, snapshotLimits: DEFAULT_TARGET_LIMITS });
}

/** Default image bounds are valid only without unqualified runtime override paths. */
export function assertRecipientMachine(config, expectedCommand, { idleAllowed = false } = {}) {
  const empty = value => value == null || (Array.isArray(value) && value.length === 0);
  if (!record(config) || !record(config.env)
    || Object.keys(config).some(key => key.toLowerCase() === 'env' && key !== 'env')
    || Object.keys(config.env).some(key => LIMIT_OVERRIDES.has(key))
    || !empty(config.containers) || !empty(config.processes) || !empty(config.files)
    || !record(config.init) || Object.keys(config.init).some(key => key !== 'cmd'
      && !(['entrypoint', 'exec', 'kernel_args'].includes(key) && empty(config.init[key])))
    || !empty(config.guest?.kernel_args)
    || (JSON.stringify(config.init.cmd) !== JSON.stringify(expectedCommand)
      && !(idleAllowed && JSON.stringify(config.init.cmd) === JSON.stringify(['sleep', 'infinity'])))) {
    throw new Error('Recipient-encrypted target has unqualified restore-bound or execution overrides.');
  }
}

export function assertRecipientSecretNames(names) {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || LIMIT_OVERRIDES.has(name))) {
    throw new Error('Recipient-encrypted target has unqualified restore-bound secrets.');
  }
}

export function bindTransferObservation(options, observed) {
  const next = { ...options, ...(observed === undefined ? {} : { snapshotTransfer: observed }) };
  if (Object.hasOwn(options, 'snapshotTransfer')) {
    assertSameTransfer(options, { ...(observed === undefined ? {} : { snapshotTransfer: observed }) });
  }
  return next;
}

/** New, exclusive recovery material. Existing sidecars are never read, adopted or replaced. */
export async function retainRecipientKey(filename, record, key, attemptId = record.owner) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof record.owner !== 'string' || !uuid.test(record.owner)
    || typeof attemptId !== 'string' || !uuid.test(attemptId)
    || typeof record.app !== 'string' || !/^[a-z][a-z0-9-]{2,62}$/.test(record.app)
    || typeof record.workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(record.workspace)
    || typeof record.image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(record.image)) throw failure();
  filename = path.resolve(filename);
  // Validate the existing parent and every ancestor before ANY new path effect.
  // Existing operator directories need their own private-storage preparation.
  const parent = await assertPrivateDirectory(path.dirname(filename));
  const directory = `${filename}.snapshot-key-v2`;
  await fs.mkdir(directory, { mode: 0o700 });
  await ensurePrivateDirectory(directory);
  await writePrivateJson(`${directory}/recipient-key.json`, {
    format: 'flujo-cloud-recipient-key', version: 2, journalOwner: record.owner, attemptId, app: record.app,
    workspace: record.workspace, image: record.image, cipher: CAPABILITY.cipher,
    aad: CAPABILITY.v2Aad, key: key.toString('base64'),
  }, { exclusive: true });
  // File data is synced by writePrivateJson. POSIX permits bounded directory
  // entry sync too; Windows has no qualified equivalent in this slice.
  if (process.platform !== 'win32') {
    for (const current of [directory, parent]) {
      const handle = await fs.open(current, 'r');
      try { await handle.sync(); }
      finally { await handle.close(); }
    }
  }
}

export function transferArchiveLimit(transfer, bridgeMaxBytes) {
  assertTransferContract(transfer);
  if (!Number.isSafeInteger(bridgeMaxBytes) || bridgeMaxBytes < 1) throw failure();
  return Math.min(transfer.limits.maxArchiveBytes, bridgeMaxBytes);
}

function decoded(value, maxBytes) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maxBytes / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw failure();
  return bytes;
}

/** Authenticate the closed v2 envelope before provisioning. This does not inspect the ZIP or attest MCP portability. */
export function verifyRecipientEnvelope(bytes, key, maxArchiveBytes) {
  let ciphertext;
  let plaintext;
  let final;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > encryptedSizeLimit(maxArchiveBytes)
      || !Buffer.isBuffer(key) || key.length !== 32) throw failure();
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(envelope) || Object.keys(envelope).sort().join(',') !== 'data,format,iv,tag,version'
      || envelope.format !== CAPABILITY.format || envelope.version !== 2) throw failure();
    const iv = decoded(envelope.iv, 12);
    const tag = decoded(envelope.tag, 16);
    ciphertext = decoded(envelope.data, maxArchiveBytes);
    if (iv.length !== 12 || tag.length !== 16) throw failure();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(CAPABILITY.v2Aad, 'utf8'));
    decipher.setAuthTag(tag);
    plaintext = decipher.update(ciphertext);
    final = decipher.final();
    if (plaintext.length + final.length > maxArchiveBytes) throw failure();
  } catch { throw new Error('Encrypted snapshot authentication failed. Response details are withheld.'); }
  finally { ciphertext?.fill(0); plaintext?.fill(0); final?.fill(0); }
}
