import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_PLAYBACK_LIMITS, selectReplyPlayback, mountReplyPlayback } from './reply-playback.mjs';

const ID = 'abcd1111-1111-4111-8111-111111111111';
const stage = (role, text = role + ' observed text', extra = {}) => ({ role, state: 'RESPONSE_OBSERVED', httpStatus: 200, text, ...extra });
const job = (extra = {}) => ({ id: ID, state: 'COMPLETED', stages: [stage('developer'), stage('reviewer')], replayAllowed: false,
  errorCode: null, input: 'PRIVATE prompt omitted', nativeToolPolicyQualified: false, ...extra });
function fixture(value = job(), initial = {}) {
  const state = { state: 'idle', acquiring: false, stopping: false, playbackAvailable: true, ...initial };
  const service = { authenticated: true, voiceHeld: false, voiceActive: false, voiceReady: true };
  const subscribers = new Set(), spoken = [];
  const controller = { getSnapshot: () => ({ ...state }), speak: text => { spoken.push(text); return true; },
    subscribe: fn => { subscribers.add(fn); fn({ ...state }); return () => subscribers.delete(fn); },
    dispose: () => { throw new Error('Shared controller must not be disposed.'); } };
  class Element {
    constructor(tag) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.parentNode = null; this.handlers = new Map(); this.textContent = ''; }
    set innerHTML(_) { throw new Error('HTML forbidden.'); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    addEventListener(type, fn) { this.handlers.set(type, fn); }
    removeEventListener(type, fn) { if (this.handlers.get(type) === fn) this.handlers.delete(type); }
    click() { this.handlers.get('click')?.({ preventDefault() {} }); }
  }
  const doc = { createElement: tag => new Element(tag) }, parent = doc.createElement('main');
  const emit = change => { Object.assign(state, change); for (const fn of subscribers) fn({ ...state }); };
  return { state, service, controller, parent, doc, spoken, subscribers, emit,
    mount: (options = {}) => mountReplyPlayback({ controller, job: value, parent, getServiceStatus: () => service, ...options }) };
}

test('selects a reviewer observed reply; developer-only requires no reviewer and returns only bounded metadata', () => {
  const input = job(), before = JSON.stringify(input), reply = selectReplyPlayback(input);
  assert.equal(JSON.stringify(input), before); assert.equal(Object.isFrozen(reply), true);
  assert.deepEqual(reply, { jobId: ID, role: 'reviewer', label: 'Reviewer reply', text: 'reviewer observed text', clipped: false, sourceChars: 22, spokenChars: 22 });
  assert.equal(selectReplyPlayback(job({ stages: [stage('developer', 'Only developer', { httpStatus: 299 })] })).role, 'developer');
  assert.equal(selectReplyPlayback(job({ stages: [stage('reviewer'), stage('developer')] })).role, 'reviewer');
  assert.equal(JSON.stringify(reply).includes('PRIVATE'), false);
});

test('refuses noncanonical job IDs and unfinished, rejected or unknown jobs', () => {
  for (const id of [ID.toUpperCase(), ID.replace('4111', '5111'), 'not-a-uuid', null, 123]) assert.equal(selectReplyPlayback(job({ id })), null);
  for (const state of ['QUEUED', 'RUNNING', 'REJECTED', 'UNKNOWN', 'completed', null]) assert.equal(selectReplyPlayback(job({ state })), null);
  assert.equal(selectReplyPlayback(job({ errorCode: 'UNKNOWN' })), null);
  assert.equal(selectReplyPlayback(job({ replayAllowed: true })), null);
});

test('malformed, duplicate, missing and mixed uncertain stages never fall back to developer playback', () => {
  for (const stages of [[], Array(1), null, [stage('reviewer')], [stage('developer'), stage('developer')],
    [stage('developer'), stage('reviewer'), stage('reviewer')], [stage('alien')],
    [stage('developer'), stage('reviewer', 'uncertain', { state: 'UNKNOWN' })],
    [stage('developer'), stage('reviewer', null, { state: 'REJECTED', httpStatus: 401 })],
    [stage('developer', 'in flight', { state: 'ENTERED' }), stage('reviewer')],
    [stage('developer'), stage('reviewer', 'bad', { httpStatus: 300 })],
    [stage('developer'), stage('reviewer', 'bad', { httpStatus: '200' })],
    [stage('developer'), stage('reviewer', 'bad', { httpStatus: 200.5 })],
    [stage('developer'), stage('reviewer', '')], [stage('developer'), stage('reviewer', ' \n\t ')]]) assert.equal(selectReplyPlayback(job({ stages })), null);
  const getter = { ...stage('reviewer') }; Object.defineProperty(getter, 'text', { get() { throw Error('must not read getter'); } });
  assert.equal(selectReplyPlayback(job({ stages: [stage('developer'), getter] })), null);
});

test('clips valid text to 4096 without splitting Unicode pairs and rejects invalid or oversized source text', () => {
  const select = text => selectReplyPlayback(job({ stages: [stage('developer', text)] }));
  const pairBoundary = select('x'.repeat(4095) + '😀');
  assert.equal(pairBoundary.text.length, 4095); assert.equal(pairBoundary.text.isWellFormed(), true); assert.equal(pairBoundary.clipped, true);
  const exact = select('x'.repeat(4094) + '😀'); assert.equal(exact.text.length, 4096); assert.equal(exact.clipped, false);
  const maximum = select('x'.repeat(REPLY_PLAYBACK_LIMITS.sourceChars));
  assert.equal(maximum.spokenChars, 4096); assert.equal(maximum.sourceChars, 131072); assert.equal(maximum.clipped, true);
  for (const text of ['x'.repeat(REPLY_PLAYBACK_LIMITS.sourceChars + 1), 'x'.repeat(4096) + '\ud800', 'bad\u0000text', '\udc00']) assert.equal(select(text), null);
  assert.equal(select(' \nA reviewed reply\t ').text, 'A reviewed reply');
});

test('mounting and subscription updates never start playback; explicit click uses reviewer text only', () => {
  const f = fixture(), dispose = f.mount(), node = f.parent.children[0], [button, notice, preview] = node.children;
  assert.equal(f.spoken.length, 0); assert.equal(button.type, 'button'); assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Play Reviewer reply'); assert.ok(notice.textContent.includes(ID)); assert.equal(preview.textContent, 'reviewer observed text');
  f.emit({ state: 'draft' }); assert.equal(f.spoken.length, 0);
  button.click(); assert.deepEqual(f.spoken, ['reviewer observed text']); dispose();
});

test('acquiring, recording, stopping, transcribing, UNKNOWN and unsupported playback block even dispatched clicks', () => {
  for (const state of [{ acquiring: true }, { state: 'recording' }, { stopping: true }, { state: 'transcribing' },
    { state: 'unknown' }, { playbackAvailable: false }, { playbackAvailable: 'true' }, { state: 'other' }]) {
    const f = fixture(job(), state), dispose = f.mount(), button = f.parent.children[0].children[0];
    assert.equal(button.disabled, true); button.click(); assert.equal(f.spoken.length, 0); dispose();
  }
});

test('click-time state is checked again even when a stale enabled button missed an update', () => {
  const f = fixture(), dispose = f.mount(), button = f.parent.children[0].children[0];
  Object.assign(f.state, { state: 'recording' }); assert.equal(button.disabled, false);
  button.click(); assert.equal(f.spoken.length, 0); assert.equal(button.disabled, true);
  f.emit({ state: 'idle' }); button.click(); assert.equal(f.spoken.length, 1); dispose();
});

test('stale gateway hold, active transcription or logout refuses click despite the enabled UI', () => {
  for (const change of [{ voiceHeld: true }, { voiceActive: true }, { authenticated: false }]) {
    const f = fixture(), dispose = f.mount(), button = f.parent.children[0].children[0];
    Object.assign(f.service, change); assert.equal(button.disabled, false);
    button.click(); assert.equal(f.spoken.length, 0); assert.equal(button.disabled, true); dispose();
  }
});

test('required gateway callback and malformed, missing, accessor or throwing status fail closed', () => {
  const f = fixture();
  assert.throws(() => f.mount({ getServiceStatus: undefined }), /^Error: Invalid reply playback controls\.$/);
  assert.equal(f.parent.children.length, 0); assert.equal(f.subscribers.size, 0);
  let accesses = 0;
  const accessor = { authenticated: true, voiceActive: false };
  Object.defineProperty(accessor, 'voiceHeld', { get() { accesses++; throw Error('PRIVATE status'); } });
  for (const getServiceStatus of [() => undefined, () => null, () => [], () => ({}),
    () => ({ authenticated: true, voiceHeld: false }), () => ({ authenticated: 'true', voiceHeld: false, voiceActive: false }),
    () => accessor, () => Promise.resolve(f.service), () => { throw Error('PRIVATE status'); }]) {
    const current = fixture(), dispose = current.mount({ getServiceStatus });
    const [button, notice] = current.parent.children[0].children;
    assert.equal(button.disabled, true); button.click(); assert.equal(current.spoken.length, 0);
    assert.equal(notice.textContent.includes('PRIVATE'), false); dispose();
  }
  assert.equal(accesses, 0);
});

test('recording cap does not block playback; both trusted service and local snapshots are reread synchronously', () => {
  const f = fixture(); Object.assign(f.service, { voiceReady: false, voiceRecords: 1024 });
  let serviceReads = 0, localReads = 0; const getSnapshot = f.controller.getSnapshot;
  f.controller.getSnapshot = () => { localReads++; return getSnapshot(); };
  const dispose = f.mount({ getServiceStatus: () => { serviceReads++; return f.service; } });
  const button = f.parent.children[0].children[0], beforeService = serviceReads, beforeLocal = localReads;
  assert.equal(button.disabled, false); button.click(); assert.equal(f.spoken.length, 1);
  assert.ok(serviceReads > beforeService); assert.ok(localReads > beforeLocal);
  f.service.voiceHeld = true; f.emit({ state: 'idle' }); assert.equal(button.disabled, true);
  assert.equal(f.spoken.length, 1); dispose();
});

test('clipping is explicit in button and notice; preview uses textContent with no HTML', () => {
  const text = '<img src=x onerror=PRIVATE>' + 'x'.repeat(4096), f = fixture(job({ stages: [stage('developer', text)] }));
  const dispose = f.mount(), [button, notice, preview] = f.parent.children[0].children;
  assert.ok(button.textContent.includes('beginning only')); assert.ok(notice.textContent.includes('Beginning only'));
  assert.equal(preview.textContent.length, 4096); assert.ok(preview.textContent.startsWith('<img'));
  button.click(); assert.equal(f.spoken[0], preview.textContent); dispose();
});

test('controller refusal, errors and malformed snapshots do not cause retries or expose raw errors', () => {
  for (const speak of [() => false, () => { throw Error('PRIVATE controller error'); }]) {
    const f = fixture(); let calls = 0; f.controller.speak = () => { calls++; return speak(); };
    const dispose = f.mount(), [button, notice] = f.parent.children[0].children; button.click();
    assert.equal(calls, 1); assert.ok(notice.textContent.includes('unavailable')); assert.equal(notice.textContent.includes('PRIVATE'), false); dispose();
  }
  const f = fixture(); f.controller.getSnapshot = () => { throw Error('PRIVATE snapshot'); };
  const dispose = f.mount(), button = f.parent.children[0].children[0]; button.click(); assert.equal(f.spoken.length, 0); dispose();
});

test('disposal removes only its handler, subscription and node; stale callbacks cannot play; shared controller survives', () => {
  const f = fixture(), other = f.doc.createElement('aside'); f.parent.append(other);
  const dispose = f.mount(), node = f.parent.children[1], button = node.children[0], staleClick = button.handlers.get('click'), staleRefresh = [...f.subscribers][0];
  assert.equal(f.subscribers.size, 1); dispose(); dispose();
  assert.deepEqual(f.parent.children, [other]); assert.equal(button.handlers.size, 0); assert.equal(f.subscribers.size, 0);
  staleClick({ preventDefault() {} }); staleRefresh(); assert.equal(f.spoken.length, 0);
  assert.equal(f.controller.speak('Shared controller still usable.'), true);
});

test('invalid jobs mount no controls and do not subscribe or play', () => {
  const f = fixture(job({ state: 'UNKNOWN' })), dispose = f.mount();
  assert.equal(f.parent.children.length, 0); assert.equal(f.subscribers.size, 0); assert.equal(f.spoken.length, 0); dispose();
});
