import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const VOICE_LIMITS = Object.freeze({ bytes: 1_048_576, seconds: 30, transcript: 4096, responseBytes: 65_536, records: 1024 });
export const VOICE_MODEL = Object.freeze({ repository: 'Systran/faster-whisper-base', revision: 'a80717a3a48b1b28aa687bca146cb7301feae1b1', computeType: 'int8' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MIME = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav']);
const HASH = /^[a-f0-9]{64}$/;
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const sha = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const copy = value => JSON.parse(JSON.stringify(value));

export class VoiceError extends Error {
  constructor(code, httpStatus = 503, state = 'UNKNOWN') {
    super(code); this.name = 'VoiceError'; this.code = code; this.httpStatus = httpStatus;
    this.state = state; this.replayAllowed = false;
  }
}
const refuse = (code, status = 400) => { throw new VoiceError(code, status, 'REJECTED'); };
export function voiceErrorBody(error) {
  return { error: error instanceof VoiceError ? error.code : 'VOICE_UNKNOWN', state: error instanceof VoiceError ? error.state : 'UNKNOWN', replayAllowed: false };
}

export function normalizeVoiceMime(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) refuse('VOICE_MIME_REFUSED', 415);
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  if (!MIME.has(mime)) refuse('VOICE_MIME_REFUSED', 415);
  return mime;
}
function request(value) {
  if (!own(value, ['requestId', 'contentType', 'audio']) || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) refuse('VOICE_REQUEST_ID_INVALID');
  const contentType = normalizeVoiceMime(value.contentType);
  if (!(value.audio instanceof Uint8Array) || value.audio.byteLength === 0) refuse('VOICE_AUDIO_INVALID');
  if (value.audio.byteLength > VOICE_LIMITS.bytes) refuse('VOICE_AUDIO_TOO_LARGE', 413);
  const audio = Buffer.from(value.audio); // Copy before hashing and transport: callers cannot mutate this input.
  return { requestId: value.requestId, contentType, audio, bytes: audio.length, sha256: sha(audio) };
}
function envelope(value, id) {
  return own(value, ['format', 'version', 'requestId', 'transcript', 'languageDetected', 'durationSeconds', 'model', 'replayAllowed'])
    && value.format === 'o-private-stt' && value.version === 1 && value.requestId === id && value.replayAllowed === false
    && typeof value.transcript === 'string' && value.transcript.length <= VOICE_LIMITS.transcript
    && typeof value.languageDetected === 'string' && /^[a-z]{2,3}$/.test(value.languageDetected)
    && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0 && value.durationSeconds <= VOICE_LIMITS.seconds
    && own(value.model, ['repository', 'revision', 'computeType']) && Object.entries(VOICE_MODEL).every(([k, v]) => value.model[k] === v);
}
function rejectedEnvelope(value, id) {
  return own(value, ['format', 'version', 'requestId', 'code', 'state', 'replayAllowed'])
    && value.format === 'o-private-stt-error' && value.version === 1 && (value.requestId === id || value.requestId === null)
    && typeof value.code === 'string' && /^[A-Z_]{1,64}$/.test(value.code) && value.state === 'REJECTED' && value.replayAllowed === false;
}
function containsSecret(value, token) {
  const wire = JSON.stringify(value);
  return wire.includes(token) || wire.includes(JSON.stringify(token).slice(1, -1));
}
function entered(value, id) {
  return own(value, ['format', 'version', 'requestId', 'state', 'contentType', 'bytes', 'sha256', 'atUtc', 'replayAllowed'])
    && value.format === 'o-phone-voice-intent' && value.version === 1 && value.requestId === id && value.state === 'ENTERED'
    && MIME.has(value.contentType) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= VOICE_LIMITS.bytes
    && typeof value.sha256 === 'string' && HASH.test(value.sha256) && typeof value.atUtc === 'string' && Number.isFinite(Date.parse(value.atUtc)) && value.replayAllowed === false;
}
function terminal(value, entry) {
  if (!own(value, ['format', 'version', 'requestId', 'state', 'atUtc', 'sha256', 'replayAllowed', 'result'])
    || value.format !== 'o-phone-voice-terminal' || value.version !== 1 || value.requestId !== entry.requestId
    || value.sha256 !== entry.sha256 || typeof value.atUtc !== 'string' || !Number.isFinite(Date.parse(value.atUtc)) || value.replayAllowed !== false) return false;
  return value.state === 'COMPLETED' ? envelope(value.result, entry.requestId) : ['REJECTED', 'UNKNOWN'].includes(value.state) && value.result === null;
}

// Authenticate the phone cookie and same-origin request in the hosting gateway BEFORE calling this helper.
export async function readVoiceRequest(req) {
  const requestId = req.headers?.['x-o-voice-request-id'];
  if (typeof requestId !== 'string' || !UUID.test(requestId)) refuse('VOICE_REQUEST_ID_INVALID');
  const contentType = normalizeVoiceMime(req.headers?.['content-type']);
  const length = req.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^[0-9]{1,8}$/.test(length))) refuse('VOICE_LENGTH_INVALID');
  if (length !== undefined && Number(length) > VOICE_LIMITS.bytes) refuse('VOICE_AUDIO_TOO_LARGE', 413);
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of req) {
      if (!(chunk instanceof Uint8Array)) refuse('VOICE_AUDIO_INVALID');
      bytes += chunk.byteLength;
      if (bytes > VOICE_LIMITS.bytes) refuse('VOICE_AUDIO_TOO_LARGE', 413);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { if (error instanceof VoiceError) throw error; refuse('VOICE_UPLOAD_INCOMPLETE'); }
  if (!bytes || (length !== undefined && Number(length) !== bytes)) refuse('VOICE_UPLOAD_INCOMPLETE');
  return { requestId, contentType, audio: Buffer.concat(chunks, bytes) };
}

async function readJson(response) {
  const claimed = response.headers?.get('content-length');
  if (claimed !== null && claimed !== undefined && (!/^[0-9]{1,8}$/.test(claimed) || Number(claimed) > VOICE_LIMITS.responseBytes)) throw new Error('UNKNOWN');
  if (!response.body?.getReader) throw new Error('UNKNOWN');
  const reader = response.body.getReader(); const parts = []; let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > VOICE_LIMITS.responseBytes) throw new Error('UNKNOWN');
      parts.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes)));
  } finally { try { await reader.cancel(); } catch {} try { reader.releaseLock(); } catch {} }
}
async function syncDirectory(root) {
  // Production target is Linux/Fly. Windows fake tests do not qualify directory fsync durability.
  if (process.platform === 'win32') return;
  const handle = await fs.open(root, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function writeExclusive(root, name, value) {
  const handle = await fs.open(path.join(root, name), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(root);
}
async function readStored(root, name, validate, synchronize = null) {
  const file = path.join(root, name), before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > VOICE_LIMITS.responseBytes) throw new Error('STORAGE_HELD');
  // Windows requires a writable descriptor for FlushFileBuffers; no bytes are rewritten.
  const handle = await fs.open(file, (synchronize ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
  let value, bound;
  const same = stat => stat.isFile() && !stat.isSymbolicLink() && stat.dev === bound.dev && stat.ino === bound.ino
    && stat.size === bound.size && stat.mtimeMs === bound.mtimeMs && stat.ctimeMs === bound.ctimeMs;
  try {
    bound = await handle.stat();
    if (!bound.isFile() || bound.dev !== before.dev || bound.ino !== before.ino || bound.size > VOICE_LIMITS.responseBytes) throw new Error('STORAGE_HELD');
    const bytes = Buffer.alloc(VOICE_LIMITS.responseBytes + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > VOICE_LIMITS.responseBytes) throw new Error('STORAGE_HELD');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
    if (!validate(value)) throw new Error('STORAGE_HELD');
    const after = await handle.stat(), named = await fs.lstat(file);
    if (read.bytesRead !== bound.size || !same(after) || !same(named)) throw new Error('STORAGE_HELD');
    if (synchronize?.(value)) {
      await handle.sync();
      if (!same(await handle.stat()) || !same(await fs.lstat(file))) throw new Error('STORAGE_HELD');
    }
  } finally { await handle.close(); }
  if (!same(await fs.lstat(file))) throw new Error('STORAGE_HELD');
  return value;
}

// One gateway process owns one private directory. This is not a multi-Machine/distributed lock.
export async function createVoiceTranscriber({ sttOrigin, sttToken, journalDir, fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  let origin;
  try { origin = new URL(sttOrigin); } catch { throw new VoiceError('VOICE_CONFIG_INVALID'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || typeof sttToken !== 'string' || sttToken.length < 32 || sttToken.length > 256 || /[^\x21-\x7e]/.test(sttToken)
    || typeof journalDir !== 'string' || !path.isAbsolute(journalDir) || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new VoiceError('VOICE_CONFIG_INVALID');
  const root = path.resolve(journalDir), records = new Map(); let held = false, active = null, reconciledSavedTerminals = 0;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root), actual = await fs.realpath(root);
    const equivalent = process.platform === 'win32' ? actual.toLowerCase() === root.toLowerCase() : actual === root;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !equivalent) throw new Error('STORAGE_HELD');
    const files = await fs.readdir(root);
    if (files.length > VOICE_LIMITS.records * 2 || files.some(name => !/^[a-f0-9-]{36}\.(entered|terminal)\.json$/.test(name))) throw new Error('STORAGE_HELD');
    for (const name of files.filter(name => name.endsWith('.entered.json'))) {
      const id = name.slice(0, 36);
      if (!UUID.test(id)) throw new Error('STORAGE_HELD');
      const entry = await readStored(root, name, value => entered(value, id));
      records.set(id, { entry, end: null });
    }
    for (const name of files.filter(name => name.endsWith('.terminal.json'))) {
      const id = name.slice(0, 36), row = records.get(id);
      if (!row) throw new Error('STORAGE_HELD');
      const known = value => ['COMPLETED', 'REJECTED'].includes(value.state);
      const end = await readStored(root, name, value => terminal(value, row.entry) && !containsSecret(value, sttToken), known);
      // A prior terminal-write/close/fsync failure may have left valid bytes. Explicitly
      // acknowledge those known terminal bytes now; this never completes an intent/UNKNOWN.
      if (known(end)) { await syncDirectory(root); reconciledSavedTerminals++; }
      row.end = end;
    }
    held = [...records.values()].some(row => !row.end || row.end.state === 'UNKNOWN');
  } catch { held = true; }
  async function finish(row, state, result = null) {
    const end = { format: 'o-phone-voice-terminal', version: 1, requestId: row.entry.requestId, state, atUtc: stamp(), sha256: row.entry.sha256, replayAllowed: false, result };
    await writeExclusive(root, row.entry.requestId + '.terminal.json', end); row.end = end;
  }
  async function transcribe(value) {
    const input = request(value), prior = records.get(input.requestId);
    if (prior) {
      if (prior.entry.sha256 !== input.sha256 || prior.entry.contentType !== input.contentType || prior.entry.bytes !== input.bytes) refuse('VOICE_REQUEST_ID_COLLISION', 409);
      if (prior.end?.state === 'COMPLETED') return copy(prior.end.result); // Cached result, zero repeat inference.
      if (prior.end?.state === 'REJECTED') refuse('VOICE_REQUEST_ALREADY_REJECTED', 409);
      throw new VoiceError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 409);
    }
    if (held) throw new VoiceError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION', 409);
    if (active) refuse('VOICE_ALREADY_RUNNING', 409);
    if (records.size >= VOICE_LIMITS.records) refuse('VOICE_JOURNAL_FULL', 409);
    active = input.requestId;
    const entry = { format: 'o-phone-voice-intent', version: 1, requestId: input.requestId, state: 'ENTERED', contentType: input.contentType, bytes: input.bytes, sha256: input.sha256, atUtc: stamp(), replayAllowed: false };
    const row = { entry, end: null };
    try { await writeExclusive(root, input.requestId + '.entered.json', entry); records.set(input.requestId, row); }
    catch { held = true; active = null; throw new VoiceError('VOICE_PERSISTENCE_HELD'); }
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('UNKNOWN')); }, timeoutMs); });
    try {
      const operation = (async () => {
        const response = await fetchImpl(origin.origin + '/transcribe', { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: 'Bearer ' + sttToken, 'Content-Type': input.contentType, 'X-O-Voice-Request-Id': input.requestId }, body: input.audio });
        const result = await readJson(response);
        if (controller.signal.aborted || containsSecret(result, sttToken)) throw new Error('UNKNOWN');
        if ([400, 401, 403, 413, 415, 422].includes(response.status) && rejectedEnvelope(result, input.requestId)) return { rejected: true };
        if (response.status !== 200 || !envelope(result, input.requestId)) throw new Error('UNKNOWN');
        return { result };
      })();
      const received = await Promise.race([operation, deadline]);
      if (received.rejected) { await finish(row, 'REJECTED'); refuse('VOICE_TRANSCRIPTION_REFUSED', 422); }
      await finish(row, 'COMPLETED', received.result); return copy(received.result);
    } catch (error) {
      if (row.end?.state === 'REJECTED' && error instanceof VoiceError) throw error;
      held = true;
      if (!row.end) { try { await finish(row, 'UNKNOWN'); } catch {} }
      throw new VoiceError('VOICE_UNKNOWN_REQUIRES_RECONCILIATION');
    } finally { clearTimeout(timer); controller.abort(); active = null; }
  }
  return Object.freeze({ transcribe, status: () => ({ held, activeRequestId: active, records: records.size, reconciledSavedTerminals, replayAllowed: false }) });
}
