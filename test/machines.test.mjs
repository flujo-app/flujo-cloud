import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachine, listOrgApps } from '../lib/machines.mjs';

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

test('selected-org Machines API inventory verifies the complete app ID/name/network set', async () => {
  const token = 'synthetic_fly_api_token_0123456789';
  let request;
  const inventory = await listOrgApps({ org: 'personal', env: { FLY_API_TOKEN: token },
    run: async () => { throw new Error('Unexpected CLI token read'); },
    fetchImpl: async (url, init) => {
      request = { url: new URL(url), init };
      return Response.json({ total_apps: 2, apps: [
        { id: 'app-1', name: 'worker-one', network: 'seagulled-g-abc' },
        { id: 'app-2', name: 'unrelated-app', network: 'default' },
      ] });
    } });
  assert.deepEqual(inventory, { org: 'personal', totalApps: 2, apps: [
    { id: 'app-1', name: 'worker-one', network: 'seagulled-g-abc' },
    { id: 'app-2', name: 'unrelated-app', network: 'default' },
  ] });
  assert.equal(request.url.href, 'https://api.machines.dev/v1/apps?org_slug=personal');
  assert.equal(request.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers['Accept-Encoding'], 'identity');
});

test('decoded compressed inventory remains bounded without comparing encoded Content-Length', async () => {
  const inventory = { total_apps: 1, apps: [{ id: 'app-1', name: 'worker-one', network: 'goal-net' }] };
  const result = await listOrgApps({ org: 'personal', env: { FLY_API_TOKEN: 'synthetic_fly_api_token_0123456789' },
    fetchImpl: async () => new Response(JSON.stringify(inventory), {
      headers: { 'content-encoding': 'gzip', 'content-length': '37' },
    }),
  });
  assert.deepEqual(result.apps, [{ id: 'app-1', name: 'worker-one', network: 'goal-net' }]);
});

test('complete inventory retains unrelated short and mixed-case custom network names', async () => {
  const result = await listOrgApps({ org: 'personal', env: { FLY_API_TOKEN: 'synthetic_fly_api_token_0123456789' },
    fetchImpl: async () => Response.json({ total_apps: 3, apps: [
      { id: 'app-1', name: 'worker-one', network: 'seagulled-g-abc' },
      { id: 'app-2', name: 'unrelated-one', network: 'Q' },
      { id: 'app-3', name: 'unrelated-two', network: 'Mixed-Case7' },
    ] }),
  });
  assert.deepEqual(result.apps.map(app => app.network), ['seagulled-g-abc', 'Q', 'Mixed-Case7']);
});

test('selected-org inventory rejects redirect, truncation, missing network and duplicate identity', async () => {
  const cases = [
    () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid' } }),
    () => Response.json({ total_apps: 2, apps: [{ id: 'app-1', name: 'worker-one', network: 'goal-net' }] }),
    () => Response.json({ total_apps: 1, apps: [{ id: 'app-1', name: 'worker-one' }] }),
    () => Response.json({ total_apps: 2, apps: [
      { id: 'app-1', name: 'worker-one', network: 'goal-net' },
      { id: 'app-1', name: 'worker-two', network: 'goal-net' },
    ] }),
    () => new Response('{"total_apps":0,"apps":[]}', { headers: { 'content-length': '999' } }),
  ];
  for (const response of cases) {
    let requests = 0;
    await assert.rejects(listOrgApps({ org: 'personal', env: { FLY_API_TOKEN: 'synthetic_fly_api_token_0123456789' },
      fetchImpl: async () => { requests += 1; return response(); },
    }), /inventory/);
    assert.equal(requests, 1);
  }
});
