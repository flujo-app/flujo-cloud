import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserVoiceController, mountBrowserVoice, VOICE_LIMITS, VOICE_STORAGE_KEY } from './browser-voice.mjs';

// All interfaces below are fakes. No media, HTTP, filesystem, native browser or timers are used.
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const stream = () => { const tracks = [{ stops: 0, stop() { this.stops += 1; } }, { stops: 0, stop() { this.stops += 1; } }]; return { tracks, getTracks: () => tracks }; };
function storage(initial) {
  const values = new Map(initial ? [[VOICE_STORAGE_KEY, initial]] : []), writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(value); values.set(key, value); }, removeItem: key => values.delete(key) };
}
function clock() {
  let now = 0, next = 0; const tasks = new Map();
  return { tasks, now: () => now, setTimeout(fn, ms) { const id = ++next; tasks.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => tasks.delete(id), advance(ms) { now += ms; for (const [id, task] of [...tasks]) if (task.at <= now) { tasks.delete(id); task.fn(); } } };
}
const result = (id, transcript = 'Review this draft.') => ({ format: 'o-private-stt', version: 1, requestId: id,
  transcript, languageDetected: 'en', durationSeconds: 2, model: { repository: 'fictional/stt-small', revision: 'a'.repeat(40), computeType: 'int8' }, replayAllowed: false });
function response(value, status = 200, options = {}) {
  const bytes = options.bytes ?? new TextEncoder().encode(JSON.stringify(value));
  const calls = { cancelled: 0, released: 0 }; let sent = false;
  return { calls, status, headers: { get: key => key === 'content-type' ? options.contentType ?? 'application/json'
    : key === 'content-length' ? options.length ?? null : null },
  body: { cancel() { calls.cancelled += 1; }, getReader() { return { read: async () => sent ? { done: true }
    : (sent = true, { done: false, value: bytes }), cancel() { calls.cancelled += 1; }, releaseLock() { calls.released += 1; } }; } } };
}
function fixture(extra = {}) {
  const media = [], recordings = [], calls = [], store = extra.storage ?? storage(), timers = extra.timers ?? clock();
  const supported = extra.types ?? ['audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4'];
  class Recorder {
    static isTypeSupported(type) { return supported.includes(type); }
    constructor(input, options) { this.stream = input; this.mimeType = extra.actualMime ?? options.mimeType; this.state = 'inactive'; recordings.push(this); }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; if (extra.startError) throw new Error('FICTIONAL_PRIVATE_RECORDER_ERROR'); }
    data(size = 8, type = this.mimeType) { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type }) }); }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.onstop?.(); }); }
    error() { this.onerror?.({ error: new Error('FICTIONAL_PRIVATE_MEDIA_ERROR') }); }
  }
  let sequence = 0;
  const options = { MediaRecorder: Recorder, mediaDevices: { async getUserMedia(constraints) {
    assert.deepEqual(constraints, { audio: true }); const value = stream(); media.push(value); return value; } },
    storage: store, timers, cryptoImpl: { randomUUID: () => uuid(++sequence) },
    ...extra.options,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return extra.options?.fetchImpl
      ? await extra.options.fetchImpl(url, init) : response(result(init.headers['X-O-Voice-Request-Id'])); } };
  return { media, recordings, calls, store, timers, options, controller: createBrowserVoiceController(options) };
}
async function recorded(f, bytes = 8) { assert.equal(await f.controller.start(), true); f.recordings.at(-1).data(bytes); f.timers.advance(2000); assert.equal(f.controller.stop(), true); await flush(); assert.equal(f.controller.getSnapshot().state, 'recorded'); }
const held = controller => { assert.equal(controller.getSnapshot().state, 'unknown'); assert.equal(controller.discard(), false); assert.equal(controller.stop(), false); };

test('recording requires explicit start and uses preferred Opus; transcript is a draft without any submit', async () => {
  const f = fixture(); assert.equal(f.media.length, 0); assert.equal(f.calls.length, 0);
  await recorded(f); assert.equal(f.recordings[0].mimeType, 'audio/webm;codecs=opus'); assert.equal(f.recordings[0].timeslice, 250);
  assert.equal(f.media[0].tracks.every(track => track.stops === 1), true);
  assert.equal(await f.controller.transcribe(), true); assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0]; assert.equal(url, '/api/voice/transcribe'); assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['Content-Type'], 'audio/webm');
  assert.equal(init.body instanceof Blob, true); assert.equal(init.body.size, 8);
  assert.equal(f.controller.getSnapshot().state, 'draft'); assert.equal(f.controller.getSnapshot().draft, 'Review this draft.');
  assert.equal(f.controller.getSnapshot().bytes, 0); assert.equal(f.store.values.size, 0);
  assert.equal(await f.controller.transcribe(), false); assert.equal(f.calls.length, 1); f.controller.dispose();
});

test('ogg and mp4 fallbacks retain supported normalized Content-Type without creating WAV', async () => {
  for (const type of ['audio/ogg', 'audio/mp4']) { const f = fixture({ types: [type] }); await recorded(f);
    assert.equal(await f.controller.transcribe(), true); assert.equal(f.calls[0].init.headers['Content-Type'], type); f.controller.dispose(); }
});

test('unsupported recording is honest and never requests microphone permission', async () => {
  const f = fixture({ types: [] }); assert.equal(f.controller.getSnapshot().supported, false);
  assert.equal(f.controller.getSnapshot().code, 'UNSUPPORTED'); assert.equal(await f.controller.start(), false);
  assert.equal(f.media.length, 0); assert.equal(f.calls.length, 0); f.controller.dispose();
});

test('automatic stop has a29-second margin; delayed event beyond30 seconds rejects before transport', async () => {
  for (const elapsed of [29_000, 31_000]) { const f = fixture(); await f.controller.start(); f.recordings[0].data();
    f.timers.advance(elapsed); await flush(); assert.equal(f.media[0].tracks.every(track => track.stops === 1), true);
    assert.equal(f.controller.getSnapshot().state, elapsed === 29_000 ? 'recorded' : 'rejected');
    if (elapsed > 30_000) { assert.equal(f.controller.getSnapshot().code, 'AUDIO_TOO_LONG'); assert.equal(await f.controller.transcribe(), false); }
    assert.equal(f.calls.length, 0); f.controller.dispose(); }
});

test('encoded chunk cap rejects overflow immediately and exact1MiB remains transcribable', async () => {
  const f = fixture(); await f.controller.start(); f.recordings[0].data(VOICE_LIMITS.bytes); f.recordings[0].data(1); await flush();
  assert.equal(f.controller.getSnapshot().state, 'rejected'); assert.equal(f.controller.getSnapshot().code, 'AUDIO_TOO_LARGE');
  assert.equal(f.controller.getSnapshot().bytes, 0); assert.equal(f.media[0].tracks.every(track => track.stops === 1), true); assert.equal(f.calls.length, 0);
  assert.equal(f.controller.discard(), true); await recorded(f, VOICE_LIMITS.bytes); assert.equal(await f.controller.transcribe(), true);
  assert.equal(f.calls[0].init.body.size, VOICE_LIMITS.bytes); f.controller.dispose();
});

test('empty audio, mismatched chunk MIME and recorder failures discard memory and stop all tracks', async () => {
  for (const effect of ['empty', 'mime', 'error']) { const f = fixture(); await f.controller.start();
    if (effect === 'empty') f.controller.stop(); else if (effect === 'mime') f.recordings[0].data(8, 'audio/wav'); else f.recordings[0].error();
    await flush(); assert.equal(f.controller.getSnapshot().state, 'rejected'); assert.equal(f.controller.getSnapshot().bytes, 0);
    assert.equal(f.media[0].tracks.every(track => track.stops >= 1), true); assert.equal(f.calls.length, 0); f.controller.dispose(); }
});

test('discard and dispose fence delayed recorder callbacks and retire microphone tracks', async () => {
  for (const action of ['discard', 'dispose']) { const f = fixture(); await f.controller.start(); f.recordings[0].data();
    f.controller[action](); f.recordings[0].data(); f.recordings[0].error(); await flush();
    assert.equal(f.controller.getSnapshot().bytes, 0); assert.notEqual(f.controller.getSnapshot().state, 'recorded');
    assert.equal(f.media[0].tracks.every(track => track.stops === 1), true); assert.equal(f.calls.length, 0); }
});

test('discard during permission prompt stops late permission success without recording', async () => {
  const pending = deferred(), late = stream(); const f = fixture({ options: { mediaDevices: { getUserMedia: () => pending.promise } } });
  const started = f.controller.start(); assert.equal(f.controller.getSnapshot().acquiring, true); assert.equal(f.controller.discard(), true);
  pending.resolve(late); assert.equal(await started, false); assert.equal(late.tracks.every(track => track.stops === 1), true);
  assert.equal(f.recordings.length, 0); assert.equal(f.controller.getSnapshot().state, 'idle'); f.controller.dispose();
});

test('stale permission rejection cannot cancel a newer successful recording', async () => {
  const old = deferred(), next = deferred(), fresh = stream(); let calls = 0;
  const f = fixture({ options: { mediaDevices: { getUserMedia: () => (++calls === 1 ? old.promise : next.promise) } } });
  const first = f.controller.start(); f.controller.discard(); const second = f.controller.start(); next.resolve(fresh); assert.equal(await second, true);
  old.reject(new Error('FICTIONAL_STALE_PERMISSION_ERROR')); assert.equal(await first, false);
  assert.equal(f.controller.getSnapshot().state, 'recording'); assert.equal(fresh.tracks.every(track => track.stops === 0), true);
  f.controller.dispose(); assert.equal(fresh.tracks.every(track => track.stops === 1), true);
});

test('dispose during permission prompt rejects late success and prevents further starts', async () => {
  const pending = deferred(), late = stream(); const f = fixture({ options: { mediaDevices: { getUserMedia: () => pending.promise } } });
  const first = f.controller.start(); f.controller.dispose(); pending.resolve(late); assert.equal(await first, false);
  assert.equal(late.tracks.every(track => track.stops === 1), true); assert.equal(await f.controller.start(), false);
});

test('pending fence is persisted before the sole POST and includes only ID/state, never audio or transcript', async () => {
  const store = storage(); let count = 0;
  const f = fixture({ storage: store, options: { fetchImpl: async (_url, init) => {
    count += 1; const marker = JSON.parse(store.getItem(VOICE_STORAGE_KEY));
    assert.deepEqual(marker, { requestId: init.headers['X-O-Voice-Request-Id'], state: 'pending' });
    return response(result(marker.requestId, 'PRIVATE_TRANSCRIPT_ONLY_IN_DRAFT')); } } });
  await recorded(f); await f.controller.transcribe(); assert.equal(count, 1);
  assert.equal(store.writes.every(value => Object.keys(JSON.parse(value)).sort().join() === 'requestId,state'), true);
  assert.equal(store.writes.join().includes('PRIVATE_TRANSCRIPT'), false); f.controller.dispose();
});

test('timeout holds request across reload without retry, reset or retranscription', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture({ options: { fetchImpl: () => { count += 1; return pending.promise; }, timeoutMs: 1000 } });
  await recorded(f); const done = f.controller.transcribe(); f.timers.advance(1000); assert.equal(await done, false); held(f.controller);
  assert.equal(await f.controller.start(), false); assert.equal(await f.controller.transcribe(), false); assert.equal(count, 1);
  const reload = fixture({ storage: f.store }); held(reload.controller); assert.equal(reload.controller.getSnapshot().requestId, uuid(1));
  assert.equal(reload.media.length, 0); assert.equal(reload.calls.length, 0); pending.reject(new Error('late rejection')); await flush();
  reload.controller.dispose(); f.controller.dispose();
});

test('lost transport is UNKNOWN and never retries even if the caller invokes transcribe again', async () => {
  let count = 0; const f = fixture({ options: { fetchImpl: async () => { count += 1; throw new Error('FICTIONAL_PRIVATE_NETWORK_ERROR'); } } });
  await recorded(f); assert.equal(await f.controller.transcribe(), false); held(f.controller); assert.equal(await f.controller.transcribe(), false);
  assert.equal(count, 1); assert.equal(f.controller.getSnapshot().code.includes('PRIVATE'), false); f.controller.dispose();
});

test('synchronous transcribing subscriber disposal prevents even the fetch callback from entering', async () => {
  let controller, count = 0;
  const f = fixture({ options: { onChange: value => { if (value.state === 'transcribing') controller.dispose(); },
    fetchImpl: async () => { count += 1; throw new Error('must not enter'); } } }); controller = f.controller;
  await recorded(f); assert.equal(await controller.transcribe(), false); assert.equal(count, 0); held(controller);
  assert.equal(JSON.parse(f.store.getItem(VOICE_STORAGE_KEY)).state, 'unknown');
});

test('timer abortion before fetch entry is honored and leaves an UNKNOWN fence', async () => {
  const timers = clock(), original = timers.setTimeout; let count = 0;
  timers.setTimeout = (fn, ms) => { if (ms === 1000) { fn(); return 99; } return original(fn, ms); };
  const f = fixture({ timers, options: { timeoutMs: 1000, fetchImpl: async () => { count += 1; throw new Error('must not enter'); } } });
  await recorded(f); assert.equal(await f.controller.transcribe(), false); assert.equal(count, 0); held(f.controller); f.controller.dispose();
});

test('dispose after POST entry retains UNKNOWN and cancels a late response without reading it', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture({ options: { fetchImpl: () => { count += 1; return pending.promise; } } });
  await recorded(f); const done = f.controller.transcribe(); assert.equal(await f.controller.transcribe(), false);
  f.controller.dispose(); assert.equal(await done, false);
  const late = response(result(uuid(1))); pending.resolve(late); await flush();
  assert.equal(late.calls.cancelled, 1); assert.equal(late.calls.released, 0); assert.equal(count, 1); held(f.controller);
});

test('fresh successful clips use fresh UUIDs while explicit authentication rejection is not replayed', async () => {
  const requests = []; const f = fixture({ options: { fetchImpl: async (_url, init) => { requests.push(init.headers['X-O-Voice-Request-Id']); return response({}, 401); } } });
  await recorded(f); assert.equal(await f.controller.transcribe(), false); assert.equal(f.controller.getSnapshot().state, 'rejected');
  assert.equal(f.store.values.size, 0); f.controller.discard(); await recorded(f); await f.controller.transcribe();
  assert.deepEqual(requests, [uuid(1), uuid(2)]); f.controller.dispose();
});

test('malformed200, mismatched ID, excessive transcript/duration and altered control fields remain UNKNOWN', async () => {
  const variants = [value => ({ ...value, requestId: uuid(9) }), value => ({ ...value, transcript: 'x'.repeat(4097) }),
    value => ({ ...value, durationSeconds: 31 }), value => ({ ...value, replayAllowed: true }),
    value => ({ ...value, autoSubmit: true }), value => ({ ...value, model: { ...value.model, computeType: 'float32' } }),
    value => ({ ...value, transcript: '' })];
  for (const change of variants) { const f = fixture({ options: { fetchImpl: async (_url, init) => response(change(result(init.headers['X-O-Voice-Request-Id']))) } });
    await recorded(f); assert.equal(await f.controller.transcribe(), false); held(f.controller); assert.equal(f.controller.getSnapshot().draft, ''); f.controller.dispose(); }
  const f = fixture({ options: { fetchImpl: async () => response(null, 200, { bytes: new TextEncoder().encode('{PRIVATE_BODY') }) } });
  await recorded(f); assert.equal(await f.controller.transcribe(), false); held(f.controller); f.controller.dispose();
});

test('bounded response body/type/header refusals cancel unread data and preserve UNKNOWN', async () => {
  for (const opts of [{ contentType: 'text/html' }, { length: String(VOICE_LIMITS.responseBytes + 1) },
    { bytes: new Uint8Array(VOICE_LIMITS.responseBytes + 1) }]) {
    const reply = response(result(uuid(1)), 200, opts); const f = fixture({ options: { fetchImpl: async () => reply } });
    await recorded(f); assert.equal(await f.controller.transcribe(), false); held(f.controller);
    assert.equal(reply.calls.cancelled >= 1, true); f.controller.dispose(); }
});

test('server conflict and5xx remain UNKNOWN rather than assuming no upstream entry', async () => {
  for (const status of [409, 500, 503]) { const f = fixture({ options: { fetchImpl: async () => response({}, status) } });
    await recorded(f); assert.equal(await f.controller.transcribe(), false); held(f.controller); f.controller.dispose(); }
});

test('pending/unknown/malformed saved markers cannot silently resume or reset a voice request', async () => {
  for (const marker of [JSON.stringify({ requestId: uuid(8), state: 'pending' }), JSON.stringify({ requestId: uuid(8), state: 'unknown' }),
    'PRIVATE_MALFORMED', JSON.stringify({ requestId: { private: true }, state: 'pending' })]) {
    const f = fixture({ storage: storage(marker) }); held(f.controller); assert.equal(await f.controller.start(), false);
    assert.equal(f.media.length, 0); assert.equal(f.calls.length, 0); f.controller.dispose(); }
});

test('storage failures block entry and a changed pending marker is never removed or overwritten', async () => {
  const store = storage(); store.setItem = () => { throw new Error('PRIVATE_STORAGE_ERROR'); }; let count = 0;
  const f = fixture({ storage: store, options: { fetchImpl: async () => { count += 1; throw new Error('must not enter'); } } });
  await recorded(f); assert.equal(await f.controller.transcribe(), false); held(f.controller); assert.equal(count, 0); f.controller.dispose();
  const changed = storage(), other = JSON.stringify({ requestId: uuid(7), state: 'pending' });
  const g = fixture({ storage: changed, options: { fetchImpl: async (_url, init) => { changed.values.set(VOICE_STORAGE_KEY, other); return response(result(init.headers['X-O-Voice-Request-Id'])); } } });
  await recorded(g); assert.equal(await g.controller.transcribe(), false); held(g.controller); assert.equal(changed.getItem(VOICE_STORAGE_KEY), other); g.controller.dispose();
});

function controls() {
  const button = () => ({ disabled: false, listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); },
    removeEventListener(type) { this.listeners.delete(type); }, click() { if (!this.disabled) this.listeners.get('click')?.({ preventDefault() {} }); } });
  const statusElement = { textContent: '' }, draftTextarea = { value: '' };
  Object.defineProperty(statusElement, 'innerHTML', { set() { throw new Error('HTML forbidden'); } });
  Object.defineProperty(draftTextarea, 'innerHTML', { set() { throw new Error('HTML forbidden'); } });
  return { startButton: button(), stopButton: button(), discardButton: button(), transcribeButton: button(), speakButton: button(), statusElement, draftTextarea };
}
test('DOM mounting uses button/text/value only, exposes reviewed draft and never sends chat or code', async () => {
  const payload = '<img src=x onerror="FICTIONAL_HTML">'; const f = fixture({ options: { fetchImpl: async (_url, init) => response(result(init.headers['X-O-Voice-Request-Id'], payload)) } });
  const ui = controls(); const unmount = mountBrowserVoice({ controller: f.controller, ...ui });
  for (const key of ['startButton', 'stopButton', 'discardButton', 'transcribeButton', 'speakButton']) assert.equal(ui[key].type, 'button');
  ui.startButton.click(); await flush(); f.recordings[0].data(); f.timers.advance(2000); ui.stopButton.click(); await flush();
  ui.transcribeButton.click(); await flush(); await flush(); assert.equal(ui.draftTextarea.value, payload);
  assert.match(ui.statusElement.textContent, /draft.*Review/i); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/api/voice/transcribe');
  unmount(); assert.equal(ui.startButton.listeners.size, 0);
});

test('speech playback is explicitly user requested and voiceschanged updates honest availability', async () => {
  const listeners = new Map(), spoken = []; let voices = [];
  const synthesis = { getVoices: () => voices, speak: value => spoken.push(value), cancel() {},
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  class Utterance { constructor(text) { this.text = text; } }
  const f = fixture({ options: { speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance } }), ui = controls();
  const unmount = mountBrowserVoice({ controller: f.controller, ...ui, getPlaybackText: () => 'Reviewed reply.' });
  assert.equal(ui.speakButton.disabled, true); assert.equal(f.controller.speak('draft'), false); assert.equal(spoken.length, 0);
  voices = [{ name: 'Fictional voice' }]; listeners.get('voiceschanged')(); assert.equal(ui.speakButton.disabled, false);
  assert.equal(spoken.length, 0); ui.speakButton.click(); await flush(); assert.equal(spoken.length, 1); assert.equal(spoken[0].text, 'Reviewed reply.');
  unmount(); assert.equal(listeners.size, 0);
});
