import { randomUUID } from 'node:crypto';

export const PRIVATE_WORKSPACE_PROFILE = 'private-workspace';
export const WORKER_SNAPSHOT_SOURCE_VERSION = 1;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTRACT_FIELDS = ['applicationVersion', 'snapshotFormatVersion', 'layoutVersion', 'workerProtocolVersion', 'workerSnapshotSourceVersion'];
const SOURCE_FIELDS = ['sourceCompatibility', 'sourceRevision', 'sourceProvenance', 'targetRevision'];
const PROFILE_FIELDS = ['profile', 'recoveryId', 'recoveryEpoch', 'defaultFlowIds', ...SOURCE_FIELDS];

/** An omitted/flow input preserves the original flow deployment record shape. */
export function deploymentProfile(value) {
  if (value === undefined || value === 'flow') return undefined;
  if (value !== PRIVATE_WORKSPACE_PROFILE) throw new Error('Unknown deployment profile. Use flow or private-workspace.');
  return value;
}

export function validateProfileOptions(options) {
  const profile = deploymentProfile(options.profile);
  if (profile === undefined) {
    if (PROFILE_FIELDS.slice(1).some(key => options[key] !== undefined)) {
      throw new Error('Private-workspace identity cannot be applied to a legacy flow profile.');
    }
    delete options.profile;
    return options;
  }
  options.profile = profile;
  if (['app', 'org', 'region', 'workspace', 'image'].some(key => typeof options[key] !== 'string')) {
    throw new Error('Private-workspace deployment identities must be primitive strings.');
  }
  const defaults = options.defaultFlowIds ?? options.flowIds ?? [];
  if (!Array.isArray(defaults) || defaults.length > 100
    || defaults.some(id => typeof id !== 'string' || !ID.test(id))) {
    throw new Error('Default flow selection must contain valid flow IDs (at most 100).');
  }
  options.defaultFlowIds = [...new Set(defaults)];
  if (options.defaultFlowIds !== undefined && options.flowIds !== undefined
    && options.flowIds.length && JSON.stringify([...new Set(options.flowIds)]) !== JSON.stringify(options.defaultFlowIds)) {
    throw new Error('Conflicting default flow selections are refused.');
  }
  // Full workspace capture and restored flow availability do not inherit the
  // selected flow's dependency/call scope. This selection is only a call default.
  delete options.flowIds;
  if (options.recoveryId !== undefined || options.recoveryEpoch !== undefined) {
    assertRecoveryIdentity(options);
  }
  if (SOURCE_FIELDS.some(key => Object.hasOwn(options, key))) assertSourceBinding(options);
  return options;
}

function assertRecoveryIdentity(value) {
  if (typeof value.recoveryId !== 'string' || !UUID.test(value.recoveryId)
    || !Number.isSafeInteger(value.recoveryEpoch) || value.recoveryEpoch <= 0) {
    throw new Error('Private-workspace recovery identity requires a UUID and positive safe integer epoch.');
  }
}

/** Allocate only for a NEW attempt, then bind these exact values to its journal. */
export function withRecoveryIdentity(options) {
  if (options.profile !== PRIVATE_WORKSPACE_PROFILE) return options;
  if (options.recoveryId !== undefined || options.recoveryEpoch !== undefined) {
    assertRecoveryIdentity(options);
    return options;
  }
  return { ...options, recoveryId: randomUUID(), recoveryEpoch: 1 };
}

export function profileFields(value) {
  if (value.profile === undefined) return {};
  assertProfileRecord(value);
  return { profile: value.profile, recoveryId: value.recoveryId,
    recoveryEpoch: value.recoveryEpoch, defaultFlowIds: [...value.defaultFlowIds],
    sourceCompatibility: { ...value.sourceCompatibility }, sourceRevision: value.sourceRevision,
    sourceProvenance: value.sourceProvenance, targetRevision: value.targetRevision };
}

export function assertProfileRecord(value) {
  if (value.profile === undefined) {
    if (PROFILE_FIELDS.slice(1).some(key => Object.hasOwn(value, key))) {
      throw new Error('Legacy record contains private-workspace identity fields; profile migration is refused.');
    }
    return;
  }
  if (value.profile !== PRIVATE_WORKSPACE_PROFILE) throw new Error('Unknown recorded deployment profile.');
  assertRecoveryIdentity(value);
  assertSourceBinding(value);
  if (!Array.isArray(value.defaultFlowIds) || value.defaultFlowIds.length > 100
    || value.defaultFlowIds.some(id => typeof id !== 'string' || !ID.test(id))
    || new Set(value.defaultFlowIds).size !== value.defaultFlowIds.length
    || Object.hasOwn(value, 'flowIds')) {
    throw new Error('Private-workspace record has an invalid default selection or legacy flow scope.');
  }
}

export function assertSameProfile(left, right) {
  assertProfileRecord(left);
  assertProfileRecord(right);
  if (PROFILE_FIELDS.filter(key => key !== 'sourceCompatibility').some(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    || (left.profile === PRIVATE_WORKSPACE_PROFILE && CONTRACT_FIELDS.some(key => left.sourceCompatibility[key] !== right.sourceCompatibility[key]))) {
    throw new Error('Deployment profile or recovery identity changed; migration is refused.');
  }
}

function assertSourceBinding(value) {
  const contract = value.sourceCompatibility;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
    || Object.keys(contract).length !== CONTRACT_FIELDS.length || CONTRACT_FIELDS.some(key => !Object.hasOwn(contract, key))
    || typeof contract.applicationVersion !== 'string' || !contract.applicationVersion || contract.applicationVersion.length > 115
    || CONTRACT_FIELDS.slice(1).some(key => !Number.isSafeInteger(contract[key]) || contract[key] <= 0)
    || contract.workerSnapshotSourceVersion !== WORKER_SNAPSHOT_SOURCE_VERSION
    || typeof value.targetRevision !== 'string' || !REVISION.test(value.targetRevision)
    || (value.sourceRevision === null ? value.sourceProvenance !== 'unknown-native'
      : typeof value.sourceRevision !== 'string' || !REVISION.test(value.sourceRevision)
        || value.sourceProvenance !== 'reported-native' || value.sourceRevision !== value.targetRevision)) {
    throw new Error('Private-workspace source/target provenance or observed contract is invalid.');
  }
}

export function snapshotSourceBinding(source, resolved) {
  assertSnapshotSourceCapability(source);
  const sourceCompatibility = Object.fromEntries(CONTRACT_FIELDS.map(key => [key, source[key]]));
  const sourceRevision = source.revision === undefined ? null : source.revision;
  const binding = { sourceCompatibility, sourceRevision,
    sourceProvenance: sourceRevision === null ? 'unknown-native' : 'reported-native', targetRevision: resolved.revision };
  assertSourceBinding(binding);
  if (resolved.mode !== 'official' || resolved.compatibility !== 'verified'
    || CONTRACT_FIELDS.some(key => resolved[key] !== sourceCompatibility[key])) {
    throw new Error('Private-workspace requires a verified official target matching the observed source contract.');
  }
  return binding;
}

/** Compare a prepared observation to the fresh source/OCI observation; not an archive attestation. */
export function bindSourceObservation(options, binding) {
  const next = { ...options, ...binding };
  if (SOURCE_FIELDS.some(key => Object.hasOwn(options, key))) assertSameProfile(options, next);
  return next;
}

export function assertSnapshotSourceCapability(compatibility) {
  if (compatibility?.workerSnapshotSourceVersion !== WORKER_SNAPSHOT_SOURCE_VERSION) {
    throw new Error('Private-workspace requires a source with workerSnapshotSourceVersion=1. Update and qualify the paired FLUJO backend first.');
  }
}
