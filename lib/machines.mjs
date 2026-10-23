const ORG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP = /^[a-z][a-z0-9-]{2,62}$/;
const APP_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Organization inventory includes unrelated networks. Preserve Fly's name case;
// the product's own creation option has a separate, narrower policy.
const INVENTORY_NETWORK = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;

async function flyToken(env, run) {
  const raw = env.FLY_API_TOKEN || await run(['auth', 'token']);
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token.length < 20 || token.length > 16_384 || /[\r\n]/.test(token)) {
    throw new Error('Fly login did not provide a valid API token.');
  }
  return token;
}

/** Complete selected-org Machines API inventory. The caller owns group membership policy. */
export async function listOrgApps({ org, run, env = process.env, fetchImpl = fetch }) {
  if (typeof org !== 'string' || !ORG.test(org)) throw new Error('Invalid Fly organization for app inventory.');
  let token = await flyToken(env, run);
  try {
    let response;
    try {
      const url = new URL('https://api.machines.dev/v1/apps');
      url.searchParams.set('org_slug', org);
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Encoding': 'identity' } });
    } catch { throw new Error('Fly organization app inventory request failed.'); }
    if (!response.ok || response.redirected || response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Fly organization app inventory was unavailable.');
    }
    const declared = response.headers?.get('content-length');
    // Fetch can decode a compressed body while retaining the encoded wire
    // Content-Length. Compare lengths only when the response is identity-coded.
    const encoding = response.headers?.get('content-encoding')?.trim().toLowerCase();
    const identityBody = !encoding || encoding === 'identity';
    if (identityBody && declared !== null && declared !== undefined
      && (!/^\d+$/.test(declared) || Number(declared) > MAX_INVENTORY_BYTES)) {
      throw new Error('Fly organization app inventory was truncated or oversized.');
    }
    if (!response.body) throw new Error('Fly organization app inventory body was missing.');
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_INVENTORY_BYTES) throw new Error('Fly organization app inventory was oversized.');
        chunks.push(chunk);
      }
    } catch { throw new Error('Fly organization app inventory was truncated or oversized.'); }
    if (!size || (identityBody && declared !== null && declared !== undefined && size !== Number(declared))) {
      throw new Error('Fly organization app inventory was truncated.');
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Fly organization app inventory was not valid JSON.'); }
    if (!value || Array.isArray(value) || !Number.isSafeInteger(value.total_apps)
      || value.total_apps < 0 || value.total_apps > 10_000 || !Array.isArray(value.apps)
      || value.apps.length !== value.total_apps) {
      throw new Error('Fly organization app inventory is incomplete.');
    }
    const ids = new Set();
    const names = new Set();
    const apps = value.apps.map(app => {
      if (!app || Array.isArray(app) || typeof app.id !== 'string' || !APP_ID.test(app.id)
        || typeof app.name !== 'string' || !APP.test(app.name)
        || typeof app.network !== 'string' || !INVENTORY_NETWORK.test(app.network)
        || ids.has(app.id) || names.has(app.name)) {
        throw new Error('Fly organization app inventory has invalid identities or networks.');
      }
      ids.add(app.id); names.add(app.name);
      return { id: app.id, name: app.name, network: app.network };
    });
    return { org, totalApps: value.total_apps, apps };
  } finally { token = ''; }
}

/** Create without flyctl's positional-image resolver, which can append a digest twice. */
export async function createMachine({ app, name, region, config, run, env = process.env, fetchImpl = fetch }) {
  let token = await flyToken(env, run);
  try {
    let response;
    try {
      response = await fetchImpl(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, region, config }),
      });
    } catch { throw new Error('Fly Machines API creation request failed. Inspect the journaled app before retrying.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Fly Machines API creation failed (HTTP ${response.status}). Response body is withheld to protect credentials.`);
    }
    try { return await response.json(); }
    catch { throw new Error('Fly Machines API creation returned invalid JSON. Inspect the journaled app before retrying.'); }
  } finally { token = ''; }
}
