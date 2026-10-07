# First supervised phone voice

This source pack adds an explicit short-recording → private transcription →
reviewed draft boundary for the existing O phone gateway. The reviewed draft
is sent only by the existing text/code form's user action. The same developer
and reviewer FLUJO routes remain responsible for that submitted task. Optional
browser speech synthesis is user-click playback with honest availability.
Native O canonical narration, full workspace/MCP cloning, autonomous continuation
and live World graph delivery remain separate requirements of the full goal.

The delivery coordinator alone owns actual gateway,
Modal resources, runtime credentials, media acceptance and deployment. These
files do not alter its checkout or deploy resources. Graph PR6/7 source is frozen.

## Files and boundary

- `browser-voice.mjs`: injected browser controller and optional control mounting.
  Microphone permission is requested only from explicit `start()`. Recording,
  discard, transcription and playback are separate actions. Transcript review
  never invokes the existing submit handler. Unsupported recording/playback
  remains visible. The draft and clip live in memory; session storage retains
  only pending/UNKNOWN request IDs, never audio or transcripts.
- `gateway-voice.mjs`: dependency-free Node adapter; copies/hashes raw input,
  durably saves an intent before one private STT POST and validates the complete
  response. Completed exact-ID/input results can be returned from its private
  journal without inference. Unknown or damaged storage holds fresh sends.
  Startup validates retained terminal descriptors and explicitly resynchronizes
  known COMPLETED/REJECTED files and their directory before clearing the hold.
  This resolves only saved terminal-persistence uncertainty; ENTERED/UNKNOWN
  records never become completed. `status().reconciledSavedTerminals` reports
  that bounded local reconciliation, with zero upstream requests.
- `stt_protocol.py`: dependency-free admission, request fingerprint, durable
  journal and bounded-result contract. Intent storage and Volume commit precede
  the decoder and the sole inference. A completed exact-ID/fingerprint result
  is returned without ASR. Fully validated known-completed census requires
  successful file/directory synchronization and Volume commit acknowledgment
  before cached results or fresh admission. Uncertain entry/result/commit is
  held, never reset; an intent or UNKNOWN row is never promoted to completed.
- `stt_app.py`: Root-deployed on-demand Modal CPU ASGI service at `/transcribe`.
  It bounds decoded mono PCM before ASR and loads the pinned multilingual
  faster-whisper base model into a private runtime model-cache Volume.
- `model-pins.json`: selected model/runtime pins and primary research evidence.
  Direct package pins do not freeze all transitive dependencies or image bytes.
- `*.test.mjs`, `test_stt_protocol.py`: fake/source checks with no microphone,
  decoder/model imports, HTTP, provider, Fly, Modal or resource operations.

## Contract for Root's integration

Private gateway configuration supplies an HTTPS root origin and bearer token;
never include either actual value in source, browser JS, logs, Git, image build
context or portable artifacts. The Node adapter accepts a new absolute private
journal path, e.g. `/data/phone-voice`. One process/Machine owns that directory.
The process-local active lane is not a distributed or multi-Machine lock.

```js
import { createVoiceTranscriber, readVoiceRequest, voiceErrorBody, VoiceError }
  from './gateway-voice.mjs';
const voice = await createVoiceTranscriber({
  sttOrigin: privateConfig.voiceSttOrigin,
  sttToken: privateConfig.voiceSttToken,
  journalDir: '/data/phone-voice',
});
// Root's existing server authenticates phone session AND same-origin policy first.
// Inside its POST /api/voice/transcribe branch only:
try {
  const draft = await voice.transcribe(await readVoiceRequest(req));
  json(res, 200, draft, { 'Cache-Control': 'no-store' });
} catch (error) {
  json(res, error instanceof VoiceError ? error.httpStatus : 503,
    voiceErrorBody(error), { 'Cache-Control': 'no-store' });
}
```

This snippet is an integration contract, not an applied server patch. Root must
copy the module into its positive Docker file context, preserve existing jobs,
login and provider identities, and apply its own raw-upload timeouts. Mount the
browser controls on the same origin with `createBrowserVoiceController()` and
`mountBrowserVoice()`. Its reviewed `draftTextarea` is the existing message field.
Do not wire transcript success directly to a submit handler or generated command.

Both hops carry raw audio bytes in one POST, not JSON/base64/multipart:

| Item | Contract |
|---|---|
| Browser route | `POST /api/voice/transcribe`, existing private phone cookie |
| STT route | `POST <private HTTPS root>/transcribe`, private bearer |
| Identity | Fresh canonical lower-case UUIDv4 in `X-O-Voice-Request-Id` |
| MIME | Normalized `audio/webm`, `audio/ogg`, `audio/mp4`, or `audio/wav` |
| Encoded bound | 1,048,576 bytes; request and response readers are bounded |
| Decoded bound | 480,000 mono samples at16kHz; 30seconds before ASR |
| Draft bound | 4096 UTF-16 code units; no automatic send/retry |
| Response bound | Gateway64KiB, closed envelope and exact model identity |

Successful response:

```json
{
  "format": "o-private-stt", "version": 1,
  "requestId": "11111111-1111-4111-8111-111111111111",
  "transcript": "A reviewed draft.", "languageDetected": "en",
  "durationSeconds": 2,
  "model": { "repository": "Systran/faster-whisper-base",
    "revision": "a80717a3a48b1b28aa687bca146cb7301feae1b1", "computeType": "int8" },
  "replayAllowed": false
}
```

Definite pre-ASR service refusals use400/401/413/415 and a closed
`o-private-stt-error` version1 envelope with requestId (or null), fixed `code`,
`state:"REJECTED"` and `replayAllowed:false`. Entered uncertainty/conflicting ID
uses409/503 and UNKNOWN. Gateway rejects malformed or uncertain replies, keeps
the durable intent and blocks new dispatch. It forwards only a fixed error code,
never a raw upstream error. There is no reset, deletion or replay API.

Root must explicitly provision the new named private cache/journal Volumes and
auth Secret before deploying `stt_app.py`; `create_if_missing=False` prevents
implicit Volume creation. Root's installed Modal1.5.5 matches the used APIs
and Python micro-version selector in the SHA256-verified publisher package;
no downgrade to the originally researched1.2.4 is needed. This is source
compatibility evidence, without actual SDK execution or deployment.
The selected app requests2 CPU,2GiB, one maximum
container/input, zero minimum containers and60second scale-down. Replacement
must not overlap another writer of the same journal. Weights download only at
runtime into the private cache, never during image build or into Git/artifacts.

## Evidence and limits

Source/fake checks do not qualify actual MediaRecorder, PyAV codecs, model
loading, transcription accuracy, phone compatibility, latency, remote Volume
durability, authentication deployment or physical cancellation. Linux/Fly is
the gateway durability target; Windows fixtures do not qualify directory fsync.
The Python frame/aggregate bounds apply after native decoder frames are produced;
native allocation/time and hostile-input containment are not proven. Abort or
an HTTP timeout does not prove that a remote decoder/model physically stopped.
Unknown intents therefore remain held. Browser synthesis availability, voice,
language and sound require actual browser acceptance and a user gesture.

Audio is not written to either journal; private completed transcripts are. Keep
both journals and the cache outside Git, exports and generated-test mounts.
Do not reuse the original O database, allowance, providers, OFF or held IDs.
Never retire resources solely because this source pack exists.

## Root's later bounded actual acceptance

This is an unexecuted plan, not permission to replay consumed operations.

1. Independently review exact source, provision the new private resources and
   deploy one writer. Save exact image/package/model pins and configuration
   identities privately. Reconcile a deployment timeout before any new attempt.
2. Submit Root's existing private synthetic WAV once under one NEW UUIDv4.
   Keep its actual audio, input hash, response and status private. Record the
   observed transcript, duration/model identity and outcome. This one English
   synthetic clip does not qualify microphone capture or Spanish accuracy.
3. Fetch/reconcile that exact saved ID after disconnect/restart. A controlled
   exact-ID request may observe cached-response dedup with zero new inference;
   it must not delete or reset an entered/UNKNOWN record. Save independent
   evidence for any physical completion/cancellation claim.
4. Demonstrate one explicit short phone recording, stop/discard cleanup,
   transcription, visible review/edit, existing text-route send, developer and
   reviewer replies, and user-click playback if supported. Use separate fresh
   English/Spanish clips for language observations. No automatic resubmission.
5. Verify anonymous refusal, bounds, unsupported capture and reload/timeout
   hold without dispatching uncertain work again. Preserve earlier failures.
   Publish only sanitized exact-scope receipts, never audio/access/credentials.

Full O/FACTORY/FLUJO authority, real World graphs, hot workspace/MCP cloning,
both subscription providers and autonomous recovery remain active broader work.
