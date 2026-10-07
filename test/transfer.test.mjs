import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotTransferContract, assertTransferContract, assertSameTransfer,
  encryptedSizeLimit, verifyRecipientEnvelope, retainRecipientKey, assertRecipientImage,
  recipientImageContract, assertRecipientMachine, assertRecipientSecretNames } from '../lib/transfer.mjs';
import { captureSnapshot } from '../lib/snapshot.mjs';
import { sha256 } from '../lib/envelope.mjs';
import { ensurePrivateDirectory, readPrivateJson } from '../lib/private-files.mjs';

const capability = {
  format: 'flujo-workspace-encrypted', cipher: 'aes-256-gcm', writeVersion: 2, readVersions: [1, 2],
  legacyPlaintextRead: true, recipientKeyRequired: true, recipientKeyBytes: 32, recipientKeyEncoding: 'base64',
  v2Aad: 'flujo:workspace-snapshot:v2', v2Digest: 'sha256-encrypted-wire', v1Digest: 'sha256-plaintext-zip',
};
const maxUncompressedBytes = 1024 * 1024;
const maxArchiveBytes = maxUncompressedBytes + 8 * 1024 * 1024;
const limits = { maxFileBytes: 1024, maxUncompressedBytes, maxManifestBytes: 8 * 1024 * 1024,
  maxArchiveBytes, maxEncryptedBytes: 4 * Math.ceil(maxArchiveBytes / 3) + 4096, maxMembers: 65_534 };
const compatibility = { snapshotEncryption: capability, snapshotLimits: limits };
const contract = () => snapshotTransferContract(compatibility);
const token = 'synthetic_snapshot_source_token_0123456789';
const sessionId = '5cbbd52a-e64c-41a3-8093-4d16656f8f8a';
const workspace = 'synthetic-workspace';
const plaintext = Buffer.from('synthetic ZIP placeholder; this is not native archive or MCP proof');

function envelope(key, { version = 2, aad = capability.v2Aad, bytes = plaintext } = {}) {
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.from(JSON.stringify({ format: capability.format, version, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
}

function captureFixture({ initial = {}, status = {}, final = {}, abort = {}, wire, transformDownload,
  maxBytes = 1024, failRetention = false, failBegin = false, throwBegin = false, selectedFlows } = {}) {
  const requests = [];
  const events = [];
  let retainedKey;
  let sentKey;
  let wireBytes;
  const info = state => ({ workspace, sessionId, state, encryptionVersion: 2 });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ endpoint: url.pathname, init });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['x-flujo-workspace'], workspace);
    assert.equal(init.redirect, 'error');
    assert.equal(url.searchParams.get('workspace'), workspace);
    if (!url.pathname.endsWith('/begin')) assert.equal(url.searchParams.get('sessionId'), sessionId);
    if (url.pathname.endsWith('/begin')) {
      events.push('begin');
      assert.equal(events[0], 'retain');
      if (throwBegin) throw new Error('synthetic_secret_marker_in_transport');
      if (failBegin) return new Response('synthetic_secret_marker', { status: 403 });
      const selection = JSON.parse(init.body);
      assert.equal(init.headers['Content-Type'], 'application/json');
      sentKey = Buffer.from(selection.recipientKey, 'base64');
      assert.equal(sentKey.length, 32);
      assert.equal(sentKey.toString('base64'), selection.recipientKey);
      assert.deepEqual(selection.flowIds, selectedFlows);
      assert.deepEqual(sentKey, retainedKey);
      wireBytes = wire ? wire(sentKey) : envelope(sentKey);
      return Response.json({ ...info('beginning'), ...initial }, { status: 202 });
    }
    if (url.pathname.endsWith('/status')) return Response.json({ ...info('ready'),
      sha256: sha256(wireBytes), archiveBytes: wireBytes.length, ...status });
    if (url.pathname.endsWith('/download')) {
      const response = new Response(wireBytes, { headers: {
        'content-type': 'application/vnd.flujo.workspace-snapshot+json',
        'content-length': String(wireBytes.length), 'x-flujo-snapshot-sha256': sha256(wireBytes),
      } });
      return transformDownload ? transformDownload(response, wireBytes) : response;
    }
    if (url.pathname.endsWith('/finalize')) return final instanceof Response ? final : Response.json({ ...info('finalized'), ...final });
    if (url.pathname.endsWith('/abort')) return abort instanceof Response ? abort : Response.json({ ...info('aborted'), ...abort });
    throw new Error('Unexpected synthetic endpoint.');
  };
  return {
    requests, events, wireBytes: () => wireBytes, sentKey: () => sentKey, retainedKey: () => retainedKey,
    run: async extra => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-v2-capture-test-'));
      try {
      const artifact = await captureSnapshot({ origin: 'http://127.0.0.1:4200', workspace, token, scope: 'workspace',
      transfer: contract(), outputPath: path.join(directory, 'ciphertext'), maxBytes, timeoutMs: 1000, sleep: async () => undefined, fetchImpl,
      onRecipientKey: async key => { events.push('retain'); retainedKey = Buffer.from(key);
        if (failRetention) throw new Error('Synthetic private retention refusal.'); }, ...extra });
      assert.equal(Object.hasOwn(artifact, 'bytes'), false);
      return { ...artifact, bytes: await fs.readFile(artifact.path), sha256: artifact.wireSha256, key: Buffer.from(retainedKey) };
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    },
  };
}

test('exact native v2 negotiation is closed and legacy absence never manufactures encryption support', () => {
  assert.equal(snapshotTransferContract({}), undefined);
  assert.deepEqual(contract(), { encryptionVersion: 2, digest: 'sha256-encrypted-wire', capability, limits });
  for (const altered of [{ ...capability, writeVersion: 1 }, { ...capability, readVersions: [2] },
    { ...capability, recipientKeyBytes: 31 }, { ...capability, recipientKeyRequired: false },
    { ...capability, v2Digest: 'sha256-plaintext-zip' }, { ...capability, v2Aad: 'other' },
    { ...capability, extra: true }, { ...capability, writeVersion: new Number(2) }]) {
    assert.throws(() => snapshotTransferContract({ ...compatibility, snapshotEncryption: altered }));
  }
  assert.throws(() => snapshotTransferContract({ snapshotLimits: limits }));
});

test('native bounds reject coercion, overflow, missing members and inconsistent wire expansion', () => {
  for (const altered of [{ ...limits, maxEncryptedBytes: limits.maxEncryptedBytes + 1 },
    { ...limits, maxArchiveBytes: limits.maxArchiveBytes - 1 }, { ...limits, maxFileBytes: '1024' },
    { ...limits, maxManifestBytes: 0 }, { ...limits, maxMembers: 65535 },
    { ...limits, maxUncompressedBytes: Number.MAX_SAFE_INTEGER }, { ...limits, extra: 1 }]) {
    assert.throws(() => snapshotTransferContract({ ...compatibility, snapshotLimits: altered }));
  }
  assert.throws(() => encryptedSizeLimit(Number.MAX_SAFE_INTEGER));
  assert.throws(() => assertTransferContract({ ...contract(), arbitraryAuthority: true }));
});

test('record transfer contract cannot migrate, downgrade or silently change limits', () => {
  assertSameTransfer({}, {});
  assertSameTransfer({ snapshotTransfer: contract() }, { snapshotTransfer: contract() });
  assert.throws(() => assertSameTransfer({}, { snapshotTransfer: contract() }));
  assert.throws(() => assertSameTransfer({ snapshotTransfer: contract() }, {}));
  const changed = contract(); changed.limits.maxFileBytes += 1;
  assert.throws(() => assertSameTransfer({ snapshotTransfer: contract() }, { snapshotTransfer: changed }));
});

test('recipient target must be official/immutable and support every observed source bound; caller flags do not qualify it', () => {
  const resolved = { mode: 'official', compatibility: 'verified', revision: 'a'.repeat(40),
    image: `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`,
    snapshotEnvelopeReadVersions: [1, 2], snapshotTransfer: contract() };
  assertRecipientImage(contract(), resolved);
  for (const altered of [{ ...resolved, mode: 'explicit', compatibility: 'unchecked' },
    { ...resolved, snapshotTransfer: undefined }, { ...resolved, revision: undefined },
    { ...resolved, image: `ghcr.io/example/flujo@sha256:${'a'.repeat(64)}` }]) {
    assert.throws(() => assertRecipientImage(contract(), altered));
  }
  const smaller = contract(); smaller.limits.maxFileBytes -= 1;
  assert.throws(() => assertRecipientImage(contract(), { ...resolved, snapshotTransfer: smaller }));
});

test('all six source caps are checked against target contract before begin, including fixed native caps', async () => {
  const target = { mode: 'official', compatibility: 'verified', revision: 'a'.repeat(40),
    image: `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`,
    snapshotEnvelopeReadVersions: [1, 2], snapshotTransfer: contract() };
  for (const key of Object.keys(limits)) {
    const source = contract(); source.limits[key] += 1;
    if (key === 'maxUncompressedBytes') {
      source.limits.maxArchiveBytes = source.limits.maxUncompressedBytes + source.limits.maxManifestBytes;
      source.limits.maxEncryptedBytes = encryptedSizeLimit(source.limits.maxArchiveBytes);
    }
    const f = captureFixture();
    assert.throws(() => assertRecipientImage(source, target));
    assert.equal(f.requests.length, 0);
  }
});

test('constructed and observed v2 Machine/secret overrides cannot invalidate image default bounds', () => {
  const command = ['node', 'synthetic-worker.mjs'];
  const config = { env: { NODE_ENV: 'production' }, init: { cmd: command }, guest: {} };
  assertRecipientMachine(config, command);
  assertRecipientMachine({ ...config, init: { cmd: ['sleep', 'infinity'] } }, command, { idleAllowed: true });
  for (const altered of [{ ...config, env: { FLUJO_SNAPSHOT_MAX_BYTES: '1073741824' } },
    { ...config, env: { FLUJO_SNAPSHOT_MAX_FILE_BYTES: '1' } }, { ...config, env: [] },
    { ...config, Env: [] }, { ...config, processes: [{ env: { FLUJO_SNAPSHOT_MAX_BYTES: '1' } }] },
    { ...config, containers: [{}] }, { ...config, files: [{}] },
    { ...config, init: { cmd: command, exec: ['replacement'] } },
    { ...config, init: { cmd: ['sleep', 'infinity'] } }, { ...config, guest: { kernel_args: ['env'] } }]) {
    assert.throws(() => assertRecipientMachine(altered, command));
  }
  assertRecipientSecretNames(['FLUJO_WORKER_SNAPSHOT_KEY', 'FLUJO_SNAPSHOT_CONTROL_TOKEN']);
  for (const names of [['FLUJO_SNAPSHOT_MAX_BYTES'], ['FLUJO_SNAPSHOT_MAX_FILE_BYTES'], [null], {}]) {
    assert.throws(() => assertRecipientSecretNames(names));
  }
  assert.throws(() => recipientImageContract('{}', { Env: [] }));
});

test('v2 authenticates exact AAD and closed canonical bytes with generic parser/crypto failures', () => {
  const key = Buffer.alloc(32, 7);
  verifyRecipientEnvelope(envelope(key), key, 1024);
  const variants = [envelope(key, { version: 1 }), envelope(key, { aad: 'wrong' }), Buffer.from('raw ZIP'),
    Buffer.from('synthetic_secret_marker_invalid_json'), envelope(Buffer.alloc(32, 8)),
    Buffer.from(JSON.stringify({ ...JSON.parse(envelope(key)), extra: true }))];
  const invalidTag = JSON.parse(envelope(key)); invalidTag.tag = Buffer.alloc(16).toString('base64');
  variants.push(Buffer.from(JSON.stringify(invalidTag)));
  for (const bytes of variants) assert.throws(() => verifyRecipientEnvelope(bytes, key, 1024), error => {
    assert.equal(error.message.includes('synthetic_secret_marker'), false); return /authentication failed/.test(error.message);
  });
  assert.throws(() => verifyRecipientEnvelope(envelope(key, { bytes: Buffer.alloc(1025) }), key, 1024));
  const noncanonical = JSON.parse(envelope(key)); noncanonical.iv = noncanonical.iv.replace(/\+/g, '-').replace(/\//g, '_') + '=';
  assert.throws(() => verifyRecipientEnvelope(Buffer.from(JSON.stringify(noncanonical)), key, 1024));
});

test('full workspace v2 capture retains key before begin and returns the identical native wire bytes/hash', async () => {
  const f = captureFixture();
  const result = await f.run();
  assert.deepEqual(result.bytes, f.wireBytes());
  assert.equal(result.sha256, sha256(f.wireBytes()));
  assert.equal(result.encryptionVersion, 2);
  assert.deepEqual(result.key, f.retainedKey());
  assert.notEqual(result.sha256, sha256(plaintext));
  const parsed = JSON.parse(result.bytes);
  const decipher = createDecipheriv('aes-256-gcm', result.key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAAD(Buffer.from(capability.v2Aad)); decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]), plaintext);
  result.key.fill(0);
  assert.equal(f.requests.filter(r => r.endpoint.endsWith('/begin')).length, 1);
});

test('v2 prebegin contract and private retention refusal cause zero snapshot requests', async () => {
  const f = captureFixture({ failRetention: true });
  await assert.rejects(f.run(), /private retention/);
  assert.equal(f.requests.length, 0);
  const g = captureFixture();
  await assert.rejects(g.run({ onRecipientKey: undefined }), /retention callback/);
  await assert.rejects(g.run({ transfer: { ...contract(), encryptionVersion: 1 } }));
  assert.equal(g.requests.length, 0);
});

test('begin/status/version/type/hash/size mismatches abort once and never finalize or retry', async () => {
  for (const options of [{ initial: { workspace: 'other' } }, { initial: { encryptionVersion: 1 } },
    { status: { encryptionVersion: 1 } }, { status: { workspace: 'other' } }, { status: { state: 'unknown' } },
    { status: { sha256: 'a'.repeat(64) } }, { status: { archiveBytes: 0 } },
    { transformDownload: response => { response.headers.set('content-type', 'application/zip'); return response; } },
    { transformDownload: response => { response.headers.set('content-length', '1'); return response; } },
    { wire: key => envelope(key, { aad: 'wrong' }) }, { wire: key => envelope(key, { version: 1 }) },
    { wire: key => envelope(key, { bytes: Buffer.alloc(1025) }) }]) {
    const f = captureFixture(options);
    await assert.rejects(f.run());
    assert.equal(f.requests.filter(r => r.endpoint.endsWith('/begin')).length, 1);
    assert.equal(f.requests.filter(r => r.endpoint.endsWith('/abort')).length, 1);
    assert.equal(f.requests.filter(r => r.endpoint.endsWith('/finalize')).length, 0);
  }
});

test('changed wire JSON bytes are rejected even when parsed envelope values would match', async () => {
  const f = captureFixture({ transformDownload: (response, bytes) => {
    const changed = Buffer.from(` ${bytes.toString()}`);
    response.headers.set('content-length', String(bytes.length));
    return new Response(changed, { headers: response.headers });
  } });
  await assert.rejects(f.run(), /SHA-256/);
});

test('v2 always requires terminal version/session/workspace ACK even without clone callback', async () => {
  for (const final of [{ encryptionVersion: 1 }, { sessionId: 'other' }, { workspace: 'other' },
    { state: 'ready' }, new Response('synthetic_secret_marker_invalid_json')]) {
    const f = captureFixture({ final });
    await assert.rejects(f.run(), error => !error.message.includes('synthetic_secret_marker'));
    assert.equal(f.requests.filter(r => r.endpoint.endsWith('/abort')).length, 1);
  }
});

test('lost begin identity and finalized-but-unconfirmed abort preserve explicit cleanup unknown and original cause', async () => {
  for (const options of [{ initial: { sessionId: 'invalid' } }, { throwBegin: true },
    { final: { sessionId: 'other' }, abort: new Response('finalized', { status: 409 }) },
    { final: { state: 'ready' }, abort: { encryptionVersion: 1 } }]) {
    const f = captureFixture(options);
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 'SNAPSHOT_CLEANUP_UNKNOWN');
      assert.ok(error.cause);
      assert.equal(error.message.includes('synthetic_secret_marker'), false);
      assert.equal(error.cause.message.includes('synthetic_secret_marker'), false);
      return true;
    });
    assert.equal(f.requests.filter(r => r.endpoint.endsWith('/begin')).length, 1);
  }
});

test('v2 source cleanup callback does not hide the explicit unknown code needed by the target fence', async () => {
  const f = captureFixture({ throwBegin: true }); let observed;
  await assert.rejects(f.run({ onCleanupUncertain: error => { observed = error; } }), error => {
    assert.equal(error.code, 'SNAPSHOT_CLEANUP_UNKNOWN'); assert.equal(error.cleanupCause, observed);
    assert.equal(error.cause.message, 'Encrypted snapshot request failed. Transport details are withheld.');
    return true;
  });
  assert.equal(observed.code, 'SNAPSHOT_CLEANUP_UNKNOWN');
  assert.equal(f.requests.filter(r => r.endpoint.endsWith('/begin')).length, 1);
  assert.equal(f.requests.filter(r => r.endpoint.endsWith('/abort')).length, 0);
});

test('private v2 key recovery record precedes entry, is owner-bound and never replaces existing material', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-transfer-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith('flujo-transfer-test-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'worker.journal.json');
  await ensurePrivateDirectory(directory);
  const record = { owner: sessionId, app: 'synthetic-transfer-worker', workspace,
    image: `ghcr.io/example/flujo@sha256:${'a'.repeat(64)}` };
  const key = Buffer.alloc(32, 7);
  await retainRecipientKey(filename, record, key);
  const target = `${filename}.snapshot-key-v2/recipient-key.json`;
  const before = await fs.readFile(target);
  const saved = await readPrivateJson(target);
  assert.equal(saved.key, key.toString('base64'));
  assert.equal(saved.journalOwner, record.owner);
  assert.equal(saved.aad, capability.v2Aad);
  await assert.rejects(retainRecipientKey(filename, record, Buffer.alloc(32, 8)));
  assert.deepEqual(await fs.readFile(target), before);
});

test('linked journal parent refuses before creating an outside sidecar or entering snapshot begin', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-transfer-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith('flujo-transfer-test-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const outside = path.join(directory, 'outside-owned-fixture');
  await fs.mkdir(outside);
  await ensurePrivateDirectory(outside);
  const linked = path.join(directory, 'linked');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const filename = path.join(linked, 'worker.journal.json');
  const f = captureFixture();
  await assert.rejects(f.run({ onRecipientKey: key => retainRecipientKey(filename, {
    owner: sessionId, app: 'synthetic-transfer-worker', workspace,
    image: `ghcr.io/mario-andreschak/flujo@sha256:${'a'.repeat(64)}`,
  }, key, 'dd21cf12-29d0-4f5c-8b6a-f7248809a1df') }), /Private storage/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('ordinary selected-flow v2 capture retains selection while recipient key remains independently generated', async () => {
  const selectedFlows = ['synthetic-selected-flow'];
  const f = captureFixture({ selectedFlows });
  const result = await f.run({ scope: 'selected-flows', flowIds: selectedFlows });
  assert.equal(result.encryptionVersion, 2);
  assert.deepEqual(result.bytes, f.wireBytes());
  assert.equal(result.sha256, sha256(f.wireBytes()));
  assert.deepEqual(JSON.parse(f.requests[0].init.body).flowIds, selectedFlows);
  result.key.fill(0);
});

test('negotiated v2 without a private spool is refused before retention or requests', async () => {
  const f = captureFixture();
  await assert.rejects(f.run({ outputPath: undefined }), /private spool/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.events.length, 0);
});
