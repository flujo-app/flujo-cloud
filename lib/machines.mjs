/** Create without flyctl's positional-image resolver, which can append a digest twice. */
export async function createMachine({ app, name, region, config, run, env = process.env, fetchImpl = fetch }) {
  let token = (env.FLY_API_TOKEN || await run(['auth', 'token'])).trim();
  if (token.length < 20 || token.length > 16_384 || /[\r\n]/.test(token)) {
    throw new Error('Fly login did not provide a valid API token.');
  }
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
