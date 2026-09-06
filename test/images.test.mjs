import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveWorkerImage } from '../lib/images.mjs';

const IMAGE = 'ghcr.io/mario-andreschak/flujo';
const REGISTRY = 'https://ghcr.io/v2/mario-andreschak/flujo';
const TOKEN = 'synthetic_anonymous_registry_token_0123456789';
const REVISION = 'a'.repeat(40);
const SOURCE = { applicationVersion: '3.45.0', snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1 };
const TYPE = { index: 'application/vnd.oci.image.index.v1+json', manifest: 'application/vnd.oci.image.manifest.v1+json', config: 'application/vnd.oci.image.config.v1+json' };
function packed(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
function descriptor(item, mediaType, extra = {}) { return { digest: item.digest, size: item.bytes.length, mediaType, ...extra }; }
function response(item, headers = {}) { return new Response(item.bytes, { headers: { 'docker-content-digest': item.digest, ...headers } }); }

function fixture({ labels = {}, missingLabels = false, architecture = 'amd64', os = 'linux', index = false,
  extraPlatforms = [], configExtra = {}, manifestExtra = {}, indexEntries, mediaTypes = TYPE } = {}) {
  const config = packed({ architecture, os, config: { Labels: {
    'org.opencontainers.image.source': 'https://github.com/mario-andreschak/FLUJO',
    'org.opencontainers.image.revision': REVISION,
    'org.opencontainers.image.version': 'latest',
    ...(!missingLabels ? {
      'io.flujo.application.version': SOURCE.applicationVersion,
      'io.flujo.snapshot.format': '2', 'io.flujo.workspace.layout': '2', 'io.flujo.worker.protocol': '1',
    } : {}), ...labels,
  } }, ...configExtra });
  const manifest = packed({ schemaVersion: 2, mediaType: mediaTypes.manifest,
    config: descriptor(config, mediaTypes.config), layers: [], ...manifestExtra });
  const root = index ? packed({ schemaVersion: 2, mediaType: mediaTypes.index, manifests: indexEntries || [
    descriptor(manifest, mediaTypes.manifest, { platform: { os: 'linux', architecture: 'amd64' } }),
    { mediaType: mediaTypes.manifest, digest: `sha256:${'b'.repeat(64)}`, size: 200,
      platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
    ...extraPlatforms,
  ] }) : manifest;
  const calls = [];
  const tags = new Map([['cloud-worker', root]]);
  const registryFetch = async (input, options) => {
    const url = String(input);
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.startsWith('https://ghcr.io/token?')) {
      assert.equal(url, 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Amario-andreschak%2Fflujo%3Apull');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, {});
      return Response.json({ token: TOKEN });
    }
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (url.startsWith(`${REGISTRY}/manifests/`)) {
      assert.equal(options.redirect, 'error');
      const ref = url.slice(`${REGISTRY}/manifests/`.length);
      if (ref === manifest.digest) return response(manifest);
      return tags.has(ref) ? response(tags.get(ref)) : new Response('not published', { status: 404 });
    }
    assert.equal(url, `${REGISTRY}/blobs/${config.digest}`);
    assert.equal(options.redirect, 'manual');
    return response(config);
  };
  return { config, manifest, root, calls, tags, registryFetch,
    resolve: (options = {}) => resolveWorkerImage({ source: SOURCE, fetchImpl: registryFetch, ...options }) };
}

test('resolves a direct official manifest using explicit compatibility labels, not OCI version latest', async () => {
  const f = fixture();
  const selected = await f.resolve();
  assert.deepEqual(selected, { image: `${IMAGE}@${f.manifest.digest}`, mode: 'official', compatibility: 'verified',
    ...SOURCE, revision: REVISION, selectedTag: 'cloud-worker', architecture: 'amd64', os: 'linux' });
  assert.equal(f.calls.length, 4);
  assert.ok(!JSON.stringify(selected).includes(TOKEN));
});

test('resolves the sole Linux amd64 child from an index and ignores attestation descriptors', async () => {
  const f = fixture({ index: true, extraPlatforms: [{ mediaType: TYPE.manifest, digest: `sha256:${'c'.repeat(64)}`,
    size: 200, platform: { os: 'linux', architecture: 'arm64' } }] });
  const selected = await f.resolve();
  assert.equal(selected.image, `${IMAGE}@${f.manifest.digest}`);
  assert.equal(selected.indexDigest, f.root.digest);
  assert.ok(!f.calls.some(({ url }) => url.endsWith('b'.repeat(64)) || url.endsWith('c'.repeat(64))));
});

test('accepts official single-platform Docker v2 manifests and Docker manifest lists', async () => {
  const mediaTypes = { index: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifest: 'application/vnd.docker.distribution.manifest.v2+json', config: 'application/vnd.docker.container.image.v1+json' };
  for (const index of [false, true]) {
    const f = fixture({ mediaTypes, index });
    assert.equal((await f.resolve()).image, `${IMAGE}@${f.manifest.digest}`);
  }
});

test('accepts a tag-safe prerelease version only when image labels exactly match', async () => {
  const applicationVersion = '3.46.0-rc.1';
  const f = fixture({ labels: { 'io.flujo.application.version': applicationVersion } });
  assert.equal((await f.resolve({ source: { ...SOURCE, applicationVersion } })).applicationVersion, applicationVersion);
});

test('rejects unsupported manifest schema or media types after integrity verification', async () => {
  for (const manifestExtra of [{ schemaVersion: 1 }, { mediaType: 'application/json' }]) {
    await assert.rejects(fixture({ manifestExtra }).resolve(), { code: 'IMAGE_METADATA_INVALID' });
  }
});

test('prefers the full source revision tag without consulting a mutable channel', async () => {
  const f = fixture();
  f.tags.set(`cloud-worker-${REVISION}`, f.root);
  const selected = await f.resolve({ source: { ...SOURCE, revision: REVISION } });
  assert.equal(selected.selectedTag, `cloud-worker-${REVISION}`);
  assert.ok(!f.calls.some(({ url }) => url === `${REGISTRY}/manifests/cloud-worker`));
});

test('falls back to channel only when the exact revision tag is absent', async () => {
  const f = fixture();
  const selected = await f.resolve({ source: { ...SOURCE, revision: 'b'.repeat(40) } });
  assert.equal(selected.selectedTag, 'cloud-worker');
  assert.equal(selected.revision, REVISION);
  assert.equal(f.calls.length, 5);
});

test('prefers the matching version tag over a newer default channel after the revision tag is absent', async () => {
  const f = fixture();
  f.tags.set(`cloud-worker-${SOURCE.applicationVersion}`, f.root);
  f.tags.set('cloud-worker', fixture({ labels: { 'io.flujo.application.version': '3.46.0' } }).root);
  const selected = await f.resolve({ source: { ...SOURCE, revision: 'b'.repeat(40) } });
  assert.equal(selected.selectedTag, `cloud-worker-${SOURCE.applicationVersion}`);
  assert.equal(selected.applicationVersion, SOURCE.applicationVersion);
  assert.ok(!f.calls.some(({ url }) => url === `${REGISTRY}/manifests/cloud-worker`));
});

test('an explicit channel is honored without consulting exact revision or automatic version tags', async () => {
  const f = fixture();
  f.tags.set(`cloud-worker-${REVISION}`, f.root);
  f.tags.set(`cloud-worker-${SOURCE.applicationVersion}`, f.root);
  f.tags.set('cloud-worker-preview', f.root);
  const selected = await f.resolve({ source: { ...SOURCE, revision: 'b'.repeat(40) }, channel: 'cloud-worker-preview' });
  assert.equal(selected.selectedTag, 'cloud-worker-preview');
  assert.equal(selected.revision, REVISION);
  assert.equal(f.calls.length, 3);
});

test('a found version tag with incompatible labels does not fall through to the default channel', async () => {
  const f = fixture();
  const wrong = fixture({ labels: { 'io.flujo.worker.protocol': '2' } });
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => {
    if (String(url) === `${REGISTRY}/manifests/cloud-worker-${SOURCE.applicationVersion}`) return response(wrong.root);
    if (String(url) === `${REGISTRY}/blobs/${wrong.config.digest}`) return response(wrong.config);
    return f.registryFetch(url, init);
  } }), { code: 'IMAGE_COMPATIBILITY' });
  assert.ok(!f.calls.some(({ url }) => url === `${REGISTRY}/manifests/cloud-worker`));
});

test('never falls back after a revision identity mismatch or a registry failure', async () => {
  const f = fixture();
  f.tags.set(`cloud-worker-${'b'.repeat(40)}`, f.root);
  await assert.rejects(f.resolve({ source: { ...SOURCE, revision: 'b'.repeat(40) } }), { code: 'IMAGE_IDENTITY' });
  assert.ok(!f.calls.some(({ url }) => url === `${REGISTRY}/manifests/cloud-worker`));
  let channels = 0;
  await assert.rejects(f.resolve({ source: { ...SOURCE, revision: REVISION }, fetchImpl: async (url, init) => {
    if (String(url).endsWith(`cloud-worker-${REVISION}`)) return new Response(TOKEN, { status: 503 });
    if (String(url).endsWith('/cloud-worker')) channels += 1;
    return f.registryFetch(url, init);
  } }), { code: 'IMAGE_REGISTRY' });
  assert.equal(channels, 0);
});

test('rejects old public release metadata even when the application version is unchanged', async () => {
  const f = fixture({ missingLabels: true });
  f.tags.set('latest', f.root);
  await assert.rejects(f.resolve({ channel: 'latest' }), { code: 'IMAGE_COMPATIBILITY' });
});

for (const [label, value] of [
  ['io.flujo.application.version', '3.44.0'], ['io.flujo.snapshot.format', '1'],
  ['io.flujo.workspace.layout', '1'], ['io.flujo.worker.protocol', '2'],
  ['io.flujo.worker.protocol', 1],
]) test(`rejects incompatible ${label}=${value}`, async () => {
  await assert.rejects(fixture({ labels: { [label]: value } }).resolve(), { code: 'IMAGE_COMPATIBILITY' });
});

test('rejects untrusted source/revision labels', async () => {
  for (const labels of [
    { 'org.opencontainers.image.source': 'https://github.com/attacker/FLUJO' },
    { 'org.opencontainers.image.revision': 'main' },
  ]) await assert.rejects(fixture({ labels }).resolve(), { code: 'IMAGE_IDENTITY' });
});

test('rejects config architecture and OS mismatch', async () => {
  await assert.rejects(fixture({ architecture: 'arm64' }).resolve(), { code: 'IMAGE_PLATFORM' });
  await assert.rejects(fixture({ os: 'windows' }).resolve(), { code: 'IMAGE_PLATFORM' });
});

test('rejects absent or ambiguous Linux amd64 index entries', async () => {
  await assert.rejects(fixture({ index: true, indexEntries: [] }).resolve(), { code: 'IMAGE_PLATFORM' });
  const f = fixture({ index: true, extraPlatforms: [{ mediaType: TYPE.manifest, digest: `sha256:${'c'.repeat(64)}`,
    size: 200, platform: { os: 'linux', architecture: 'amd64' } }] });
  await assert.rejects(f.resolve(), { code: 'IMAGE_PLATFORM' });
});

test('verifies root tag bytes against registry digest header', async () => {
  const f = fixture();
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => String(url).endsWith('/manifests/cloud-worker')
    ? response(f.manifest, { 'docker-content-digest': `sha256:${'f'.repeat(64)}` }) : f.registryFetch(url, init) }), { code: 'IMAGE_INTEGRITY' });
});

test('requires a valid manifest digest header', async () => {
  const f = fixture();
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => String(url).endsWith('/manifests/cloud-worker')
    ? new Response(f.manifest.bytes) : f.registryFetch(url, init) }), { code: 'IMAGE_INTEGRITY' });
});

test('verifies an index child against the descriptor even when its response header matches different bytes', async () => {
  const f = fixture({ index: true });
  const wrong = packed({ schemaVersion: 2, mediaType: TYPE.manifest, config: descriptor(f.config, TYPE.config), layers: [], changed: true });
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => String(url).endsWith(`/manifests/${f.manifest.digest}`)
    ? response(wrong) : f.registryFetch(url, init) }), { code: 'IMAGE_INTEGRITY' });
});

test('verifies config bytes against their descriptor digest and declared size', async () => {
  const f = fixture();
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => String(url).includes('/blobs/')
    ? new Response('{}') : f.registryFetch(url, init) }), { code: 'IMAGE_INTEGRITY' });
  const wrongSize = fixture();
  const root = packed({ schemaVersion: 2, mediaType: TYPE.manifest,
    config: { ...descriptor(wrongSize.config, TYPE.config), size: wrongSize.config.bytes.length + 1 }, layers: [] });
  wrongSize.tags.set('cloud-worker', root);
  await assert.rejects(wrongSize.resolve(), { code: 'IMAGE_INTEGRITY' });
});

test('rejects metadata descriptors with unsafe digest paths without fetching their URLs', async () => {
  const f = fixture({ manifestExtra: { config: { mediaType: TYPE.config, digest: '../../token', size: 10,
    urls: ['https://attacker.invalid/config'] } } });
  await assert.rejects(f.resolve(), { code: 'IMAGE_METADATA_INVALID' });
  assert.equal(f.calls.length, 3);
});

test('follows one allowlisted config CDN redirect without sending registry credentials', async () => {
  const f = fixture();
  const target = 'https://pkg-containers.githubusercontent.com/ghcr1/blobs/config?signature=synthetic';
  let cdn = 0;
  const selected = await f.resolve({ fetchImpl: async (url, init) => {
    if (url === target) {
      cdn += 1;
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.deepEqual(init.headers, {});
      return new Response(f.config.bytes);
    }
    if (String(url).includes('/blobs/')) return new Response(null, { status: 307, headers: { location: target } });
    return f.registryFetch(url, init);
  } });
  assert.equal(cdn, 1);
  assert.equal(selected.mode, 'official');
  assert.ok(!JSON.stringify(selected).includes('signature'));
});

for (const location of [
  'https://attacker.invalid/config', 'https://pkg-containers.githubusercontent.com.attacker.invalid/config',
  'http://pkg-containers.githubusercontent.com/config', 'https://user:password@pkg-containers.githubusercontent.com/config',
  'https://pkg-containers.githubusercontent.com:444/config', '//pkg-containers.githubusercontent.com/config',
  'https://pkg-containers.githubusercontent.com/config#fragment',
]) test(`rejects unsafe config redirect ${location}`, async () => {
  const f = fixture();
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => String(url).includes('/blobs/')
    ? new Response(null, { status: 307, headers: { location } }) : f.registryFetch(url, init) }), { code: 'IMAGE_REGISTRY_REDIRECT' });
});

test('rejects further CDN redirects and does not include signed URL details', async () => {
  const f = fixture();
  const target = 'https://pkg-containers.githubusercontent.com/config?signature=private';
  await assert.rejects(f.resolve({ fetchImpl: async (url, init) => {
    if (String(url).includes('/blobs/')) return new Response(null, { status: 307, headers: { location: target } });
    if (url === target) return new Response('private CDN response', { status: 302, headers: { location: 'https://attacker.invalid' } });
    return f.registryFetch(url, init);
  } }), (error) => error.code === 'IMAGE_REGISTRY' && !error.message.includes('private'));
});

test('verifies bytes fetched from CDN and rejects oversized CDN payloads', async () => {
  for (const body of ['{}', 'x'.repeat(2048)]) {
    const f = fixture();
    const target = 'https://pkg-containers.githubusercontent.com/config';
    await assert.rejects(f.resolve({ maxPayloadBytes: 1024, fetchImpl: async (url, init) => {
      if (String(url).includes('/blobs/')) return new Response(null, { status: 307, headers: { location: target } });
      if (url === target) return new Response(body);
      return f.registryFetch(url, init);
    } }), { code: body.length > 1024 ? 'IMAGE_PAYLOAD_LIMIT' : 'IMAGE_INTEGRITY' });
  }
});

test('rejects oversized headers and bodies before JSON parsing', async () => {
  for (const oversized of [new Response('x', { headers: { 'content-length': '3000000' } }), new Response('x'.repeat(2048))]) {
    const f = fixture();
    await assert.rejects(f.resolve({ maxPayloadBytes: 1024, fetchImpl: async (url, init) => String(url).includes('/manifests/')
      ? oversized : f.registryFetch(url, init) }), { code: 'IMAGE_PAYLOAD_LIMIT' });
  }
});

test('bounds anonymous token payload and rejects invalid tokens without printing them', async () => {
  for (const body of [JSON.stringify({ token: `${TOKEN}\nprivate` }), 'x'.repeat(65537)]) {
    const f = fixture();
    await assert.rejects(f.resolve({ fetchImpl: async () => new Response(body) }), (error) => {
      assert.ok(['IMAGE_REGISTRY', 'IMAGE_PAYLOAD_LIMIT'].includes(error.code));
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  }
});

test('withholds HTTP bodies, transport errors and JSON parse details', async () => {
  const f = fixture();
  for (const action of [
    () => new Response(TOKEN, { status: 403 }),
    () => { throw new Error(`Request failed with ${TOKEN}`); },
    () => new Response(`invalid JSON ${TOKEN}`),
  ]) await assert.rejects(f.resolve({ fetchImpl: async () => action() }), (error) => !error.message.includes(TOKEN));
});

test('withholds stream errors even if they imitate an internal error code', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(TOKEN), { code: 'IMAGE_PAYLOAD_LIMIT' })); } });
  await assert.rejects(resolveWorkerImage({ source: SOURCE, fetchImpl: async () => new Response(body) }),
    (error) => error.code === 'IMAGE_REGISTRY' && !error.message.includes(TOKEN));
});

test('reports unpublished channel before any provisioning is possible', async () => {
  const f = fixture();
  f.tags.clear();
  await assert.rejects(f.resolve(), { code: 'IMAGE_NOT_PUBLISHED' });
  assert.equal(f.calls.length, 3);
});

test('validates source and channel before making network requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error('unexpected'); };
  for (const source of [undefined, {}, { ...SOURCE, workerProtocolVersion: '1' }, { ...SOURCE, revision: '../other' },
    { ...SOURCE, applicationVersion: '3.45.0+build' }, { ...SOURCE, applicationVersion: '3.45.0/other' },
    { ...SOURCE, applicationVersion: '3.045.0' }, { ...SOURCE, applicationVersion: `3.45.0-${'x'.repeat(110)}` }]) {
    await assert.rejects(resolveWorkerImage({ source, fetchImpl }), { code: 'IMAGE_SOURCE_INVALID' });
  }
  for (const channel of ['../latest', 'https://attacker.invalid', 'tag?secret']) {
    await assert.rejects(resolveWorkerImage({ source: SOURCE, channel, fetchImpl }), { code: 'IMAGE_CHANNEL_INVALID' });
  }
  assert.equal(requests, 0);
});

test('retains explicit immutable custom images without pretending to verify their registry metadata', async () => {
  const image = `registry.fly.io/custom-worker@sha256:${'e'.repeat(64)}`;
  assert.deepEqual(await resolveWorkerImage({ image, fetchImpl: () => { throw new Error('must not fetch'); } }),
    { image, mode: 'explicit', compatibility: 'unchecked' });
  for (const invalid of ['registry.fly.io/custom:latest', `${IMAGE}@sha256:${'A'.repeat(64)}`, `${image}\nsecret`]) {
    await assert.rejects(resolveWorkerImage({ image: invalid }), { code: 'IMAGE_OVERRIDE_INVALID' });
  }
});
