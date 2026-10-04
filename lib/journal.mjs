import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertProfileRecord, assertSameProfile } from './profiles.mjs';

const ALLOWED_KEYS = new Set([
  'format', 'version', 'owner', 'createdAt', 'updatedAt', 'state', 'stage',
  'app', 'org', 'region', 'workspace', 'image', 'authState', 'appCreated', 'appId',
  'volumeName', 'volumeId', 'machineName', 'machineId', 'archiveSha256', 'flowIds', 'ownershipConfirmed',
  'profile', 'recoveryId', 'recoveryEpoch', 'defaultFlowIds',
  'sourceCompatibility', 'sourceRevision', 'sourceProvenance', 'targetRevision',
]);

export class Journal {
  constructor(filename) { this.filename = path.resolve(filename); }

  async create(value) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filename, this.serialize(value), { flag: 'wx', mode: 0o600 });
  }

  serialize(value) {
    if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) throw new Error('Refusing an unknown journal field.');
    assertProfileRecord(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  async save(value) {
    const temporary = `${this.filename}.next`;
    const existing = await fs.lstat(this.filename);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Journal is not a regular file.');
    assertSameProfile(await this.read(), value);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(this.serialize({ ...value, updatedAt: new Date().toISOString() }));
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.rename(temporary, this.filename); }
    catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  }

  async read() {
    const stat = await fs.lstat(this.filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid worker journal.');
    let value;
    try { value = JSON.parse(await fs.readFile(this.filename, 'utf8')); }
    catch { throw new Error('Could not parse worker journal.'); }
    if (value?.format !== 'flujo-cloud-journal' || value.version !== 1 || typeof value.owner !== 'string') {
      throw new Error('Unsupported worker journal.');
    }
    this.serialize(value);
    return value;
  }

  async locked(task, { retainLock = () => false, onCleanupUncertain } = {}) {
    if (typeof retainLock !== 'function') throw new Error('Journal lock retention must be an internal synchronous callback.');
    if (onCleanupUncertain !== undefined && typeof onCleanupUncertain !== 'function') throw new Error('Journal cleanup observation must be an internal callback.');
    const filename = `${this.filename}.lock`;
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await fs.open(filename, 'wx', 0o600); }
    catch { throw new Error('This worker journal is locked by another command. If it crashed, inspect the worker before removing its .lock file.'); }
    let acquired;
    try { acquired = await handle.stat({ bigint: true }); }
    catch (cause) {
      await handle.close().catch(() => undefined);
      const error = Object.assign(new Error('Journal lock acquisition identity is unconfirmed; preserve its lock.', { cause }),
        { code: 'JOURNAL_LOCK_CLEANUP_UNKNOWN' });
      onCleanupUncertain?.(error);
      throw error;
    }
    let result;
    let taskError;
    try { result = await task(); } catch (error) { taskError = error; }
    try {
      await handle.close();
      // Clone preserves an existing source journal lock on uncertain cleanup.
      // Existing callers retain the default release behavior.
      if (!retainLock()) {
        const current = await fs.lstat(filename, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink()
          || ['dev', 'ino', 'birthtimeNs'].some(key => current[key] !== acquired[key])) {
          throw new Error('Journal lock identity changed; refusing to remove a replacement lock.');
        }
        await fs.unlink(filename);
      }
    } catch (cleanupError) {
      const taskResult = result === undefined ? taskError?.taskResult : result;
      const error = Object.assign(new Error('Worker journal lock cleanup is unconfirmed; preserve existing locks and reconcile the operation.',
        { cause: taskError ?? cleanupError }), { code: 'JOURNAL_LOCK_CLEANUP_UNKNOWN', cleanupCause: cleanupError,
        ...(taskResult === undefined ? {} : { taskResult }),
        ...(taskError?.targetResult === undefined ? {} : { targetResult: taskError.targetResult }) });
      onCleanupUncertain?.(error);
      throw error;
    }
    if (taskError) throw taskError;
    return result;
  }
}
