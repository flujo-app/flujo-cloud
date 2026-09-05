import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensurePrivateDirectory, assertPrivateDirectory, readPrivateJson, writePrivateJson } from '../lib/private-files.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-private-files-test-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('flujo-private-files-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = await ensurePrivateDirectory(path.join(root, 'private'));
  return { root, directory, filename: path.join(directory, 'synthetic.json') };
}

test('private JSON round-trips with real OS protection, atomic replacement, and exclusive refusal', async (t) => {
  const state = await fixture(t);
  await writePrivateJson(state.filename, { token: 'synthetic-private-token' }, { exclusive: true });
  await assertPrivateDirectory(state.directory);
  assert.deepEqual(await readPrivateJson(state.filename), { token: 'synthetic-private-token' });
  await assert.rejects(writePrivateJson(state.filename, { token: 'replacement' }, { exclusive: true }), { code: 'EEXIST' });
  assert.deepEqual(await readPrivateJson(state.filename), { token: 'synthetic-private-token' });
  await writePrivateJson(state.filename, { token: 'rotated-synthetic-token' });
  assert.deepEqual(await readPrivateJson(state.filename), { token: 'rotated-synthetic-token' });
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(state.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(state.filename)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await fs.readdir(state.directory), ['synthetic.json']);
});

test('read rejects broad Unix permissions or Windows ACL grants without echoing file contents', async (t) => {
  const state = await fixture(t);
  const token = 'synthetic-must-not-appear-in-errors';
  await writePrivateJson(state.filename, { token });
  if (process.platform === 'win32') {
    await promisify(execFile)('icacls.exe', [state.filename, '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
  } else await fs.chmod(state.filename, 0o644);
  await assert.rejects(readPrivateJson(state.filename), (error) => /unsafe/.test(error.message) && !error.message.includes(token));
});

test('links, hardlinks, and nonregular destinations fail closed', async (t) => {
  const state = await fixture(t);
  await writePrivateJson(state.filename, { synthetic: true });
  const linkedFile = path.join(state.directory, 'hardlink.json');
  await fs.link(state.filename, linkedFile);
  await assert.rejects(readPrivateJson(state.filename), /unsafe/);
  await assert.rejects(writePrivateJson(linkedFile, {}), /unsafe/);
  const linkedDirectory = path.join(state.root, 'linked');
  await fs.symlink(state.directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensurePrivateDirectory(path.join(linkedDirectory, 'nested')), /unsafe/);
  await assert.rejects(readPrivateJson(path.join(linkedDirectory, 'synthetic.json')), /unsafe/);
  await assert.rejects(writePrivateJson(state.directory, {}), /unsafe/);
});

test('bounded reads and malformed JSON return generic errors', async (t) => {
  const state = await fixture(t);
  await writePrivateJson(state.filename, { token: 'synthetic-oversized-value' });
  await assert.rejects(readPrivateJson(state.filename, { maxBytes: 8 }), /unsafe/);
  await fs.writeFile(state.filename, 'synthetic-not-valid-json');
  await assert.rejects(readPrivateJson(state.filename), (error) => !error.message.includes('synthetic-not-valid-json'));
});
