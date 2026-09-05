import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../lib/machines.mjs';

test('Machines API uses existing CLI login in memory and preserves the exact pinned image', async () => {
  const token = 'synthetic_existing_fly_login_0123456789';
  const image = `registry.fly.io/test-image@sha256:${'a'.repeat(64)}`;
  let invocation;
  const result = await createMachine({ app: 'test-app', name: 'test-machine', region: 'iad',
    config: { image, services: [] }, env: {},
    run: async (args) => { assert.deepEqual(args, ['auth', 'token']); return `${token}\n`; },
    fetchImpl: async (url, init) => {
      invocation = { url, init };
      return Response.json({ id: 'abcd1234' });
    },
  });
  assert.equal(result.id, 'abcd1234');
  assert.equal(invocation.url, 'https://api.machines.dev/v1/apps/test-app/machines');
  assert.equal(invocation.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(invocation.init.redirect, 'error');
  assert.equal(JSON.parse(invocation.init.body).config.image, image);
  assert.ok(!invocation.init.body.includes(token));
});

test('Machines API never exposes failure response bodies or retries uncertain creation', async () => {
  let requests = 0;
  await assert.rejects(createMachine({ app: 'test-app', name: 'test-machine', region: 'iad',
    config: {}, env: { FLY_API_TOKEN: 'synthetic_fly_api_token_0123456789' },
    fetchImpl: async () => { requests += 1; return new Response('private response body', { status: 422 }); },
  }), (error) => /HTTP 422/.test(error.message) && !error.message.includes('private response body'));
  assert.equal(requests, 1);
});

test('Machines API withholds transport and redirect failures without retrying', async () => {
  const token = 'synthetic_fly_api_token_0123456789';
  let requests = 0;
  await assert.rejects(createMachine({ app: 'test-app', name: 'test-machine', region: 'iad',
    config: {}, env: { FLY_API_TOKEN: token },
    fetchImpl: async (_url, init) => {
      requests += 1;
      assert.equal(init.redirect, 'error');
      throw new Error(`Redirect failed for Authorization Bearer ${token}`);
    },
  }), (error) => /request failed/.test(error.message) && !error.message.includes(token));
  assert.equal(requests, 1);
});
