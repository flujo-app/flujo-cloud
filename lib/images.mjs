import { createHash } from 'node:crypto';

const IMAGE = 'ghcr.io/mario-andreschak/flujo';
const REGISTRY = `https://${IMAGE.replace('ghcr.io/', 'ghcr.io/v2/')}`;
const TOKEN_URL = 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Amario-andreschak%2Fflujo%3Apull';
const SOURCE_URL = 'https://github.com/mario-andreschak/FLUJO';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// Docker tags cannot contain SemVer build metadata (+...). Official package
// versions must also fit the versioned cloud-worker tag without lossy rewriting.
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const CONFIG_TYPES = new Set(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json']);
const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ');
const LABELS = {
  applicationVersion: 'io.flujo.application.version',
  snapshotFormatVersion: 'io.flujo.snapshot.format',
  layoutVersion: 'io.flujo.workspace.layout',
  workerProtocolVersion: 'io.flujo.worker.protocol',
};

class ImageResolutionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function failure(code, message) { return new ImageResolutionError(code, message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
async function discard(response) { await response.body?.cancel().catch(() => undefined); }

function validateSource(source) {
  if (!record(source) || typeof source.applicationVersion !== 'string'
    || source.applicationVersion.length > 115 || !VERSION.test(source.applicationVersion)
    || ['snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion'].some((key) => !Number.isSafeInteger(source[key]) || source[key] < 1)
    || (source.revision !== undefined && (typeof source.revision !== 'string' || !REVISION.test(source.revision)))) {
    throw failure('IMAGE_SOURCE_INVALID', 'Local FLUJO must report its application, snapshot, layout and worker protocol versions before image selection.');
  }
}

async function readBytes(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await discard(response);
    throw failure('IMAGE_PAYLOAD_LIMIT', 'Registry metadata exceeds the image resolver size limit.');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) throw failure('IMAGE_PAYLOAD_LIMIT', 'Registry metadata exceeds the image resolver size limit.');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof ImageResolutionError) throw error;
    throw failure('IMAGE_REGISTRY', 'Could not read registry metadata. Response details are withheld.');
  }
  return Buffer.concat(chunks);
}

function parse(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (record(value)) return value;
  } catch { /* Registry payloads may contain sensitive data; never return parser details. */ }
  throw failure('IMAGE_METADATA_INVALID', 'Registry metadata is not a valid JSON object.');
}

function checkDescriptor(value, types, limit) {
  if (!record(value) || !types.has(value.mediaType) || !DIGEST.test(value.digest ?? '')
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > limit) {
    throw failure('IMAGE_METADATA_INVALID', 'Registry image descriptor is invalid or exceeds the size limit.');
  }
}

function verifyBytes(bytes, expected, size) {
  if (!DIGEST.test(expected ?? '') || digest(bytes) !== expected || (size !== undefined && bytes.length !== size)) {
    throw failure('IMAGE_INTEGRITY', 'Registry metadata failed digest or size verification.');
  }
}

function validateConfig(config, source, expectedRevision) {
  if (config.os !== 'linux' || config.architecture !== 'amd64') {
    throw failure('IMAGE_PLATFORM', 'The official worker image must support Linux amd64.');
  }
  const labels = config.config?.Labels;
  if (!record(labels) || labels['org.opencontainers.image.source'] !== SOURCE_URL
    || !REVISION.test(labels['org.opencontainers.image.revision'] ?? '')) {
    throw failure('IMAGE_IDENTITY', 'The worker image lacks the official FLUJO source and revision labels.');
  }
  const revision = labels['org.opencontainers.image.revision'];
  if (expectedRevision && revision !== expectedRevision) {
    throw failure('IMAGE_IDENTITY', 'The revision-tagged worker image does not match the source revision.');
  }
  for (const [field, label] of Object.entries(LABELS)) {
    if (labels[label] !== String(source[field])) {
      throw failure('IMAGE_COMPATIBILITY', 'The official worker image is incompatible with local FLUJO. Update FLUJO to a supported version, or retry after its matching worker image is published.');
    }
  }
  return revision;
}

/**
 * Resolve official tags locally; only the immutable Linux/amd64 manifest reaches Fly.
 * Endpoint allowlist: ghcr.io token + this repository's manifests/blobs. GHCR config
 * blobs can return one signed redirect to pkg-containers.githubusercontent.com.
 * That request gets no registry bearer, cookies or referrer and cannot redirect again.
 * No caller-provided registry URL, authentication challenge or descriptor URL is used.
 */
export async function resolveWorkerImage({ source, image, channel, fetchImpl = fetch,
  timeoutMs = 30_000, maxPayloadBytes = 2 * 1024 * 1024 } = {}) {
  if (image !== undefined) {
    if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)) {
      throw failure('IMAGE_OVERRIDE_INVALID', 'An explicit worker image must be an immutable registry reference ending in a lowercase SHA-256 digest.');
    }
    // Preserve the advanced custom-image path. Restore/readiness still enforce its
    // runtime compatibility; registry labels are deliberately not claimed as checked.
    return { image, mode: 'explicit', compatibility: 'unchecked' };
  }
  validateSource(source);
  if (channel !== undefined && (typeof channel !== 'string' || !/^[a-z0-9_][a-z0-9_.-]{0,127}$/.test(channel))) {
    throw failure('IMAGE_CHANNEL_INVALID', 'Choose a valid tag in the official FLUJO image repository.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1024 || maxPayloadBytes > 16 * 1024 * 1024) {
    throw failure('IMAGE_OPTIONS_INVALID', 'Invalid registry timeout or metadata size limit.');
  }
  let token = '';
  const request = async (url, { blob = false, anonymous = false } = {}) => {
    try {
      return await fetchImpl(url, {
        method: 'GET', redirect: blob ? 'manual' : 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: anonymous ? {} : { Authorization: `Bearer ${token}`, Accept: ACCEPT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failure('IMAGE_REGISTRY', 'Official image registry request failed. Transport details are withheld.');
    }
  };
  const successfulBytes = async (response, limit = maxPayloadBytes) => {
    if (response.status !== 200) {
      await discard(response);
      throw failure('IMAGE_REGISTRY', `Official image registry request failed (HTTP ${response.status}). Response details are withheld.`);
    }
    return readBytes(response, limit);
  };
  const manifest = async (ref, { optional = false, descriptor } = {}) => {
    const response = await request(`${REGISTRY}/manifests/${ref}`);
    if (optional && response.status === 404) { await discard(response); return null; }
    if (response.status === 404) {
      await discard(response);
      throw failure('IMAGE_NOT_PUBLISHED', 'No official cloud-worker image is available for this FLUJO version/channel yet. Retry after publication, or use a supported FLUJO version.');
    }
    const bytes = await successfulBytes(response);
    const expected = response.headers.get('docker-content-digest');
    verifyBytes(bytes, expected);
    if (descriptor) verifyBytes(bytes, descriptor.digest, descriptor.size);
    const value = parse(bytes);
    if (value.schemaVersion !== 2 || (!INDEX_TYPES.has(value.mediaType) && !MANIFEST_TYPES.has(value.mediaType))) {
      throw failure('IMAGE_METADATA_INVALID', 'The registry did not return a supported OCI or Docker v2 image manifest.');
    }
    return { value, digest: expected };
  };
  try {
    let credentials = parse(await successfulBytes(await request(TOKEN_URL, { anonymous: true }), 64 * 1024));
    token = credentials.token ?? credentials.access_token;
    credentials = null;
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,16384}$/.test(token)) {
      throw failure('IMAGE_REGISTRY', 'The official registry did not issue a valid anonymous pull token.');
    }
    // An explicit channel is exact user intent. Default selection first tries the
    // source build, then its compatible release line, then the current channel.
    // Only a missing tag can fall through: identity/integrity/compatibility errors
    // from a found candidate must never be hidden by choosing a different build.
    const candidates = channel !== undefined ? [{ tag: channel }] : [
      ...(source.revision ? [{ tag: `cloud-worker-${source.revision}`, revision: source.revision }] : []),
      { tag: `cloud-worker-${source.applicationVersion}` }, { tag: 'cloud-worker' },
    ];
    let selectedTag;
    let expectedRevision;
    let resolved;
    for (const [index, candidate] of candidates.entries()) {
      resolved = await manifest(candidate.tag, { optional: index < candidates.length - 1 });
      if (resolved) { selectedTag = candidate.tag; expectedRevision = candidate.revision; break; }
    }
    const indexDigest = INDEX_TYPES.has(resolved.value.mediaType) ? resolved.digest : undefined;
    if (indexDigest) {
      const entries = resolved.value.manifests;
      if (!Array.isArray(entries) || entries.length > 1000) {
        throw failure('IMAGE_METADATA_INVALID', 'Registry image index is invalid.');
      }
      const matches = entries.filter((entry) => record(entry) && entry.platform?.os === 'linux'
        && entry.platform?.architecture === 'amd64'
        && entry.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
      if (matches.length !== 1) throw failure('IMAGE_PLATFORM', 'The official image index must contain exactly one Linux amd64 worker manifest.');
      checkDescriptor(matches[0], MANIFEST_TYPES, maxPayloadBytes);
      resolved = await manifest(matches[0].digest, { descriptor: matches[0] });
      if (!MANIFEST_TYPES.has(resolved.value.mediaType)) {
        throw failure('IMAGE_METADATA_INVALID', 'The worker platform descriptor must resolve to an image manifest.');
      }
    }
    const configDescriptor = resolved.value.config;
    checkDescriptor(configDescriptor, CONFIG_TYPES, maxPayloadBytes);
    let configResponse = await request(`${REGISTRY}/blobs/${configDescriptor.digest}`, { blob: true });
    if ([301, 302, 303, 307, 308].includes(configResponse.status)) {
      let target;
      try { target = new URL(configResponse.headers.get('location')); } catch { /* Reject below. */ }
      await discard(configResponse);
      if (!target || target.protocol !== 'https:' || target.hostname !== 'pkg-containers.githubusercontent.com'
        || target.port || target.username || target.password || target.hash) {
        throw failure('IMAGE_REGISTRY_REDIRECT', 'Registry config redirect did not match the approved GitHub storage endpoint.');
      }
      configResponse = await request(target.href, { anonymous: true });
    }
    const configBytes = await successfulBytes(configResponse);
    verifyBytes(configBytes, configDescriptor.digest, configDescriptor.size);
    const revision = validateConfig(parse(configBytes), source, expectedRevision);
    return { image: `${IMAGE}@${resolved.digest}`, mode: 'official', compatibility: 'verified',
      applicationVersion: source.applicationVersion, revision, selectedTag,
      snapshotFormatVersion: source.snapshotFormatVersion, layoutVersion: source.layoutVersion,
      workerProtocolVersion: source.workerProtocolVersion, architecture: 'amd64', os: 'linux',
      ...(indexDigest ? { indexDigest } : {}) };
  } finally { token = ''; }
}
