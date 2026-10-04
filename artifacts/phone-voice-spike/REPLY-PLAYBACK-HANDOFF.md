# Explicit playback of completed worker replies

This source addon lets the phone/World host offer deliberate playback of a
completed developer or reviewer response. It selects the reviewer when present,
labels the role and makes shortened playback visible. It extends the existing
phone voice work toward the unified O → FACTORY/SWARM → FLUJO interface.
Full native avatar narration, both subscription providers, hot workspace/MCP
cloning, worker communication and recovery remain requirements of that goal.

The addon is stacked on the passing Windows-fixture successor at
`954906f13435b732defbed2f3f2f0bbe972c1d4b`. The frozen original PR8 remains
unchanged. Existing browser/gateway/transcriber production modules are unchanged.
Root owns actual gateway changes, credentials, runtime images and audio acceptance.

## Selection and mounting contract

`selectReplyPlayback(job)` takes one trusted parsed public job from the
authenticated gateway history. A canonical UUIDv4 and final `COMPLETED` state
are required. One or two unique developer/reviewer stages must each have an
observed HTTP 2xx response and valid bounded text. An uncertain or malformed
reviewer never causes fallback to developer playback. No prompt or tool metadata
is copied. Completion means an observed response, not correctness or acceptance.

Source text is bounded to 131,072 UTF-16 units before string processing. Playback
is at most 4,096 units, without splitting a Unicode pair; `clipped` explicitly
marks partial output. The returned record contains only job/role/label/text and
length metadata. Inputs are trusted JSON data, not arbitrary proxies or accessors.

`mountReplyPlayback({ controller, job, parent, getServiceStatus })` mounts a button,
notice and text preview using DOM text content. It never records, transcribes,
sends a task, starts playback automatically or disposes the shared controller.
Only its direct click invokes the controller's existing `speak()`.

The required `getServiceStatus` callback returns the host's current authenticated
gateway observation. Playback requires `authenticated === true`,
`voiceHeld === false` and `voiceActive === false`, plus a local voice snapshot
without acquisition, stopping, capture, transcription or UNKNOWN. Both are read
again at click time. Missing or invalid observations refuse playback. The
transcription `voiceReady` flag is intentionally not required: a recording cap
does not remove the browser's ability to read an already completed response.
The callback is a trusted host integration point, not an authority or a new GET.

## Proposed phone integration; not an applied gateway patch

Copy the helper into the positive image context and static asset allowlist, then
import it from the same origin. Keep the existing login/session, voice controller,
jobs, provider profiles and durable storage. Mount it after each job's observed
stage text, with `getServiceStatus: () => latestStatus`.

Keep all returned disposers in the host. Dispose them before each history
replacement, sign-out, controller replacement and page teardown. Clear the host
status before sign-out/authorization loss and whenever status observation fails;
do not reuse the last successful authenticated observation after a known failure.
Dispose reply controls before the host disposes its shared voice controller.
Existing polling can remount controls with the next history/status observation.
The host remains responsible for status freshness and session scope.

The original draft Play action is separate; label draft and reply playback clearly.
Keep explicit Record → Stop → Transcribe draft → review/edit → Send. This addon
never converts a transcript or a playback event into task submission.

## Evidence and acceptance limits

Author fake-controller/DOM checks and independent static review are recorded in
`REPLY-PLAYBACK-SOURCE-CHECKS.json` when closed. Those checks use no microphone,
browser media, provider, Fly, Modal or actual HTTP. Hosted source CI is separate
from live runtime evidence.

The existing controller does not expose speaking state. A later Record action
can still begin during synthesis; these click-time checks do not establish
capture exclusion, duplex interruption or physical cancellation. The host must
qualify the complete interaction on an actual phone before claiming it works.

Browser synthesis may use an embedded or remote implementation; this helper
does not guarantee offline or local processing. See the primary
[Web Speech API specification](https://webaudio.github.io/web-speech-api/#introduction).
Availability, voice/language and audible output need actual browser acceptance.

Native avatar host/session/lease/canonical-result/global OFF integration is not
supplied by this addon. Completed response text is not a native accepted-result
receipt. Keep original O OFF, UNKNOWN, entered allowance, provider identities,
held jobs and unconfirmed cleanup unchanged. Do not replay old operations or
modify the hackathon team's independent work.
