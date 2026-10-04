/** Observed history text only. The caller authenticates the history response.
 * No native avatar receipt, canonical acceptance or playback authority is minted.
 * A click-time local snapshot check cannot exclude a future recording/capture. */
export const REPLY_PLAYBACK_LIMITS = Object.freeze({ stages: 2, sourceChars: 128 * 1024, spokenChars: 4096 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = new Set(['idle', 'recorded', 'draft', 'rejected']);
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const textValid = value => typeof value === 'string' && value.length <= REPLY_PLAYBACK_LIMITS.sourceChars
  && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && /\S/u.test(value);

/** Select from one parsed gateway publicJob; no other input fields are copied. */
export function selectReplyPlayback(job) {
  if (!plain(job)) return null;
  const id = own(job, 'id'), stages = own(job, 'stages');
  if (typeof id !== 'string' || !UUID.test(id) || own(job, 'state') !== 'COMPLETED'
    || !Array.isArray(stages) || stages.length < 1 || stages.length > REPLY_PLAYBACK_LIMITS.stages
    || ![undefined, null].includes(own(job, 'errorCode')) || ![undefined, false].includes(own(job, 'replayAllowed'))) return null;
  const observed = new Map();
  for (let index = 0; index < stages.length; index++) {
    const stage = own(stages, String(index));
    if (!plain(stage)) return null;
    const role = own(stage, 'role'), status = own(stage, 'httpStatus'), text = own(stage, 'text');
    if (!['developer', 'reviewer'].includes(role) || observed.has(role) || own(stage, 'state') !== 'RESPONSE_OBSERVED'
      || !Number.isInteger(status) || status < 200 || status >= 300 || !textValid(text)) return null;
    observed.set(role, text);
  }
  if (!observed.has('developer')) return null;
  const role = observed.has('reviewer') ? 'reviewer' : 'developer', source = observed.get(role).trim();
  let end = Math.min(source.length, REPLY_PLAYBACK_LIMITS.spokenChars);
  if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1]) && /[\uDC00-\uDFFF]/u.test(source[end])) end--;
  const text = source.slice(0, end);
  return Object.freeze({ jobId: id, role, label: role === 'reviewer' ? 'Reviewer reply' : 'Developer reply',
    text, clipped: end < source.length, sourceChars: source.length, spokenChars: text.length });
}

const available = value => plain(value) && STATES.has(own(value, 'state'))
  && own(value, 'acquiring') === false && own(value, 'stopping') === false && own(value, 'playbackAvailable') === true;
const serviceAvailable = value => plain(value) && own(value, 'authenticated') === true
  && own(value, 'voiceHeld') === false && own(value, 'voiceActive') === false;

/** Add an optional explicit-click button and bounded text preview. The shared
 * controller is never disposed, reset, connected, recorded or transcribed.
 * getServiceStatus synchronously reads the host's trusted current gateway status;
 * it must not fetch, submit or return a promise. voiceReady is intentionally not
 * required: a recording journal at capacity does not prevent reply playback. */
export function mountReplyPlayback({ controller, job, parent, getServiceStatus,
  documentImpl = parent?.ownerDocument ?? globalThis.document } = {}) {
  const reply = selectReplyPlayback(job);
  if (!reply) return () => {};
  if (!controller || !['getSnapshot', 'subscribe', 'speak'].every(key => typeof controller[key] === 'function')
    || typeof getServiceStatus !== 'function' || typeof parent?.append !== 'function'
    || typeof documentImpl?.createElement !== 'function') throw new Error('Invalid reply playback controls.');
  const node = documentImpl.createElement('div'), button = documentImpl.createElement('button');
  const notice = documentImpl.createElement('small'), preview = documentImpl.createElement('pre');
  button.type = 'button'; button.textContent = `Play ${reply.label}${reply.clipped ? ' (beginning only)' : ''}`;
  const baseNotice = `${reply.label} for job ${reply.jobId}. ${reply.clipped ? 'Beginning only; reply shortened for playback.' : 'Observed response text.'}`;
  preview.textContent = reply.text; node.append(button, notice, preview);
  let disposed = false, unsubscribe;
  const canPlay = () => {
    try {
      const service = getServiceStatus(), local = controller.getSnapshot();
      return !disposed && available(local) && serviceAvailable(service);
    } catch { return false; }
  };
  const refresh = () => {
    if (disposed) return;
    button.disabled = !canPlay();
    notice.textContent = baseNotice + (button.disabled ? ' Browser playback unavailable for the current session, voice service or recording state.' : '');
  };
  const click = event => {
    event.preventDefault();
    if (disposed) return;
    if (!canPlay()) { refresh(); return; }
    let played = false;
    try { played = controller.speak(reply.text) === true; } catch {}
    refresh();
    if (!played && !disposed) notice.textContent = baseNotice + ' Browser playback unavailable.';
  };
  button.addEventListener('click', click); parent.append(node);
  try {
    unsubscribe = controller.subscribe(refresh);
    if (typeof unsubscribe !== 'function') throw new Error('Invalid subscription.');
    refresh();
  } catch {
    disposed = true; button.removeEventListener('click', click); node.remove();
    throw new Error('Invalid reply playback controls.');
  }
  return () => {
    if (disposed) return;
    disposed = true; button.removeEventListener('click', click);
    try { unsubscribe(); } catch {}
    node.remove();
  };
}
