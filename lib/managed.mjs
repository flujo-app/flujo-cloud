import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { CloudBridge, validateOptions } from './bridge.mjs';
import { Journal } from './journal.mjs';
import { createFlyRunner } from './process.mjs';
import { controlToken, loopbackOrigin, boundedBody } from './snapshot.mjs';
import { discoverSources } from './discovery.mjs';
import { resolveWorkerImage } from './images.mjs';
import { assertPrivateDirectory, ensurePrivateDirectory, readPrivateJson, writePrivateJson } from './private-files.mjs';

const APP = /^[a-z][a-z0-9-]{2,62}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ORG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REGION = /^[a-z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASES = new Set(['preparing', 'provisioning', 'ready', 'destroyed']);
const RETIREMENTS = new Set(['local-preparation', 'local-capture', 'cloud-confirmed']);
const pick = (value, key) => value?.[key] ?? value?.[key.toLowerCase()];

async function optional(task) {
  try { return await task(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function metadataValid(metadata, id) {
  return metadata?.format === 'flujo-managed-deployment' && metadata.version === 1 && metadata.id === id
    && UUID.test(metadata.attemptId ?? '') && PHASES.has(metadata.phase)
    && (metadata.journalOwner === undefined || UUID.test(metadata.journalOwner))
    && metadata.image !== undefined && WORKSPACE.test(metadata.workspace ?? '') && ORG.test(metadata.org ?? '')
    && (metadata.phase !== 'destroyed' || RETIREMENTS.has(metadata.retirement));
}

function matchingJournal(journal, metadata, { requireOwner = true } = {}) {
  if (journal.app !== metadata.id || journal.image !== metadata.image || journal.workspace !== metadata.workspace
    || journal.org !== metadata.org || !UUID.test(journal.owner ?? '')
    || (requireOwner && metadata.journalOwner !== journal.owner)
    || (metadata.journalOwner && metadata.journalOwner !== journal.owner)) {
    throw new Error('Managed deployment and journal identities do not match. Keep all files and reconcile the attempt.');
  }
}

function captureNeverCreatedApp(journal) {
  return journal.state === 'failed' && journal.stage === 'snapshot' && journal.appCreated === false
    && !journal.appId && !journal.machineId && !journal.volumeId && !journal.ownershipConfirmed;
}

/** The same application service is usable by the CLI and a future MCP adapter. */
export class ManagedCloud {
  constructor({ env = process.env, directory, fetchImpl = fetch, discover = discoverSources,
    resolveImage = resolveWorkerImage, fly, bridge, progress = () => undefined, writeJson = writePrivateJson } = {}) {
    this.env = { ...env };
    this.directory = path.resolve(directory || env.FLUJO_CLOUD_HOME || path.join(os.homedir(), '.flujo-cloud'));
    this.fetch = fetchImpl;
    this.discover = discover;
    this.resolveImage = resolveImage;
    this.fly = fly;
    this.bridge = bridge;
    this.progress = progress;
    this.writeJson = writeJson;
  }

  async runtime() {
    if (!this.fly) {
      if (!this.env.FLYCTL_PATH) {
        const conventional = path.join(os.homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
        try { if ((await fs.stat(conventional)).isFile()) this.env.FLYCTL_PATH = conventional; }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not inspect the local Fly CLI installation.'); }
      }
      this.fly = createFlyRunner({ env: this.env, binary: this.env.FLYCTL_PATH || 'flyctl' });
    }
    this.bridge ??= new CloudBridge({ fly: this.fly, fetchImpl: this.fetch, progress: this.progress });
    return this.bridge;
  }

  async json(url, { token, workspace, label = 'FLUJO', maxBytes = 8 * 1024 * 1024 } = {}) {
    let response;
    try {
      response = await this.fetch(url, { headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(workspace ? { 'x-flujo-workspace': workspace } : {}),
      }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error(`${label} could not be reached.`); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 423) throw new Error('Unlock the selected workspace in local FLUJO, then try again.');
      throw new Error(`${label} rejected the request (HTTP ${response.status}).`);
    }
    try { return JSON.parse((await boundedBody(response, maxBytes)).toString('utf8')); }
    catch { throw new Error(`${label} returned an invalid or oversized response.`); }
  }

  async source(input = {}) {
    const origin = input.source ? loopbackOrigin(input.source) : undefined;
    const sources = await this.discover({ source: origin, env: this.env, fetchImpl: this.fetch });
    if (sources.length > 1) throw new Error('Multiple local FLUJO instances are running. Use sources, then select one with --source URL.');
    if (sources.length === 1) {
      if (!path.isAbsolute(sources[0].dataRoot ?? '')) throw new Error('Local FLUJO discovery lacks a valid data-root identity.');
      return sources[0];
    }
    // Legacy/operator deployments remain in CloudBridge with explicit --journal.
    // Managed deployments need the verified data root to keep newly generated
    // worker credentials outside every workspace that can enter the snapshot.
    throw new Error('No registered local FLUJO instance is available. Start an updated native FLUJO installation, then run sources. Older/container installations can use operator mode with --journal.');
  }

  async sources() {
    const sources = await this.discover({ env: this.env, fetchImpl: this.fetch });
    return sources.map(({ source, instanceId, appRoot, dataRoot }) => ({ source, instanceId, appRoot, dataRoot }));
  }

  async workspaces(input = {}) {
    const source = await this.source(input);
    const result = await this.json(new URL('/api/workspaces', source.source), { token: source.token, label: 'Local workspace discovery' });
    if (!Array.isArray(result.workspaces) || result.workspaces.some(workspace => !WORKSPACE.test(workspace?.name ?? ''))) {
      throw new Error('Local FLUJO returned an invalid workspace inventory.');
    }
    return { source: source.source, workspaces: result.workspaces.map(workspace => ({ name: workspace.name })), defaultWorkspace: result.defaultWorkspace };
  }

  async organization(input) {
    await this.runtime();
    let organizations;
    try { organizations = JSON.parse(await this.fly.run(['orgs', 'list', '--json'])); }
    catch { throw new Error('Fly account discovery failed. Install/sign in with the Fly CLI, then try again.'); }
    const slugs = Array.isArray(organizations) ? organizations.map(org => pick(org, 'Slug'))
      : organizations && typeof organizations === 'object' ? Object.keys(organizations) : [];
    if (!slugs.length || slugs.some(slug => !ORG.test(slug))) throw new Error('Fly returned no usable organizations. Sign in with the Fly CLI.');
    if (input) {
      if (!ORG.test(input) || !slugs.includes(input)) throw new Error('The selected Fly organization is not available to the signed-in account.');
      return input;
    }
    if (slugs.length !== 1) throw new Error(`Choose the billing organization with --org: ${slugs.join(', ')}.`);
    return slugs[0];
  }

  async prepare(input = {}) {
    if (!WORKSPACE.test(input.workspace ?? '')) throw new Error('Choose a workspace with --workspace NAME. Use workspaces to list local choices.');
    if (input.region && !REGION.test(input.region)) throw new Error('Choose a valid three-letter Fly region.');
    if (input.app && !APP.test(input.app)) throw new Error('Choose a valid new Fly app name.');
    const source = await this.source(input);
    if (source.dataRoot) {
      const relative = path.relative(path.resolve(source.dataRoot, 'workspaces'), this.directory);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('Private cloud-controller state must be stored outside the source workspace namespace.');
      }
    }
    const infoUrl = new URL('/api/snapshot/info', source.source);
    infoUrl.searchParams.set('workspace', input.workspace);
    const info = await this.json(infoUrl, { token: source.token, workspace: input.workspace, label: 'Local snapshot preflight', maxBytes: 64 * 1024 });
    if (info.workspace !== input.workspace || info.capability !== 'available') throw new Error('The selected workspace is unavailable or busy. Finish its active snapshot/mutation and try again.');
    const flowUrl = new URL('/api/flow', source.source);
    flowUrl.searchParams.set('workspace', input.workspace);
    const flows = await this.json(flowUrl, { token: source.token, workspace: input.workspace, label: 'Local flow discovery' });
    if (!Array.isArray(flows) || flows.some(flow => !ID.test(flow?.id ?? '') || typeof flow.name !== 'string')) throw new Error('Local FLUJO returned invalid flow identities.');
    const requested = input.flowIds?.length ? input.flowIds : [flows.find(flow => flow.id === 'default-agent-flujo')?.id
      || (flows.length === 1 ? flows[0].id : '')];
    const selected = requested.map(identifier => {
      if (typeof identifier !== 'string' || !identifier) throw new Error('Select a flow with --flow ID_OR_NAME.');
      const exact = flows.filter(flow => flow.id === identifier);
      const matches = exact.length ? exact : flows.filter(flow => flow.name === identifier);
      if (matches.length !== 1) throw new Error('A selected flow is missing or ambiguous. Use its exact flow ID.');
      if (flows.filter(flow => flow.name === matches[0].name).length !== 1) throw new Error('The selected flow name is ambiguous. Give it a unique name in FLUJO.');
      return { id: matches[0].id, name: matches[0].name };
    }).filter((flow, index, all) => all.findIndex(other => other.id === flow.id) === index);
    const resolved = await this.resolveImage({ source: info.workerCompatibility, image: input.image, channel: input.channel, fetchImpl: this.fetch });
    const org = await this.organization(input.org);
    const app = input.app || `flujo-${input.workspace.toLowerCase().replaceAll('_', '-').slice(0, 28)}-${randomUUID().slice(0, 8)}`;
    const journal = this.paths(app).journal;
    const options = validateOptions({ ...input, source: source.source, workspace: input.workspace,
      image: resolved.image, org, region: input.region || 'iad', app, journal, flowIds: selected.map(flow => flow.id) });
    return { options, source, resolved, selected };
  }

  async preflight(input) {
    const { options, source, resolved, selected } = await this.prepare(input);
    return { source: source.source, workspace: options.workspace, flows: selected, org: options.org,
      region: options.region, image: resolved, readyToDeploy: true };
  }

  paths(id) {
    if (!APP.test(id ?? '')) throw new Error('Use a worker ID returned by up or list.');
    const root = path.join(this.directory, 'workers');
    return { root, journal: path.join(root, `${id}.journal.json`), credentials: path.join(root, `${id}.credentials.json`),
      metadata: path.join(root, `${id}.deployment.json`), operationLock: path.join(root, `${id}.managed.lock`) };
  }

  async operation(id, action, task, { create = false } = {}) {
    const files = this.paths(id);
    if (create) {
      await ensurePrivateDirectory(this.directory);
      await ensurePrivateDirectory(files.root);
    } else await assertPrivateDirectory(files.root);
    const operationId = randomUUID();
    try {
      await writePrivateJson(files.operationLock, { format: 'flujo-managed-operation', version: 1,
        id, operationId, action, pid: process.pid }, { exclusive: true });
    } catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error('This worker has an active or interrupted managed operation. Reconcile it before removing its managed lock.'), { code: 'MANAGED_BUSY' });
      throw error;
    }
    try { return await task(files); }
    finally {
      const lock = await readPrivateJson(files.operationLock);
      if (lock.format !== 'flujo-managed-operation' || lock.id !== id || lock.operationId !== operationId) {
        throw new Error('Managed operation lock identity changed; refusing to remove it.');
      }
      await fs.unlink(files.operationLock);
    }
  }

  async saveMetadata(files, metadata) {
    const current = await readPrivateJson(files.metadata);
    if (!metadataValid(current, metadata.id) || current.attemptId !== metadata.attemptId) {
      throw new Error('Managed attempt identity changed; refusing to replace its metadata.');
    }
    await this.writeJson(files.metadata, metadata);
  }

  async bindJournal(files, metadata, phase = metadata.phase) {
    const journal = await optional(() => new Journal(files.journal).read());
    if (!journal) return null;
    matchingJournal(journal, metadata, { requireOwner: false });
    if (journal.state !== (phase === 'ready' ? 'ready' : 'failed')) {
      throw new Error('Worker provisioning outcome does not match its journal. Keep the attempt files and reconcile them.');
    }
    const next = { ...metadata, journalOwner: journal.owner, phase };
    await this.saveMetadata(files, next);
    return next;
  }

  async credential(files, metadata, { required = false } = {}) {
    const credentials = await optional(() => readPrivateJson(files.credentials));
    if (!credentials && !required) return null;
    if (credentials?.format !== 'flujo-worker-credential' || credentials.version !== 1
      || credentials.id !== metadata.id || credentials.attemptId !== metadata.attemptId) {
      throw new Error('Worker credential does not match this managed attempt; refusing to use or remove it.');
    }
    return credentials;
  }

  async retire(files, metadata, retirement) {
    // Record the confirmed outcome before deleting the matching credential. A
    // crash between these writes can safely finish on the next down command.
    await this.credential(files, metadata);
    await this.saveMetadata(files, { ...metadata, phase: 'destroyed', retirement });
    if (await this.credential(files, metadata)) await fs.unlink(files.credentials);
    return { app: metadata.id, worker: metadata.id, state: 'destroyed', localOnly: retirement !== 'cloud-confirmed' };
  }

  async up(input) {
    const { options, source, resolved, selected } = await this.prepare(input);
    return this.operation(options.app, 'up', async files => {
      for (const filename of [files.metadata, files.credentials, files.journal, `${files.journal}.lock`, `${files.journal}.next`]) {
        if (await optional(() => fs.lstat(filename))) throw new Error('A managed attempt or recovery artifact already exists for this worker. Reconcile it or choose a new app name.');
      }
      const attemptId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      let metadata = { format: 'flujo-managed-deployment', version: 1, id: options.app, attemptId, phase: 'preparing',
        source: source.source, workspace: options.workspace, org: options.org, region: options.region,
        image: resolved.image, createdAt: new Date().toISOString() };
      await this.writeJson(files.metadata, metadata, { exclusive: true });
      await this.writeJson(files.credentials, { format: 'flujo-worker-credential', version: 1, id: options.app, attemptId, token }, { exclusive: true });
      const bridge = await this.runtime();
      this.progress(`Deploying ${options.workspace} with ${resolved.mode === 'official' ? `official FLUJO ${resolved.applicationVersion}` : 'the selected custom image'}.`);
      metadata = { ...metadata, phase: 'provisioning' };
      // This durable fence precedes calling the bridge. A missing journal after
      // this point is uncertain and must never trigger automatic local cleanup.
      await this.saveMetadata(files, metadata);
      let result;
      try {
        result = await bridge.up(options, { ...this.env, FLUJO_SNAPSHOT_CONTROL_TOKEN: source.token, FLUJO_CLOUD_CONTROL_TOKEN: token });
      } catch (error) {
        // The operator interface has a separate journal lock. A journal created
        // concurrently by that interface is not ours to adopt after contention.
        if (error.code !== 'EEXIST' && !error.message?.startsWith('This worker journal is locked by another command.')) {
          await this.bindJournal(files, metadata);
        }
        throw error;
      }
      if (result.state !== 'ready' || !await this.bindJournal(files, metadata, 'ready')) {
        throw new Error('Worker provisioning outcome is incomplete. Keep the attempt files and reconcile its journal.');
      }
      return { ...result, worker: options.app, flows: selected, region: options.region, org: options.org,
        image: resolved.mode === 'official' ? { version: resolved.applicationVersion, revision: resolved.revision } : { mode: 'explicit' } };
    }, { create: true });
  }

  async deployment(id, { optionalJournal = false, allowUnboundJournal = false } = {}) {
    const files = this.paths(id);
    const metadata = await readPrivateJson(files.metadata);
    if (!metadataValid(metadata, id)) throw new Error('Managed deployment identity is invalid.');
    const journal = optionalJournal ? await optional(() => new Journal(files.journal).read()) : await new Journal(files.journal).read();
    if (journal) matchingJournal(journal, metadata, { requireOwner: !allowUnboundJournal || Boolean(metadata.journalOwner) });
    return { files, metadata, journal };
  }

  async call(id, { request, conversationId, timeoutMs } = {}) {
    return this.operation(id, 'call', async () => {
      const { files, metadata, journal } = await this.deployment(id);
      if (metadata.phase === 'destroyed') throw new Error('This managed deployment has been retired.');
      const credentials = await this.credential(files, metadata, { required: true });
      const token = controlToken(credentials.token, 'Saved worker credential');
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Provide a JSON flow request.');
      const model = request.model || (journal.flowIds?.length === 1 ? journal.flowIds[0] : undefined);
      const bridge = await this.runtime();
      const response = await bridge.call({ journal: files.journal, request: { ...request, model }, conversationId, timeoutMs }, {
        ...this.env, FLUJO_CLOUD_CONTROL_TOKEN: token,
      });
      if ([token, this.env.FLUJO_SNAPSHOT_CONTROL_TOKEN, this.env.FLY_API_TOKEN].filter(value => typeof value === 'string' && value.length >= 8)
        .some(value => response.body.includes(value) || response.body.includes(JSON.stringify(value).slice(1, -1)))) {
        throw new Error('The worker response contained a controller credential and was withheld.');
      }
      return response;
    });
  }

  async list() {
    const directory = path.join(this.directory, 'workers');
    let files;
    try { files = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Could not read managed worker inventory.'); }
    if (files.length > 10_000) throw new Error('Managed worker inventory exceeds the supported limit.');
    const results = [];
    for (const file of files.filter(file => file.endsWith('.deployment.json')).sort()) {
      const id = file.slice(0, -'.deployment.json'.length);
      const paths = this.paths(id);
      const metadata = await readPrivateJson(paths.metadata);
      if (!metadataValid(metadata, id)) throw new Error('Managed deployment identity is invalid.');
      let journal;
      try { journal = (await this.deployment(id, { allowUnboundJournal: true })).journal; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      results.push({ worker: id, workspace: metadata.workspace, org: metadata.org, region: metadata.region,
        state: metadata.phase === 'destroyed' ? 'destroyed' : journal?.state || metadata.phase,
        phase: metadata.phase, machineId: journal?.machineId || null, stateSource: journal ? 'local-journal' : 'local-attempt' });
    }
    return results;
  }

  async down(id) {
    return this.operation(id, 'down', async () => {
      const { files, metadata, journal } = await this.deployment(id, { optionalJournal: true });
      await this.credential(files, metadata);
      if (metadata.phase === 'destroyed') {
        if (journal && journal.state !== 'destroyed') throw new Error('Managed retirement and journal state disagree; reconcile before cleanup.');
        return this.retire(files, metadata, metadata.retirement);
      }
      if (!journal) {
        if (metadata.phase !== 'preparing') throw new Error('The provisioning journal is missing and cloud creation may have begun. Keep credentials and reconcile the remote state.');
        return this.retire(files, metadata, 'local-preparation');
      }
      if (metadata.phase === 'provisioning' && captureNeverCreatedApp(journal)) {
        // Use the bridge journal lock too: an operator command must not race the
        // final capture-only check. Preserve the journal as the audit record.
        await new Journal(files.journal).locked(async () => {
          const current = await new Journal(files.journal).read();
          matchingJournal(current, metadata);
          if (!captureNeverCreatedApp(current)) throw new Error('The capture-only recovery state changed; refusing local cleanup.');
          await new Journal(files.journal).save({ ...current, state: 'destroyed', stage: 'destroyed' });
        });
        return this.retire(files, metadata, 'local-capture');
      }
      if (metadata.phase === 'provisioning' && journal.state === 'destroyed' && journal.stage === 'destroyed'
        && journal.appCreated === false && !journal.appId && !journal.machineId && !journal.volumeId && !journal.ownershipConfirmed) {
        // Finish a capture-only retirement interrupted after saving the journal.
        return this.retire(files, metadata, 'local-capture');
      }
      const bridge = await this.runtime();
      const result = await bridge.down({ journal: files.journal });
      if (result.state === 'destroyed') return this.retire(files, metadata, 'cloud-confirmed');
      return { ...result, worker: id };
    });
  }
}
