import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Journal } from './journal.mjs';
import { createFlyRunner, unusedLoopbackPort } from './process.mjs';
import { encryptSnapshot } from './envelope.mjs';
import { captureSnapshot, controlToken, loopbackOrigin } from './snapshot.mjs';
import { createMachine } from './machines.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER_KEY = 'flujo_cloud_owner';
const WORKER_COMMAND = ['node', '/app/scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '::'];

export function validateOptions(input) {
  const result = {
    ...input,
    source: loopbackOrigin(input.source || 'http://127.0.0.1:4200'),
    authState: input.authState || 'copied-workspace',
    memoryMb: Number(input.memoryMb ?? 2048),
    volumeGb: Number(input.volumeGb ?? 2),
    timeoutMs: Number(input.timeoutMs ?? 600_000),
    maxSnapshotBytes: Number(input.maxSnapshotBytes ?? 256 * 1024 * 1024),
  };
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(result.app ?? '')) throw new Error('Choose an explicit Fly app name with --app.');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(result.org ?? '')) throw new Error('Choose an explicit Fly organization slug with --org.');
  if (!/^[a-z]{3}$/.test(result.region ?? '')) throw new Error('Choose an explicit three-letter Fly region with --region.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result.workspace ?? '')
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result.workspace)) throw new Error('Choose a valid explicit FLUJO workspace with --workspace.');
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(result.image ?? '')) throw new Error('--image must be an immutable registry image reference ending in @sha256:<64 hex characters>.');
  if (result.authState !== 'copied-workspace') throw new Error('Only --auth-state=copied-workspace is supported.');
  if (result.flowIds !== undefined) {
    if (!Array.isArray(result.flowIds) || result.flowIds.length > 100
      || result.flowIds.some((id) => typeof id !== 'string' || !ID_PATTERN.test(id))) {
      throw new Error('Flow scope must contain valid flow IDs (at most 100).');
    }
    result.flowIds = [...new Set(result.flowIds)];
  }
  for (const [name, min, max] of [['memoryMb', 1024, 32768], ['volumeGb', 1, 100], ['timeoutMs', 1000, 3_600_000], ['maxSnapshotBytes', 1024, 1024 * 1024 * 1024]]) {
    if (!Number.isSafeInteger(result[name]) || result[name] < min || result[name] > max) throw new Error(`Invalid ${name}.`);
  }
  if (!result.journal) throw new Error('Choose a local journal path with --journal.');
  return result;
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`Fly ${label} did not return valid JSON.`); }
}
function arrayJson(text, label) {
  const value = parseJson(text, label);
  if (!Array.isArray(value)) throw new Error(`Fly ${label} did not return a JSON array.`);
  return value;
}
function pick(object, name) { return object?.[name] ?? object?.[name.toLowerCase()]; }
function machineConfig(machine) { return machine.config ?? machine.Config ?? {}; }
function machineId(machine) { return pick(machine, 'ID'); }
function appOwnershipMarker(record) { return `FLUJO_CLOUD_OWNER_${record.owner.replaceAll('-', '').toUpperCase()}`; }

function assertPinnedImage(machine, record) {
  const digest = machine.image_ref?.digest ?? machine.ImageRef?.Digest;
  if (digest !== record.image.slice(record.image.lastIndexOf('@') + 1)) {
    throw new Error('Worker image digest does not match the immutable image in the journal.');
  }
}

function assertOwnedMachine(machine, record) {
  const config = machineConfig(machine);
  if (!ID_PATTERN.test(machineId(machine) ?? '') || pick(machine, 'Name') !== record.machineName
    || config.metadata?.[OWNER_KEY] !== record.owner) throw new Error('Machine ownership does not match the journal.');
  if ((config.services ?? []).length !== 0 || (config.containers ?? []).some((container) => (container.services ?? []).length !== 0)) {
    throw new Error('Worker has a public Fly service configuration; refusing to use it.');
  }
  if (record.machineId && machineId(machine) !== record.machineId) throw new Error('Machine ID no longer matches the journal.');
}

export function buildMachineConfig(record, { idle, memoryMb = 2048 }) {
  return {
    image: record.image,
    init: { cmd: idle ? ['sleep', 'infinity'] : WORKER_COMMAND },
    env: {
      NODE_ENV: 'production',
      FLUJO_WORKER_MODE: '1',
      FLUJO_EXPOSURE_MODE: 'localhost',
      FLUJO_DATA_DIR: '/data/flujo',
      FLUJO_WORKER_SNAPSHOT: '/data/worker.snapshot',
      FLUJO_WORKER_SNAPSHOT_SHA256: record.archiveSha256,
    },
    metadata: { [OWNER_KEY]: record.owner },
    mounts: [{ volume: record.volumeId, path: '/data' }],
    services: [],
    checks: {},
    guest: { cpu_kind: 'shared', cpus: 2, memory_mb: memoryMb },
    restart: { policy: 'on-failure', max_retries: 3 },
  };
}

export class CloudBridge {
  constructor({ fly = createFlyRunner(), fetchImpl = fetch, sleepImpl = sleep,
    port = unusedLoopbackPort, progress = () => undefined } = {}) {
    this.fly = fly;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.port = port;
    this.progress = progress;
  }

  async apps(org) { return arrayJson(await this.fly.run(['apps', 'list', '--org', org, '--json']), 'apps list'); }
  async machines(app) { return arrayJson(await this.fly.run(['machine', 'list', '--app', app, '--json']), 'machine list'); }

  async machineCommand(record, command) {
    const result = parseJson(await this.fly.run(['machine', 'exec', record.machineId, command,
      '--app', record.app, '--json']), 'machine exec');
    if (result?.exit_code !== undefined && result.exit_code !== 0) {
      throw new Error('Worker permission setup command failed. Command output is withheld to protect credentials.');
    }
  }

  async ownedApp(record) {
    if (!record.appCreated || typeof record.appId !== 'string' || !record.appId) throw new Error('Journal has no confirmed app ownership. Inspect the incomplete creation manually.');
    const app = (await this.apps(record.org)).find((candidate) => pick(candidate, 'Name') === record.app);
    if (!app) return null;
    if (String(pick(app, 'ID')) !== record.appId) throw new Error('App identity changed; refusing to modify or delete it.');
    const organization = pick(app, 'Organization');
    if (pick(organization, 'Slug') !== record.org) throw new Error('App organization does not match the journal.');
    // Fly currently uses the app name as App.ID. A random marker survives
    // Machine replacement but disappears when a same-name app is recreated.
    if (!record.ownershipConfirmed) throw new Error('App ownership marker was not confirmed. Inspect the partial creation manually.');
    const secrets = arrayJson(await this.fly.run(['secrets', 'list', '--app', record.app, '--json']), 'secrets list');
    if (!secrets.some((secret) => pick(secret, 'Name') === appOwnershipMarker(record))) {
      throw new Error('App ownership marker is missing; refusing to use or delete a recreated app.');
    }
    return app;
  }

  async waitForMachine(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const machines = await this.machines(record.app);
      const owned = machines.filter((machine) => machineConfig(machine).metadata?.[OWNER_KEY] === record.owner);
      if (owned.length > 1) throw new Error('More than one worker Machine claims this journal.');
      if (owned.length === 1) {
        assertOwnedMachine(owned[0], record);
        if (pick(owned[0], 'State') === 'started') {
          assertPinnedImage(owned[0], record);
          return owned[0];
        }
      }
      await this.sleep(500);
    }
    throw new Error('Worker Machine did not start before the timeout.');
  }

  async withProxy(record, task) {
    const proxy = await this.fly.proxy({ app: record.app, org: record.org, machineId: record.machineId, localPort: await this.port() });
    try { return await task(proxy); }
    finally { await proxy.stop(); }
  }

  async ready(proxy, record, token, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      proxy.check();
      let response;
      try {
        response = await this.fetch(new URL('/api/worker/status', proxy.origin), {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
        });
      } catch { await this.sleep(500); continue; }
      if ([401, 403, 404].includes(response.status)) throw new Error(`Worker status rejected the request (HTTP ${response.status}). Check the image and control token.`);
      let status;
      try { status = await response.json(); } catch { await this.sleep(500); continue; }
      if (status.mode !== 'worker') throw new Error('Remote server is not running FLUJO worker mode.');
      if (['error', 'locked'].includes(status.state)) throw new Error(`Worker bootstrap is ${status.state}. Inspect its authenticated status for details.`);
      if (status.state === 'ready') {
        if (!response.ok || status.workspace !== record.workspace || status.archiveSha256 !== record.archiveSha256) {
          throw new Error('Ready worker does not match the requested workspace and snapshot.');
        }
        return status;
      }
      await this.sleep(500);
    }
    throw new Error('Worker did not become ready before the timeout.');
  }

  async up(input, env = process.env) {
    const options = validateOptions(input);
    const sourceToken = controlToken(env.FLUJO_SNAPSHOT_CONTROL_TOKEN, 'FLUJO_SNAPSHOT_CONTROL_TOKEN');
    const workerToken = controlToken(env.FLUJO_CLOUD_CONTROL_TOKEN, 'FLUJO_CLOUD_CONTROL_TOKEN');
    const journal = new Journal(options.journal);
    return journal.locked(async () => {
      const owner = randomUUID();
      const shortOwner = owner.replaceAll('-', '').slice(0, 12);
      const record = {
        format: 'flujo-cloud-journal', version: 1, owner, createdAt: new Date().toISOString(),
        state: 'starting', stage: 'snapshot', app: options.app, org: options.org, region: options.region,
        workspace: options.workspace, image: options.image, authState: options.authState, appCreated: false,
        ...(options.flowIds?.length ? { flowIds: options.flowIds } : {}),
        volumeName: `worker_${shortOwner}`, machineName: `worker-${shortOwner}`,
      };
      await journal.create(record);
      const temporary = await fs.mkdtemp(path.join(tmpdir(), 'flujo-cloud-'));
      await fs.chmod(temporary, 0o700).catch(() => undefined);
      const snapshotPath = path.join(temporary, 'worker.snapshot');
      const configPath = path.join(temporary, 'machine.json');
      let encrypted;
      try {
        this.progress('Capturing the selected local workspace.');
        const snapshot = await captureSnapshot({
          origin: options.source, workspace: options.workspace, token: sourceToken, fetchImpl: this.fetch,
          flowIds: options.flowIds,
          sleep: this.sleep, timeoutMs: options.timeoutMs, maxBytes: options.maxSnapshotBytes,
        });
        encrypted = encryptSnapshot(snapshot.bytes);
        snapshot.bytes.fill(0);
        record.archiveSha256 = encrypted.sha256;
        await fs.writeFile(snapshotPath, encrypted.envelope, { mode: 0o600, flag: 'wx' });
        record.stage = 'create-app';
        await journal.save(record);
        if ((await this.apps(options.org)).some((app) => pick(app, 'Name') === options.app)) {
          throw new Error('The requested Fly app already exists. Choose a new dedicated app name.');
        }
        this.progress('Creating the dedicated private Fly worker.');
        const app = parseJson(await this.fly.run(['apps', 'create', options.app, '--org', options.org, '--json', '--yes']), 'apps create');
        const appId = pick(app, 'ID');
        if (pick(app, 'Name') !== options.app || !appId || pick(pick(app, 'Organization'), 'Slug') !== options.org) {
          throw new Error('Created app identity could not be confirmed. Inspect it manually before cleanup.');
        }
        record.appId = String(appId);
        record.appCreated = true;
        record.stage = 'secrets';
        await journal.save(record);
        // Values are passed only over stdin and kept out of config, args, and journal.
        await this.fly.run(['secrets', 'import', '--app', options.app, '--stage'], {
          input: `${appOwnershipMarker(record)}="1"\nFLUJO_SNAPSHOT_CONTROL_TOKEN=${JSON.stringify(workerToken)}\nFLUJO_WORKER_SNAPSHOT_KEY=${JSON.stringify(encrypted.key.toString('base64'))}\n`,
        });
        const appSecrets = arrayJson(await this.fly.run(['secrets', 'list', '--app', options.app, '--json']), 'secrets list');
        if (!appSecrets.some((secret) => pick(secret, 'Name') === appOwnershipMarker(record))) {
          throw new Error('App ownership marker could not be confirmed.');
        }
        record.ownershipConfirmed = true;
        encrypted.key.fill(0);
        record.stage = 'create-volume';
        await journal.save(record);
        const rawVolume = parseJson(await this.fly.run([
          'volumes', 'create', record.volumeName, '--app', options.app, '--region', options.region,
          '--size', String(options.volumeGb), '--scheduled-snapshots=false', '--json', '--yes',
        ]), 'volumes create');
        const volume = Array.isArray(rawVolume) ? rawVolume[0] : rawVolume;
        if (pick(volume, 'Name') !== record.volumeName || !ID_PATTERN.test(pick(volume, 'ID') ?? '')) throw new Error('Created volume identity could not be confirmed.');
        record.volumeId = pick(volume, 'ID');
        record.stage = 'create-machine';
        await journal.save(record);
        const createdMachine = await createMachine({
          app: options.app, name: record.machineName, region: options.region,
          config: buildMachineConfig(record, { idle: true, memoryMb: options.memoryMb }),
          run: this.fly.run.bind(this.fly), env, fetchImpl: this.fetch,
        });
        assertOwnedMachine(createdMachine, record);
        record.machineId = machineId(createdMachine);
        await journal.save(record);
        const machine = await this.waitForMachine(record, options.timeoutMs);
        record.machineId = machineId(machine);
        record.stage = 'upload';
        await journal.save(record);
        await this.machineCommand(record, 'sh -c "mkdir -p /data/flujo && chown node:node /data /data/flujo"');
        await this.fly.run(['ssh', 'sftp', 'put', snapshotPath, '/data/worker.snapshot', '--app', options.app,
          '--machine', record.machineId, '--user', 'root', '--mode', '0600']);
        await this.machineCommand(record, 'chown node:node /data/worker.snapshot');
        record.stage = 'bootstrap';
        await journal.save(record);
        this.progress('Restoring FLUJO and checking worker readiness.');
        await fs.writeFile(configPath, JSON.stringify(buildMachineConfig(record, { idle: false, memoryMb: options.memoryMb })), { mode: 0o600 });
        await this.fly.run(['machine', 'update', record.machineId, '--app', options.app,
          '--machine-config', configPath, '--yes', '--detach']);
        await this.waitForMachine(record, options.timeoutMs);
        await this.withProxy(record, (proxy) => this.ready(proxy, record, workerToken, options.timeoutMs));
        record.state = 'ready';
        record.stage = 'ready';
        await journal.save(record);
        return { app: record.app, workspace: record.workspace, machineId: record.machineId, state: 'ready', journal: journal.filename };
      } catch (error) {
        record.state = 'failed';
        await journal.save(record).catch(() => undefined);
        throw error;
      } finally {
        encrypted?.key.fill(0);
        for (const filename of [snapshotPath, configPath]) await fs.unlink(filename).catch(() => undefined);
        await fs.rmdir(temporary).catch(() => undefined);
      }
    });
  }

  async call({ journal: filename, request, conversationId, timeoutMs = 600_000 }, env = process.env) {
    const token = controlToken(env.FLUJO_CLOUD_CONTROL_TOKEN, 'FLUJO_CLOUD_CONTROL_TOKEN');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new Error('Invalid request timeout.');
    const journal = new Journal(filename);
    return journal.locked(async () => {
      const record = await journal.read();
      if (record.flowIds?.length && !record.flowIds.includes(request.model)) {
        throw new Error('This worker is scoped to selected flows. Set request.model to one of the exact flow IDs recorded in its journal.');
      }
      if (!await this.ownedApp(record)) throw new Error('Journaled worker app no longer exists.');
      const machine = (await this.machines(record.app)).find((item) => machineId(item) === record.machineId);
      if (!machine) throw new Error('Journaled worker Machine no longer exists.');
      assertOwnedMachine(machine, record);
      assertPinnedImage(machine, record);
      return this.withProxy(record, async (proxy) => {
        await this.ready(proxy, record, token, timeoutMs);
        if (typeof request.model !== 'string' || !ID_PATTERN.test(request.model)) {
          throw new Error('Set request.model to a valid FLUJO flow ID. The bridge resolves its name for the completion API.');
        }
        const flowUrl = new URL(`/api/flow/${encodeURIComponent(request.model)}`, proxy.origin);
        flowUrl.searchParams.set('workspace', record.workspace);
        const flowResponse = await this.fetch(flowUrl, {
          headers: { Authorization: `Bearer ${token}`, 'x-flujo-workspace': record.workspace },
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
        if (!flowResponse.ok) throw new Error(`Flow lookup failed (HTTP ${flowResponse.status}). Use an exact flow ID from the restored workspace.`);
        const flow = await flowResponse.json();
        if (flow.id !== request.model || typeof flow.name !== 'string' || !flow.name) throw new Error('Flow lookup returned a mismatched identity.');
        const flowsUrl = new URL('/api/flow', proxy.origin);
        flowsUrl.searchParams.set('workspace', record.workspace);
        const flowsResponse = await this.fetch(flowsUrl, {
          headers: { Authorization: `Bearer ${token}`, 'x-flujo-workspace': record.workspace },
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
        if (!flowsResponse.ok) throw new Error('Could not verify unique flow-name routing.');
        const flows = await flowsResponse.json();
        const matches = Array.isArray(flows) ? flows.filter((candidate) => candidate?.name === flow.name) : [];
        if (matches.length !== 1 || matches[0].id !== flow.id) {
          throw new Error('Flow name is ambiguous or changed. Give this flow a unique name before using name-based completion routing.');
        }
        // FLUJO's current completion endpoint resolves flow-<name>, not IDs.
        const body = { ...request, model: `flow-${flow.name}`,
          metadata: { ...request.metadata, flujo: 'true', ...(conversationId ? { conversationId } : {}) } };
        const response = await this.fetch(new URL('/v1/chat/completions', proxy.origin), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-flujo-workspace': record.workspace },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Worker flow request failed (HTTP ${response.status}).`);
        // The CLI writes this model result only to stdout; it is never journaled.
        return { contentType: response.headers.get('content-type'), body: await response.text() };
      });
    });
  }

  async down({ journal: filename }) {
    const journal = new Journal(filename);
    return journal.locked(async () => {
      const record = await journal.read();
      if (record.state === 'destroyed') return { app: record.app, state: 'destroyed' };
      if (!await this.ownedApp(record)) {
        record.state = 'destroyed';
        await journal.save(record);
        return { app: record.app, state: 'destroyed' };
      }
      const machines = await this.machines(record.app);
      for (const machine of machines) assertOwnedMachine(machine, record);
      if (machines.length > 1) throw new Error('Extra Machines exist in the worker app; refusing app deletion.');
      const volumes = arrayJson(await this.fly.run(['volumes', 'list', '--app', record.app, '--json']), 'volumes list');
      for (const volume of volumes) {
        if (pick(volume, 'Name') !== record.volumeName || (record.volumeId && pick(volume, 'ID') !== record.volumeId)) {
          throw new Error('An unowned volume exists in the app; refusing app deletion.');
        }
      }
      if (volumes.length > 1) throw new Error('Extra volumes exist in the worker app; refusing app deletion.');
      record.stage = 'destroy-app';
      await journal.save(record);
      await this.fly.run(['apps', 'destroy', record.app, '--yes']);
      record.state = 'destroyed';
      record.stage = 'destroyed';
      await journal.save(record);
      return { app: record.app, state: 'destroyed' };
    });
  }
}
