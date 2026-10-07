import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createCipheriv } from 'node:crypto';
import { encryptSnapshot, sha256 } from '../lib/envelope.mjs';
import { encryptSnapshotFile, encryptSnapshotResponse, verifyEncryptedSnapshotFile, spoolSnapshot } from '../lib/snapshot-file.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cloud-snapshot-stream-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'archive'), key: randomBytes(32), plaintext: randomBytes(190001) };
}

test('bounded v2 verification requires negotiated version, AAD and matching wire digest', async t => {
  const f = await fixture(t);
  const iv = randomBytes(12);
  const make = aad => {
    const cipher = createCipheriv('aes-256-gcm', f.key, iv);
    cipher.setAAD(Buffer.from(aad));
    return Buffer.from(JSON.stringify({ format: 'flujo-workspace-encrypted', version: 2,
      iv: iv.toString('base64'), data: Buffer.concat([cipher.update(f.plaintext), cipher.final()]).toString('base64'),
      tag: cipher.getAuthTag().toString('base64') }));
  };
  const wire = make('flujo:workspace-snapshot:v2');
  await fs.writeFile(f.file, wire);
  const verified = await verifyEncryptedSnapshotFile(f.file, f.key, undefined, f.plaintext.length, sha256(wire), { version: 2 });
  assert.equal(verified.plaintextSha256, sha256(f.plaintext));
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, sha256(f.plaintext), f.plaintext.length, sha256(wire)), /framing/);
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, undefined, f.plaintext.length, '0'.repeat(64), { version: 2 }), /wire digest/);
  await fs.writeFile(f.file, make('incorrect-aad'));
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, undefined, f.plaintext.length, undefined, { version: 2 }));
});

test('bounded legacy encryption and both v1 tag orders authenticate the exact archive', async t => {
  const f = await fixture(t);
  const source = path.join(f.directory, 'plain');
  await fs.writeFile(source, f.plaintext);
  const result = await encryptSnapshotFile(source, f.file, f.key, f.plaintext.length);
  assert.equal(result.plaintextSha256, sha256(f.plaintext));
  assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, result.plaintextSha256, f.plaintext.length)).plaintextBytes, f.plaintext.length);
  const legacy = encryptSnapshot(f.plaintext, f.key);
  await fs.writeFile(f.file, legacy.envelope);
  assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, legacy.sha256, f.plaintext.length)).plaintextBytes, f.plaintext.length);
  const envelope = JSON.parse(legacy.envelope);
  await fs.writeFile(f.file, JSON.stringify({ data: envelope.data, tag: envelope.tag, version: 1, iv: envelope.iv, format: envelope.format }));
  assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, legacy.sha256, f.plaintext.length)).plaintextBytes, f.plaintext.length);
});

test('duplicate decoded field names and unknown fields are rejected without collapsing them', async t => {
  const f = await fixture(t);
  f.plaintext = f.plaintext.subarray(0, 123);
  const original = encryptSnapshot(f.plaintext, f.key);
  const value = JSON.parse(original.envelope);
  for (const name of ['iv', 'tag', 'format', 'version', 'data']) {
    await fs.writeFile(f.file, original.envelope.toString().replace('{', '{' + JSON.stringify(name) + ':' + JSON.stringify(value[name]) + ','));
    await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, original.sha256, f.plaintext.length), /framing/);
  }
  await fs.writeFile(f.file, original.envelope.toString().replace('"data"', '"da\\u0074a"'));
  assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, original.sha256, f.plaintext.length)).plaintextBytes, f.plaintext.length);
  await fs.writeFile(f.file, original.envelope.toString().replace('{', '{"i\\u0076":' + JSON.stringify(value.iv) + ','));
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, original.sha256, f.plaintext.length), /framing/);
  await fs.writeFile(f.file, original.envelope.toString().replace('"format":', '"unknown":'));
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, original.sha256, f.plaintext.length), /framing/);
});

test('wrong recipient, altered ciphertext, wrong plaintext hash, and expansion bounds fail closed', async t => {
  const f = await fixture(t), original = encryptSnapshot(f.plaintext, f.key);
  await fs.writeFile(f.file, original.envelope);
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, randomBytes(32), original.sha256, f.plaintext.length));
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, '0'.repeat(64), f.plaintext.length), /plaintext/);
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, original.sha256, f.plaintext.length - 1), /size limit/);
  const envelope = JSON.parse(original.envelope), bytes = Buffer.from(envelope.data, 'base64'); bytes[0] ^= 1;
  envelope.data = bytes.toString('base64'); await fs.writeFile(f.file, JSON.stringify(envelope));
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, original.sha256, f.plaintext.length));
});

test('spool enforces transport SHA and removes oversized/corrupt partial files', async t => {
  const f = await fixture(t);
  await assert.rejects(spoolSnapshot(new Response(f.plaintext), f.file, f.plaintext.length - 1, sha256(f.plaintext)), /size limit/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await assert.rejects(spoolSnapshot(new Response(f.plaintext), f.file, f.plaintext.length, '0'.repeat(64)), /SHA-256/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const result = await spoolSnapshot(new Response(f.plaintext), f.file, f.plaintext.length, sha256(f.plaintext));
  assert.equal(result.wireSha256, sha256(f.plaintext));
  assert.deepEqual(await fs.readFile(f.file), f.plaintext);
});


test('valid escaped base64 data remains compatible in every v1 field order', async t => {
  const f = await fixture(t), encrypted = encryptSnapshot(f.plaintext, f.key), envelope = JSON.parse(encrypted.envelope);
  for (const order of [envelope, { data: envelope.data, iv: envelope.iv, tag: envelope.tag, format: envelope.format, version: 1 }]) {
    let text = JSON.stringify(order);
    const marker = '\"data\":\"';
    const first = text.indexOf(marker) + marker.length;
    text = text.slice(0, first) + '\\u' + text.charCodeAt(first).toString(16).padStart(4, '0') + text.slice(first + 1);
    await fs.writeFile(f.file, text);
    assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, encrypted.sha256, f.plaintext.length)).plaintextBytes, f.plaintext.length);
  }
});

test('non-JSON whitespace, hardlinks, symlinks, and changed wire digests are rejected', async t => {
  const f = await fixture(t), encrypted = encryptSnapshot(f.plaintext, f.key);
  for (const whitespace of ['\v', '\f']) {
    await fs.writeFile(f.file, whitespace + encrypted.envelope);
    await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, encrypted.sha256, f.plaintext.length), /framing/);
  }
  await fs.writeFile(f.file, encrypted.envelope);
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, encrypted.sha256, f.plaintext.length, '0'.repeat(64)), /wire digest/);
  const link = path.join(f.directory, 'link');
  await fs.link(f.file, link);
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, encrypted.sha256, f.plaintext.length), /single-link/);
  await fs.unlink(link);
  try { await fs.symlink(f.file, link); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; return; }
  await assert.rejects(verifyEncryptedSnapshotFile(link, f.key, encrypted.sha256, f.plaintext.length), /single-link/);
});

test('legacy response encryption writes only ciphertext and rejects unknown encrypted data', async t => {
  const f = await fixture(t), plaintext = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('synthetic-private-archive-sentinel')]);
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of plaintext) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }));
  const result = await encryptSnapshotResponse(response, f.file, f.key, plaintext.length, sha256(plaintext));
  const wire = await fs.readFile(f.file);
  assert.ok(!wire.includes(Buffer.from('synthetic-private-archive-sentinel')));
  assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, sha256(plaintext), plaintext.length, result.wireSha256)).plaintextBytes, plaintext.length);
  await fs.unlink(f.file);
  await assert.rejects(encryptSnapshotResponse(new Response(encryptSnapshot(plaintext).envelope), f.file, f.key, 1024, '0'.repeat(64)), /not a ZIP/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('JSON data escapes across parser/decryption chunk boundaries remain compatible', async t => {
  const f = await fixture(t), encrypted = encryptSnapshot(f.plaintext, f.key);
  const original = encrypted.envelope.toString(), start = original.indexOf('"data":"') + '"data":"'.length;
  for (const index of [65535, start + 65535]) {
    const text = original.slice(0, index) + '\\u' + original.charCodeAt(index).toString(16).padStart(4, '0') + original.slice(index + 1);
    await fs.writeFile(f.file, text);
    assert.equal((await verifyEncryptedSnapshotFile(f.file, f.key, encrypted.sha256, f.plaintext.length)).plaintextBytes, f.plaintext.length);
  }
});

test('replacement between named identity check and descriptor open is rejected', async t => {
  const f = await fixture(t), encrypted = encryptSnapshot(f.plaintext, f.key);
  await fs.writeFile(f.file, encrypted.envelope);
  const original = fs.lstat.bind(fs); let replaced = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    const result = await original(...args);
    if (args[0] === f.file && !replaced) {
      replaced = true; await fs.rename(f.file, f.file + '.original'); await fs.writeFile(f.file, encrypted.envelope);
    }
    return result;
  });
  await assert.rejects(verifyEncryptedSnapshotFile(f.file, f.key, encrypted.sha256, f.plaintext.length), /identity changed/);
});
