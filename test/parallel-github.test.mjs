import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { prepare, provision, run, audit, commentsForTarget, issueTarget } from '../examples/parallel-github.mjs';
import { Journal } from '../lib/journal.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'flujo-parallel-helper-test-'));
  t.after(async () => {
    const relative = path.relative(tmpdir(), directory);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('flujo-parallel-helper-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const prepared = await prepare({ target: 'https://github.com/example/worker-test/issues/7',
    flowId: 'default-agent-flujo', mcpName: 'synthetic-github',
    image: `registry.fly.io/synthetic-test@sha256:${'a'.repeat(64)}`, directory });
  const plan = JSON.parse(await fs.readFile(prepared.plan, 'utf8'));
  let active = 0;
  let maxActive = 0;
  const upCalls = [];
  const bridge = { async up(options) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    upCalls.push(options);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await new Journal(options.journal).create({ format: 'flujo-cloud-journal', version: 1,
      owner: 'synthetic-owner', state: 'ready', app: options.app, image: options.image,
      workspace: options.workspace, flowIds: options.flowIds, machineId: `synthetic-machine-${upCalls.length}` });
    active -= 1;
    return { app: options.app, state: 'ready' };
  } };
  return { prepared, plan, directory: path.dirname(prepared.plan), bridge, upCalls, maxActive: () => maxActive };
}

test('prepare writes three isolated requests without credentials or adopting existing workers', async (t) => {
  const state = await fixture(t);
  assert.equal(new Set(state.plan.workers.map((worker) => worker.app)).size, 3);
  assert.equal(new Set(state.plan.workers.map((worker) => worker.marker)).size, 3);
  for (const worker of state.plan.workers) {
    assert.match(worker.app, /^flujo-cloud-gh-[a-f0-9]{10}-[123]$/);
    const request = JSON.parse(await fs.readFile(path.join(state.directory, worker.request), 'utf8'));
    assert.equal(request.model, 'default-agent-flujo');
    assert.equal(request.metadata.appendMessages, 'true');
    assert.ok(request.messages[0].content.includes(worker.marker));
    assert.ok(request.messages[0].content.includes('Never retry'));
    assert.ok(request.messages[0].content.includes('github_rest_get'));
    assert.ok(request.messages[0].content.includes('github_create_issue_comment'));
    assert.ok(request.messages[0].content.includes('"repo_url":"https://github.com/example/worker-test"'));
  }
});

test('prepare creates a missing output parent and preserves explicit deployment parameters', async (t) => {
  const state = await fixture(t);
  const directory = path.join(state.directory, 'missing', 'integration-runs');
  const prepared = await prepare({ target: state.plan.target.url, flowId: state.plan.flowId,
    mcpName: state.plan.mcpName, image: state.plan.image, directory,
    org: 'example-org', region: 'bog', workspace: 'example-workspace', source: 'http://127.0.0.1:4210' });
  assert.equal(path.dirname(path.dirname(prepared.plan)), directory);
  const plan = JSON.parse(await fs.readFile(prepared.plan, 'utf8'));
  assert.equal(plan.org, 'example-org');
  assert.equal(plan.region, 'bog');
  assert.equal(plan.workspace, 'example-workspace');
  assert.equal(plan.source, 'http://127.0.0.1:4210');
});

test('prepare requires an explicit immutable image before creating any run files', async (t) => {
  const state = await fixture(t);
  const before = await fs.readdir(state.directory);
  for (const image of [undefined, 'registry.fly.io/synthetic-test:latest']) {
    await assert.rejects(prepare({ target: state.plan.target.url, flowId: state.plan.flowId,
      mcpName: state.plan.mcpName, image, directory: state.directory }), /immutable/);
  }
  assert.deepEqual(await fs.readdir(state.directory), before);
});

test('provision captures sequentially and reuses only matching ready journals on explicit continuation', async (t) => {
  const state = await fixture(t);
  await provision(state.prepared.plan, { bridge: state.bridge, env: {} });
  assert.equal(state.upCalls.length, 3);
  assert.equal(state.maxActive(), 1);
  const continued = await provision(state.prepared.plan, { bridge: state.bridge, env: {} });
  assert.equal(state.upCalls.length, 3);
  assert.ok(continued.every((worker) => worker.reused));
});

test('run dispatches three calls concurrently once, audits exact comments, and forbids replay', async (t) => {
  const state = await fixture(t);
  await provision(state.prepared.plan, { bridge: state.bridge, env: {} });
  let started = 0;
  let release;
  const allStarted = new Promise((resolve) => { release = resolve; });
  const comments = [];
  const bridge = { async call(options) {
    started += 1;
    const worker = state.plan.workers.find((candidate) => options.journal.endsWith(candidate.journal));
    for (const candidate of state.plan.workers) {
      assert.ok(await fs.stat(path.join(state.directory, candidate.callState)));
    }
    if (started === 3) release();
    await allStarted;
    comments.push({ id: worker.index, body: worker.commentBody,
      html_url: `${state.plan.target.url}#issuecomment-${worker.index}`, user: { login: 'synthetic-user' } });
    return { body: JSON.stringify({ completed: true }) };
  } };
  const fetchImpl = async (_url, options) => { assert.equal(options.redirect, 'error'); return Response.json(comments); };
  const result = await run(state.prepared.plan, { bridge, fetchImpl, env: {} });
  assert.equal(started, 3);
  assert.equal(result.passed, true);
  assert.ok(result.workers.every((worker) => worker.count === 1 && worker.exactBody));
  assert.deepEqual(result.workers.map((worker) => worker.machineId),
    ['synthetic-machine-1', 'synthetic-machine-2', 'synthetic-machine-3']);
  for (const worker of state.plan.workers) {
    const saved = JSON.parse(await fs.readFile(path.join(state.directory, worker.callState), 'utf8'));
    assert.equal(saved.app, worker.app);
    assert.equal(saved.machineId, `synthetic-machine-${worker.index}`);
    assert.ok(saved.dispatchedAt && saved.completedAt);
  }
  await assert.rejects(run(state.prepared.plan, { bridge, fetchImpl, env: {} }), /already dispatched/);
  assert.equal(started, 3);
});

test('pre-existing marker prevents all flow calls and duplicate audit remains read-only', async (t) => {
  const state = await fixture(t);
  await provision(state.prepared.plan, { bridge: state.bridge, env: {} });
  const comments = [1, 2].map((id) => ({ id, body: state.plan.workers[0].commentBody }));
  let calls = 0;
  const bridge = { async call() { calls += 1; throw new Error('must not execute'); } };
  const fetchImpl = async () => Response.json(comments);
  await assert.rejects(run(state.prepared.plan, { bridge, fetchImpl, env: {} }), /marker already exists/);
  assert.equal(calls, 0);
  const report = await audit(state.prepared.plan, { fetchImpl, env: {} });
  assert.equal(report.workers[0].state, 'duplicate');
  assert.equal(report.workers[0].count, 2);
});

test('uncertain calls are journaled without secret errors and can only be audited afterward', async (t) => {
  const state = await fixture(t);
  await provision(state.prepared.plan, { bridge: state.bridge, env: {} });
  const token = 'synthetic_private_token_that_must_not_be_saved';
  let calls = 0;
  const bridge = { async call() { calls += 1; throw new Error(token); } };
  const fetchImpl = async () => Response.json([]);
  const result = await run(state.prepared.plan, { bridge, fetchImpl, env: {} });
  assert.equal(result.passed, false);
  assert.equal(calls, 3);
  assert.ok(result.calls.every((call) => call.state === 'needs-reconciliation'));
  for (const worker of state.plan.workers) {
    const saved = await fs.readFile(path.join(state.directory, worker.callState), 'utf8');
    assert.ok(saved.includes('needs-reconciliation'));
    assert.ok(!saved.includes(token));
  }
  await assert.rejects(run(state.prepared.plan, { bridge, fetchImpl, env: {} }), /already dispatched/);
  assert.equal(calls, 3);
});

test('credential-bearing model responses are withheld without persisting or replaying them', async (t) => {
  const state = await fixture(t);
  await provision(state.prepared.plan, { bridge: state.bridge, env: {} });
  const token = 'synthetic_private_audit_token';
  const bridge = { async call() { return { body: JSON.stringify({ content: token }) }; } };
  const report = await run(state.prepared.plan, { bridge, fetchImpl: async () => Response.json([]),
    env: { FLUJO_GITHUB_AUDIT_TOKEN: token } });
  assert.ok(report.calls.every((call) => call.state === 'needs-reconciliation'));
  assert.ok(!JSON.stringify(report).includes(token));
  for (const worker of state.plan.workers) {
    await assert.rejects(fs.stat(path.join(state.directory, worker.result)), { code: 'ENOENT' });
    assert.ok(!(await fs.readFile(path.join(state.directory, worker.callState), 'utf8')).includes(token));
  }
});

test('GitHub audit uses fixed HTTPS read requests, pagination, and token-safe errors', async () => {
  const target = issueTarget('https://github.com/example/worker-test/issues/7');
  const token = 'synthetic_private_token';
  let pages = 0;
  const comments = await commentsForTarget(target, { token, fetchImpl: async (url, init) => {
    pages += 1;
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(init.method, undefined);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    return Response.json(pages === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }]);
  } });
  assert.equal(comments.length, 101);
  assert.equal(pages, 2);
  await assert.rejects(commentsForTarget(target, { token,
    fetchImpl: async () => { throw new Error(token); } }), (error) => !error.message.includes(token));
  assert.throws(() => issueTarget('https://github.com.evil.example/example/repo/issues/1'));
});
