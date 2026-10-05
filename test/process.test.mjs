import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFlyRunner } from '../lib/process.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.resume = () => undefined;
  child.stderr = new EventEmitter(); child.stderr.resume = () => undefined;
  child.stdin = new EventEmitter(); child.stdin.end = () => { child.endCalls += 1; };
  child.endCalls = 0; child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; return true; };
  return child;
}

test('private proxy stop waits for observed child close; repeated stops share one termination and outcome', async () => {
  const child = fakeChild(), launches = [];
  const runner = createFlyRunner({ proxyStopTimeoutMs: 1000, spawnImpl: (...args) => { launches.push(args); return child; } });
  const proxy = await runner.proxy({ app: 'synthetic-worker', org: 'example-org', machineId: 'owned_machine', localPort: 46010 });
  const stopped = proxy.stop(); assert.equal(proxy.stop(), stopped);
  let settled = false; stopped.then(() => { settled = true; });
  await Promise.resolve(); child.emit('exit', 0); await Promise.resolve();
  assert.equal(settled, false); assert.equal(child.killCalls, 1); assert.equal(child.endCalls, 1);
  assert.throws(() => proxy.check(), /exited/);
  child.emit('close', 0);
  assert.deepEqual(await stopped, { childClosed: true }); assert.deepEqual(await proxy.stop(), { childClosed: true });
  assert.equal(child.killCalls, 1);
  assert.equal(launches[0][2].shell, false); assert.equal(launches[0][2].windowsHide, true);
  assert.ok(launches[0][1].includes('--watch-stdin')); assert.ok(launches[0][1].includes('127.0.0.1'));
});

test('proxy termination request without observed close stays unknown even when the child closes later', async () => {
  const child = fakeChild();
  const proxy = await createFlyRunner({ proxyStopTimeoutMs: 5, spawnImpl: () => child })
    .proxy({ app: 'synthetic-worker', org: 'example-org', machineId: 'owned_machine', localPort: 46010 });
  const stopped = proxy.stop();
  await assert.rejects(stopped, { code: 'PROXY_CLEANUP_UNKNOWN' });
  child.emit('close', 0);
  assert.equal(proxy.stop(), stopped); await assert.rejects(proxy.stop(), { code: 'PROXY_CLEANUP_UNKNOWN' });
  assert.equal(child.killCalls, 1);
});

test('a synchronous termination error is retained as cause and does not fabricate closure', async () => {
  const child = fakeChild(), cause = new Error('Synthetic kill refused.');
  child.kill = () => { child.killCalls += 1; throw cause; };
  const proxy = await createFlyRunner({ proxyStopTimeoutMs: 5, spawnImpl: () => child })
    .proxy({ app: 'synthetic-worker', org: 'example-org', machineId: 'owned_machine', localPort: 46010 });
  await assert.rejects(proxy.stop(), error => { assert.equal(error.code, 'PROXY_CLEANUP_UNKNOWN'); assert.equal(error.cause, cause); return true; });
  assert.equal(child.killCalls, 1); child.emit('close', 0);
});

test('already observed proxy close needs no termination request and unknown shutdown bounds are refused', async () => {
  const child = fakeChild();
  const proxy = await createFlyRunner({ spawnImpl: () => child })
    .proxy({ app: 'synthetic-worker', org: 'example-org', machineId: 'owned_machine', localPort: 46010 });
  child.emit('close', 0);
  assert.deepEqual(await proxy.stop(), { childClosed: true }); assert.equal(child.killCalls, 0); assert.equal(child.endCalls, 0);
  for (const proxyStopTimeoutMs of [0, -1, 1.5, NaN, Infinity, '5', 60001]) {
    assert.throws(() => createFlyRunner({ proxyStopTimeoutMs, spawnImpl: () => child }), /shutdown timeout/);
  }
});
