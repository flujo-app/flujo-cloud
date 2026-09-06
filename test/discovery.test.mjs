import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomUUID } from 'node:crypto';
import { discoverSources } from '../lib/discovery.mjs';
import { ensurePrivateDirectory, writePrivateJson } from '../lib/private-files.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-discovery-test-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('flujo-discovery-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = await ensurePrivateDirectory(path.join(root, 'instances'));
  const records = [];
  async function add(port = 4200) {
    const record = { format: 'flujo-local-instance', version: 1, instanceId: randomUUID(), pid: process.pid,
      origin: `http://127.0.0.1:${port}`, appRoot: root, dataRoot: path.join(root, 'data'),
      token: `synthetic-instance-token-${randomUUID()}` };
    await writePrivateJson(path.join(directory, `${record.instanceId}.json`), record, { exclusive: true });
    records.push(record);
    return record;
  }
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'GET');
    const record = records.find((value) => value.origin === url.origin);
    assert.ok(record);
    const nonce = url.searchParams.get('nonce');
    assert.match(nonce, /^[a-f0-9]{64}$/);
    const proof = createHmac('sha256', record.token)
      .update(`flujo-local-instance:v1\n${nonce}\n${record.instanceId}\n${record.origin}`).digest('base64url');
    return Response.json({ format: 'flujo-local-instance-proof', version: 1, nonce,
      instanceId: record.instanceId, origin: record.origin, proof });
  };
  return { root, directory, records, calls, add, fetchImpl };
}

test('discovery proves possession before returning internal credentials and keeps status serialization safe', async (t) => {
  const state = await fixture(t);
  const record = await state.add();
  const candidates = await discoverSources(state);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, record.origin);
  assert.equal(candidates[0].token, record.token);
  assert.equal(candidates[0].instanceId, record.instanceId);
  assert.ok(!JSON.stringify(candidates).includes(record.token));
  assert.equal({ ...candidates[0] }.token, undefined);
  assert.ok(!String(state.calls[0].url).includes(record.token));
});

test('inventory retains multiple proven sources and an explicit origin filters without guessing', async (t) => {
  const state = await fixture(t);
  await state.add(4200);
  await state.add(4210);
  assert.equal((await discoverSources(state)).length, 2);
  const filtered = await discoverSources({ ...state, source: 'http://127.0.0.1:4210' });
  assert.deepEqual(filtered.map((value) => value.source), ['http://127.0.0.1:4210']);
});

test('wrong proofs, replayed nonces, changed identities, redirects, and unreachable sources never return a token', async (t) => {
  const state = await fixture(t);
  const record = await state.add();
  for (const mutation of [
    (body) => ({ ...body, proof: 'x'.repeat(43) }),
    (body) => ({ ...body, nonce: '0'.repeat(64) }),
    (body) => ({ ...body, instanceId: randomUUID() }),
    (body) => ({ ...body, origin: 'http://127.0.0.1:4210' }),
  ]) {
    const candidates = await discoverSources({ ...state, fetchImpl: async (url, init) =>
      Response.json(mutation(await (await state.fetchImpl(url, init)).json())) });
    assert.deepEqual(candidates, []);
  }
  assert.deepEqual(await discoverSources({ ...state, fetchImpl: async () => { throw new Error(record.token); } }), []);
  assert.deepEqual(await discoverSources({ ...state, fetchImpl: async () => Response.redirect('https://example.invalid') }), []);
});

test('unsafe, malformed, and mismatched records are ignored without contacting advertised origins', async (t) => {
  const state = await fixture(t);
  const record = await state.add();
  await writePrivateJson(path.join(state.directory, `${record.instanceId}.json`), { ...record, origin: 'https://example.invalid' });
  let calls = 0;
  assert.deepEqual(await discoverSources({ ...state, fetchImpl: async () => { calls += 1; throw new Error('Unexpected request'); } }), []);
  assert.equal(calls, 0);
  await writePrivateJson(path.join(state.directory, `${record.instanceId}.json`), { ...record, instanceId: randomUUID() });
  assert.deepEqual(await discoverSources({ ...state, fetchImpl: async () => { calls += 1; throw new Error('Unexpected request'); } }), []);
  assert.equal(calls, 0);
});

test('missing registries return an empty inventory and non-loopback selections are rejected', async (t) => {
  const state = await fixture(t);
  assert.deepEqual(await discoverSources({ directory: path.join(state.root, 'missing') }), []);
  await assert.rejects(discoverSources({ directory: state.directory, source: 'https://example.invalid' }), /loopback/);
});

test('more than 128 stale records do not hide a live source or trigger stale network requests', async (t) => {
  const state = await fixture(t);
  const live = await state.add();
  const records = new Map([[`${live.instanceId}.json`, live]]);
  for (let index = 0; index < 129; index += 1) {
    const record = { ...live, instanceId: randomUUID(), pid: 1, origin: `http://127.0.0.1:${4300 + index}` };
    const name = `${record.instanceId}.json`;
    records.set(name, record);
    // No credentials are written: the injected reader supplies synthetic records.
    await fs.writeFile(path.join(state.directory, name), '{}');
  }
  const candidates = await discoverSources({ ...state,
    readRecord: async (filename) => records.get(path.basename(filename)),
    isProcessAlive: (pid) => pid === process.pid });
  assert.deepEqual(candidates.map((candidate) => candidate.instanceId), [live.instanceId]);
  assert.equal(state.calls.length, 1);
});

test('inventory bounds concurrent challenges while still checking all live sources', async (t) => {
  const state = await fixture(t);
  const base = await state.add();
  const records = new Map([[`${base.instanceId}.json`, base]]);
  for (let index = 1; index < 7; index += 1) {
    const record = { ...base, instanceId: randomUUID(), origin: `http://127.0.0.1:${4300 + index}` };
    const name = `${record.instanceId}.json`;
    records.set(name, record);
    state.records.push(record);
    await fs.writeFile(path.join(state.directory, name), '{}');
  }
  let active = 0;
  let peak = 0;
  const candidates = await discoverSources({ ...state,
    readRecord: async (filename) => records.get(path.basename(filename)),
    fetchImpl: async (url, init) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try { return await state.fetchImpl(url, init); } finally { active -= 1; }
    } });
  assert.equal(candidates.length, 7);
  assert.equal(state.calls.length, 7);
  assert.equal(peak, 4);
});
