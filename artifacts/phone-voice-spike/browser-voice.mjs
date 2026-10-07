/** Short audio -> reviewed draft only. This module never submits chat or code. */
export const VOICE_LIMITS = Object.freeze({ bytes: 1024 * 1024, seconds: 30, stopMs: 29_000,
  transcriptChars: 4096, responseBytes: 32 * 1024 });
export const VOICE_STORAGE_KEY = 'o-phone-voice-pending-v1';
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const baseMime = value => typeof value === 'string' ? value.toLowerCase().split(';')[0].trim() : '';
const safeText = (value, maximum) => typeof value === 'string' && value.length <= maximum && value.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const cancelBody = response => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} };

function envelope(value, requestId) {
  return closed(value, ['format', 'version', 'requestId', 'transcript', 'languageDetected', 'durationSeconds', 'model', 'replayAllowed'])
    && value.format === 'o-private-stt' && value.version === 1 && value.requestId === requestId && value.replayAllowed === false
    && safeText(value.transcript, VOICE_LIMITS.transcriptChars) && value.transcript.trim().length > 0
    && typeof value.languageDetected === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value.languageDetected)
    && Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0 && value.durationSeconds <= VOICE_LIMITS.seconds
    && closed(value.model, ['repository', 'revision', 'computeType']) && value.model.computeType === 'int8'
    && safeText(value.model.repository, 256) && value.model.repository.trim().length > 0
    && safeText(value.model.revision, 128) && value.model.revision.trim().length > 0;
}

async function responseJson(response, signal) {
  if (!response.body?.getReader || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.('content-type') ?? '')) {
    cancelBody(response); throw new Error('INVALID_RESPONSE');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > VOICE_LIMITS.responseBytes)) {
    cancelBody(response); throw new Error('INVALID_RESPONSE');
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('UNKNOWN');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error('UNKNOWN');
      if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > VOICE_LIMITS.responseBytes) throw new Error('INVALID_RESPONSE');
      chunks.push(value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new Error('INVALID_RESPONSE'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch {} }
}

export function createBrowserVoiceController(options = {}) {
  const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
  const Recorder = options.MediaRecorder ?? globalThis.MediaRecorder;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto;
  const BlobImpl = options.Blob ?? globalThis.Blob;
  const synthesis = options.speechSynthesis ?? globalThis.speechSynthesis;
  const Utterance = options.SpeechSynthesisUtterance ?? globalThis.SpeechSynthesisUtterance;
  const timers = options.timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: () => performance.now() };
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000
    || !['setTimeout', 'clearTimeout', 'now'].every(key => typeof timers[key] === 'function')) throw new Error('Invalid voice options.');
  let storage;
  try { storage = options.storage ?? globalThis.sessionStorage; } catch {}
  let mime = '';
  if (typeof Recorder === 'function' && typeof Recorder.isTypeSupported === 'function') {
    for (const candidate of TYPES) { try { if (Recorder.isTypeSupported(candidate) === true) { mime = candidate; break; } } catch {} }
  }
  const supported = Boolean(mime && typeof mediaDevices?.getUserMedia === 'function' && typeof fetchImpl === 'function'
    && typeof cryptoImpl?.randomUUID === 'function' && typeof BlobImpl === 'function');
  let state = 'idle', code = supported ? null : 'UNSUPPORTED', requestId = null, draft = '', acquiring = false;
  let disposed = false, generation = 0, capture = null, audio = null, transport = null, speaking = false;
  const subscribers = new Set();
  const snapshot = () => Object.freeze({ state, code, supported, acquiring, stopping: Boolean(capture?.stopping),
    requestId, bytes: audio?.size ?? capture?.bytes ?? 0, draft, playbackAvailable: playbackAvailable() });
  const emit = () => { const value = snapshot(); for (const subscriber of subscribers) { try { subscriber(value); } catch {} } };
  const update = (next, nextCode = null) => { state = next; code = nextCode; emit(); };
  function readMarker() {
    if (!storage || !['getItem', 'setItem', 'removeItem'].every(key => typeof storage[key] === 'function')) throw new Error('STORAGE_UNAVAILABLE');
    const raw = storage.getItem(VOICE_STORAGE_KEY);
    if (raw === null) return null;
    if (typeof raw !== 'string' || raw.length > 256) throw new Error('STORAGE_HELD');
    const value = JSON.parse(raw);
    if (!closed(value, ['requestId', 'state']) || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
      || !['pending', 'unknown'].includes(value.state)) throw new Error('STORAGE_HELD');
    return value;
  }
  try { const marker = readMarker(); if (marker) { state = 'unknown'; code = 'PRIOR_REQUEST_REQUIRES_RECONCILIATION'; requestId = marker.requestId; } }
  catch { state = 'unknown'; code = 'VOICE_STORAGE_HELD'; }
  function markUnknown(id) {
    try { const marker = readMarker(); if (marker?.requestId === id) storage.setItem(VOICE_STORAGE_KEY, JSON.stringify({ requestId: id, state: 'unknown' })); } catch {}
    audio = null; draft = ''; update('unknown', 'REQUEST_REQUIRES_RECONCILIATION');
  }
  function clearMarker(id) {
    const marker = readMarker();
    if (marker?.requestId !== id) throw new Error('STORAGE_CHANGED');
    storage.removeItem(VOICE_STORAGE_KEY);
    if (readMarker() !== null) throw new Error('STORAGE_CHANGED');
  }
  function stopTracks(ctx) {
    if (!ctx || ctx.tracksStopped) return;
    ctx.tracksStopped = true;
    try { for (const track of ctx.stream.getTracks()) { try { track.stop(); } catch {} } } catch {}
  }
  function retire(ctx) {
    if (!ctx) return;
    timers.clearTimeout(ctx.timer);
    try { if (ctx.recorder?.state !== 'inactive') ctx.recorder.stop(); } catch {}
    stopTracks(ctx); ctx.chunks = [];
  }
  function recordingFailure(nextCode) {
    generation += 1; const previous = capture; capture = null; audio = null; acquiring = false;
    retire(previous); update('rejected', nextCode);
  }
  async function start() {
    if (disposed || !supported || acquiring || capture || transport || !['idle', 'draft', 'rejected'].includes(state)) return false;
    try { if (readMarker()) { update('unknown', 'PRIOR_REQUEST_REQUIRES_RECONCILIATION'); return false; } }
    catch { update('unknown', 'VOICE_STORAGE_HELD'); return false; }
    const mine = ++generation; audio = null; draft = ''; acquiring = true; emit();
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
      if (disposed || generation !== mine) { stopTracks({ stream }); return false; }
      const recorder = new Recorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 });
      const type = baseMime(recorder.mimeType || mime);
      if (!['audio/webm', 'audio/ogg', 'audio/mp4'].includes(type)) { stopTracks({ stream }); throw new Error('UNSUPPORTED_RECORDING'); }
      const ctx = { stream, recorder, type, chunks: [], bytes: 0, started: timers.now(), stopping: false, tracksStopped: false };
      capture = ctx; acquiring = false;
      recorder.ondataavailable = event => {
        if (disposed || generation !== mine || capture !== ctx) return;
        const chunk = event.data;
        if (!(chunk instanceof BlobImpl) || !Number.isSafeInteger(chunk.size) || chunk.size < 0
          || (chunk.type && baseMime(chunk.type) !== type)) return recordingFailure('INVALID_AUDIO');
        if (ctx.bytes + chunk.size > VOICE_LIMITS.bytes) return recordingFailure('AUDIO_TOO_LARGE');
        ctx.bytes += chunk.size; if (chunk.size) ctx.chunks.push(chunk); emit();
      };
      recorder.onerror = () => { if (capture === ctx && generation === mine) recordingFailure('RECORDING_FAILED'); };
      recorder.onstop = () => {
        if (disposed || generation !== mine || capture !== ctx) return;
        timers.clearTimeout(ctx.timer); stopTracks(ctx); capture = null;
        const duration = (timers.now() - ctx.started) / 1000;
        if (!Number.isFinite(duration) || duration < 0 || duration > VOICE_LIMITS.seconds || !ctx.bytes) {
          ctx.chunks = []; return update('rejected', duration > VOICE_LIMITS.seconds ? 'AUDIO_TOO_LONG' : 'EMPTY_AUDIO');
        }
        audio = new BlobImpl(ctx.chunks, { type }); ctx.chunks = [];
        if (audio.size > VOICE_LIMITS.bytes) { audio = null; return update('rejected', 'AUDIO_TOO_LARGE'); }
        update('recorded');
      };
      recorder.start(250); update('recording');
      ctx.timer = timers.setTimeout(() => { if (capture === ctx) stop(); }, VOICE_LIMITS.stopMs);
      return true;
    } catch {
      if (disposed || generation !== mine) { if (stream) stopTracks({ stream }); return false; }
      if (stream && !capture) stopTracks({ stream });
      recordingFailure('MICROPHONE_OR_RECORDER_REFUSED'); return false;
    }
    finally { if (generation === mine) acquiring = false; }
  }
  function stop() {
    if (disposed || !capture || state !== 'recording' || capture.stopping) return false;
    const ctx = capture; ctx.stopping = true; timers.clearTimeout(ctx.timer);
    try { ctx.recorder.stop(); } catch { recordingFailure('RECORDING_FAILED'); return false; }
    stopTracks(ctx); emit(); return true;
  }
  function discard() {
    if (disposed || state === 'unknown' || state === 'transcribing' || transport) return false;
    generation += 1; const previous = capture; capture = null; acquiring = false; retire(previous);
    audio = null; draft = ''; requestId = null; update('idle', supported ? null : 'UNSUPPORTED'); return true;
  }
  async function transcribe() {
    if (disposed || state !== 'recorded' || !audio || transport) return false;
    let id;
    try {
      if (readMarker()) throw new Error('STORAGE_HELD');
      id = cryptoImpl.randomUUID(); if (typeof id !== 'string' || !UUID.test(id)) throw new Error('ID_INVALID');
      storage.setItem(VOICE_STORAGE_KEY, JSON.stringify({ requestId: id, state: 'pending' }));
      if (readMarker()?.requestId !== id) throw new Error('STORAGE_CHANGED');
    } catch { requestId = typeof id === 'string' && UUID.test(id) ? id : null; audio = null; update('unknown', 'VOICE_STORAGE_HELD'); return false; }
    requestId = id; const body = audio; audio = null; draft = '';
    const controller = new AbortController(), mine = ++generation;
    transport = { controller, id }; update('transcribing');
    if (disposed || controller.signal.aborted || generation !== mine) {
      markUnknown(id); transport = null; return false;
    }
    let timer;
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('UNKNOWN')), { once: true });
      if (controller.signal.aborted) reject(new Error('UNKNOWN'));
      timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    });
    const operation = (async () => {
      if (controller.signal.aborted || disposed || generation !== mine) throw new Error('UNKNOWN');
      const response = await fetchImpl('/api/voice/transcribe', { method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': body.type, 'X-O-Voice-Request-Id': id }, body, signal: controller.signal });
      if (controller.signal.aborted || disposed || generation !== mine) { cancelBody(response); throw new Error('UNKNOWN'); }
      if ([400, 401, 403, 413, 415, 422].includes(response?.status)) { cancelBody(response); return { rejected: true }; }
      if (response?.status !== 200) { cancelBody(response); throw new Error('UNKNOWN'); }
      const value = await responseJson(response, controller.signal);
      if (!envelope(value, id)) throw new Error('INVALID_RESPONSE');
      return { value };
    })();
    try {
      const result = await Promise.race([operation, aborted]);
      if (disposed || controller.signal.aborted || generation !== mine) throw new Error('UNKNOWN');
      clearMarker(id);
      if (result.rejected) { update('rejected', 'TRANSCRIPTION_REFUSED'); return false; }
      draft = result.value.transcript; update('draft'); return true;
    } catch { markUnknown(id); return false; }
    finally { timers.clearTimeout(timer); controller.abort(); transport = null; }
  }
  function playbackAvailable() {
    try { return typeof synthesis?.speak === 'function' && typeof Utterance === 'function'
      && Array.isArray(synthesis.getVoices?.()) && synthesis.getVoices().length > 0; } catch { return false; }
  }
  function speak(text) {
    if (disposed || !playbackAvailable() || !safeText(text, VOICE_LIMITS.transcriptChars) || !text.trim()) return false;
    try {
      if (speaking) synthesis.cancel?.();
      const utterance = new Utterance(text); speaking = true;
      utterance.onend = utterance.onerror = () => { speaking = false; emit(); };
      synthesis.speak(utterance); return true;
    } catch { speaking = false; return false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; generation += 1; acquiring = false;
    const previous = capture; capture = null; retire(previous); audio = null; draft = '';
    if (transport) { markUnknown(transport.id); transport.controller.abort(); }
    if (speaking) { try { synthesis.cancel?.(); } catch {} speaking = false; }
    try { synthesis?.removeEventListener?.('voiceschanged', emit); } catch {}
    subscribers.clear();
  }
  try { synthesis?.addEventListener?.('voiceschanged', emit); } catch {}
  if (typeof options.onChange === 'function') subscribers.add(options.onChange);
  return Object.freeze({ getSnapshot: snapshot, start, stop, discard, transcribe, speak, dispose,
    subscribe(listener) { if (typeof listener !== 'function') throw new Error('Invalid voice listener.'); subscribers.add(listener); listener(snapshot()); return () => subscribers.delete(listener); } });
}

/** Supply existing buttons/textarea; none of these handlers submits its form. */
export function mountBrowserVoice({ controller, startButton, stopButton, discardButton, transcribeButton,
  draftTextarea, statusElement, speakButton, getPlaybackText = () => draftTextarea.value }) {
  if (!controller || !draftTextarea || !statusElement || ![startButton, stopButton, discardButton, transcribeButton].every(Boolean)) throw new Error('Missing voice controls.');
  const handlers = [];
  for (const [button, action] of [[startButton, () => controller.start()], [stopButton, () => controller.stop()],
    [discardButton, () => controller.discard()], [transcribeButton, () => controller.transcribe()],
    ...(speakButton ? [[speakButton, () => controller.speak(getPlaybackText())]] : [])]) {
    button.type = 'button';
    const handler = event => { event.preventDefault(); Promise.resolve().then(action).catch(() => {}); };
    button.addEventListener('click', handler); handlers.push([button, handler]);
  }
  const unsubscribe = controller.subscribe(value => {
    startButton.disabled = !value.supported || value.acquiring || !['idle', 'draft', 'rejected'].includes(value.state);
    stopButton.disabled = value.state !== 'recording' || value.stopping;
    discardButton.disabled = ['unknown', 'transcribing'].includes(value.state);
    transcribeButton.disabled = value.state !== 'recorded';
    if (speakButton) speakButton.disabled = !value.playbackAvailable;
    statusElement.textContent = value.state === 'unknown' ? 'Voice request held; reconcile it before another recording.'
      : !value.supported ? 'Microphone recording is unsupported in this browser.'
      : value.acquiring ? 'Waiting for microphone permission.'
      : value.state === 'draft' ? 'Transcript is a draft. Review it before using the existing Send button.'
      : `${value.state}${value.code ? ' — ' + value.code : ''}${value.playbackAvailable ? ' · Browser playback available.' : ' · Browser playback unavailable.'}`;
    if (value.state === 'draft') draftTextarea.value = value.draft;
  });
  return () => { unsubscribe(); for (const [button, handler] of handlers) button.removeEventListener('click', handler); controller.dispose(); };
}
