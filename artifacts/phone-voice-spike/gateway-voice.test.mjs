import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createVoiceTranscriber, readVoiceRequest, voiceErrorBody, VOICE_MODEL, VOICE_LIMITS } from './gateway-voice.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'fictional-private-stt-token-for-fixtures';
const clip = () => Buffer.from('fictional-audio-payload');
const input = (id = ID) => ({ requestId: id, contentType: 'audio/wav', audio: clip() });
const result = (id = ID) => ({ format: 'o-private-stt', version: 1, requestId: id, transcript: 'Review this draft.', languageDetected: 'en', durationSeconds: 2, model: { ...VOICE_MODEL }, replayAllowed: false });
const response = (value = result(), status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function fixture(t, fetchImpl, extra = {}) {
  // Hosted Windows can report a short-name temp alias. Production requires a
  // canonical private root, so establish that precondition in the fixture.
  const tempParent = await fs.realpath(os.tmpdir());
  const prefix = 'o-voice-fake-';
  const root = await fs.mkdtemp(path.join(tempParent, prefix));
  t.after(async () => {
    const resolved = path.resolve(root), actual = await fs.realpath(root);
    assert.equal(path.dirname(resolved), tempParent);
    assert.equal(path.dirname(actual), tempParent);
    assert.ok(path.basename(resolved).startsWith(prefix) && path.basename(resolved).length > prefix.length);
    assert.equal(actual, resolved);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const config = { sttOrigin: 'https://stt.example.invalid', sttToken: TOKEN, journalDir: path.join(root, 'journal'), fetchImpl, ...extra };
  return { config, client: await createVoiceTranscriber(config) };
}
const isError = (code, state) => error => error.code === code && (!state || error.state === state);

test('canonical fixture root is admitted; unresolved private-root alias remains held before transport', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  assert.equal(await fs.realpath(f.config.journalDir), f.config.journalDir);
  assert.equal(f.client.status().held, false);
  const alias = path.join(path.dirname(f.config.journalDir), 'journal-alias');
  const realpath = fs.realpath;
  // Simulate only this path's identity mismatch; do not create a Windows alias,
  // symlink, network endpoint, or another filesystem root.
  fs.realpath = async (filename, ...rest) => path.resolve(filename) === alias
    ? f.config.journalDir : realpath(filename, ...rest);
  try {
    const held = await createVoiceTranscriber({ ...f.config, journalDir: alias });
    assert.equal(held.status().held, true);
    await assert.rejects(held.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
    assert.deepEqual(await fs.readdir(alias), []);
    assert.equal(calls, 0);
  } finally { fs.realpath = realpath; }
  assert.equal((await createVoiceTranscriber(f.config)).status().held, false);
});

test('intent is durable before sole authenticated POST; input copied; journal contains no raw audio or token', async t => {
  let calls = 0, config; const original = input(); const originalHash = createHash('sha256').update(original.audio).digest('hex');
  const f = await fixture(t, async (url, options) => {
    calls++; assert.equal(url, 'https://stt.example.invalid/transcribe');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.headers['X-O-Voice-Request-Id'], ID); assert.equal(options.headers['Content-Type'], 'audio/wav');
    assert.equal(Buffer.from(options.body).toString(), clip().toString());
    const entry = JSON.parse(await fs.readFile(path.join(config.journalDir, ID + '.entered.json'), 'utf8'));
    assert.equal(entry.state, 'ENTERED'); assert.equal(entry.sha256, originalHash);
    return response();
  }); config = f.config;
  const pending = f.client.transcribe(original); original.audio.fill(0);
  assert.deepEqual(await pending, result()); assert.equal(calls, 1);
  const files = await fs.readdir(config.journalDir); assert.equal(files.length, 2);
  for (const file of files) { const wire = await fs.readFile(path.join(config.journalDir, file), 'utf8'); assert.ok(!wire.includes(clip().toString())); assert.ok(!wire.includes(TOKEN)); }
  assert.equal(f.client.status().held, false);
});

test('completed same-ID is cached across restart; conflicting bytes cannot invoke another inference', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return response(); });
  await f.client.transcribe(input()); const returned = await f.client.transcribe(input()); returned.transcript = 'Mutated caller output';
  assert.deepEqual(await f.client.transcribe(input()), result());
  const restarted = await createVoiceTranscriber(f.config); assert.deepEqual(await restarted.transcribe(input()), result());
  await assert.rejects(restarted.transcribe({ ...input(), audio: Buffer.from('different') }), isError('VOICE_REQUEST_ID_COLLISION', 'REJECTED'));
  assert.equal(calls, 1);
});

test('all input refusals occur before transport and intent creation', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return response(); });
  for (const bad of [
    { ...input(), requestId: 'not-a-uuid' }, { ...input(), requestId: ID.toUpperCase().replace('4111', '5111') },
    { ...input(), audio: Buffer.alloc(0) }, { ...input(), audio: Buffer.alloc(VOICE_LIMITS.bytes + 1) },
    { ...input(), contentType: 'text/html' }, { ...input(), contentType: 'audio/wav\r\nsecret' }, { ...input(), unexpected: true },
  ]) await assert.rejects(f.client.transcribe(bad), error => error.state === 'REJECTED');
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(f.config.journalDir), []);
});

test('raw upload bounds chunks/length/MIME and supports WAV plus browser formats', async () => {
  for (const mime of ['audio/wav', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4']) {
    const req = Readable.from([Buffer.from('one'), Buffer.from('two')]);
    req.headers = { 'x-o-voice-request-id': ID, 'content-type': mime, 'content-length': '6' };
    const value = await readVoiceRequest(req); assert.equal(value.contentType, mime.split(';')[0]); assert.equal(value.audio.toString(), 'onetwo');
  }
  const req = Readable.from([Buffer.alloc(VOICE_LIMITS.bytes), Buffer.from('x')]); req.headers = { 'x-o-voice-request-id': ID, 'content-type': 'audio/wav' };
  await assert.rejects(readVoiceRequest(req), isError('VOICE_AUDIO_TOO_LARGE', 'REJECTED'));
  const incomplete = Readable.from([Buffer.from('one')]); incomplete.headers = { 'x-o-voice-request-id': ID, 'content-type': 'audio/wav', 'content-length': '4' };
  await assert.rejects(readVoiceRequest(incomplete), isError('VOICE_UPLOAD_INCOMPLETE', 'REJECTED'));
});

test('single active lane refuses a concurrent different-ID transport', async t => {
  let release, entered; const observed = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.client.transcribe(input()); await observed;
  await assert.rejects(f.client.transcribe(input(NEXT)), isError('VOICE_ALREADY_RUNNING', 'REJECTED'));
  release(response()); await pending; assert.equal(f.client.status().records, 1);
});

test('transport failure is UNKNOWN and blocks fresh IDs after restart without any repeat POST', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; throw new Error(TOKEN); });
  await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
  await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
  const restarted = await createVoiceTranscriber(f.config);
  await assert.rejects(restarted.transcribe(input(NEXT)), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
  assert.equal(calls, 1); assert.equal(restarted.status().held, true);
  assert.ok(!JSON.stringify(voiceErrorBody(new Error(TOKEN))).includes(TOKEN));
});

test('unanswered fetch and stalled response body both expire to UNKNOWN', async t => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const f = await fixture(t, fetchImpl, { timeoutMs: 15 });
    await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
    assert.equal(f.client.status().held, true); assert.equal(f.client.status().activeRequestId, null);
  }
});

test('only explicit protocol REJECTED refusals permit a fresh subsequent request', async t => {
  let calls = 0; const f = await fixture(t, async () => ++calls === 1
    ? response({ format: 'o-private-stt-error', version: 1, requestId: ID, code: 'AUDIO_INVALID', state: 'REJECTED', replayAllowed: false }, 422)
    : response(result(NEXT)));
  await assert.rejects(f.client.transcribe(input()), isError('VOICE_TRANSCRIPTION_REFUSED', 'REJECTED'));
  assert.equal(f.client.status().held, false); assert.deepEqual(await f.client.transcribe(input(NEXT)), result(NEXT));
  await assert.rejects(f.client.transcribe(input()), isError('VOICE_REQUEST_ALREADY_REJECTED', 'REJECTED'));
  assert.equal(calls, 2);
});

test('server uncertainty or malformed refusal cannot become a known rejection', async t => {
  for (const reply of [response({ state: 'UNKNOWN' }, 409), response({ state: 'UNKNOWN' }, 503), response({ error: 'anything' }, 422)]) {
    const f = await fixture(t, async () => reply);
    await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
    assert.equal(f.client.status().held, true);
  }
});

test('response identity, pinned model, duration, transcript and body bounds fail closed', async t => {
  const variants = [
    { ...result(), requestId: NEXT }, { ...result(), replayAllowed: true }, { ...result(), durationSeconds: 31 },
    { ...result(), transcript: 'x'.repeat(4097) }, { ...result(), model: { ...VOICE_MODEL, revision: 'mutable-main' } },
    { ...result(), extra: true }, { ...result(), languageDetected: 'private arbitrary text' },
  ];
  for (const value of variants) {
    const f = await fixture(t, async () => response(value));
    await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
  }
  for (const value of [new Response('x'.repeat(VOICE_LIMITS.responseBytes + 1)), new Response(Uint8Array.of(0xff)), new Response('{}', { headers: { 'Content-Length': '9999999' } })]) {
    const f = await fixture(t, async () => value); await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
  }
});

test('raw and JSON-escaped token reflections never become a transcript or stored terminal result', async t => {
  for (const token of [TOKEN, 'fictional-quote-"-slash-\\-token-for-fixtures']) {
    const f = await fixture(t, async () => response({ ...result(), transcript: token }), { sttToken: token });
    await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
    const wire = await fs.readFile(path.join(f.config.journalDir, ID + '.terminal.json'), 'utf8');
    assert.ok(!wire.includes(token)); assert.ok(!wire.includes(JSON.stringify(token).slice(1, -1)));
  }
});

test('unclosed intent, corrupt file and unexpected storage entries hold fresh dispatch', async t => {
  const f = await fixture(t, async () => response()); await f.client.transcribe(input());
  await fs.unlink(path.join(f.config.journalDir, ID + '.terminal.json'));
  const unclosed = await createVoiceTranscriber(f.config); assert.equal(unclosed.status().held, true);
  await assert.rejects(unclosed.transcribe(input(NEXT)), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION'));
  await fs.writeFile(path.join(f.config.journalDir, ID + '.entered.json'), '{');
  assert.equal((await createVoiceTranscriber(f.config)).status().held, true);
  await fs.writeFile(path.join(f.config.journalDir, 'unexpected'), 'fictional');
  assert.equal((await createVoiceTranscriber(f.config)).status().held, true);
});

test('post-write close failure stays UNKNOWN; restart requires successful saved-terminal resync', async t => {
  let calls = 0; const f = await fixture(t, async (_, options) => { calls++; return response(result(options.headers['X-O-Voice-Request-Id'])); });
  const open = fs.open; t.after(() => { fs.open = open; }); let failedWriteClose = false;
  fs.open = async (file, flags, ...rest) => {
    const handle = await open(file, flags, ...rest);
    if (String(file).endsWith('.terminal.json') && flags === 'wx' && !failedWriteClose) return new Proxy(handle, {
      get(target, key) {
        if (key === 'close') return async () => { await target.close(); failedWriteClose = true; throw new Error('fictional-close-failure'); };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      },
    });
    return handle;
  };
  await assert.rejects(f.client.transcribe(input()), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 'UNKNOWN'));
  assert.equal(f.client.status().held, true); assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.config.journalDir, ID + '.terminal.json'), 'utf8')).state, 'COMPLETED');
  fs.open = async (file, flags, ...rest) => {
    const handle = await open(file, flags, ...rest);
    if (String(file).endsWith('.terminal.json') && typeof flags === 'number') return new Proxy(handle, {
      get(target, key) {
        if (key === 'sync') return async () => { throw new Error('fictional-resync-failure'); };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      },
    });
    return handle;
  };
  const heldRestart = await createVoiceTranscriber(f.config); assert.equal(heldRestart.status().held, true);
  await assert.rejects(heldRestart.transcribe(input(NEXT)), isError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION'));
  assert.equal(calls, 1);
  fs.open = open;
  const reconciled = await createVoiceTranscriber(f.config); assert.equal(reconciled.status().held, false);
  assert.equal(reconciled.status().reconciledSavedTerminals, 1);
  assert.deepEqual(await reconciled.transcribe(input()), result()); assert.equal(calls, 1);
  await reconciled.transcribe(input(NEXT)); assert.equal(calls, 2);
});
