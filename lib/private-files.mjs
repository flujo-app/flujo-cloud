import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const unsafe = () => new Error('Private storage is unavailable or has unsafe ownership, permissions, or links.');

// Pass only the path/action in the child environment. No secret contents enter
// PowerShell arguments, output, or error messages. ACLs are owner-only on Windows;
// chmod(0600) alone would not restrict Windows readers.
const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $p = [Environment]::GetEnvironmentVariable('FLUJO_PRIVATE_PATH')
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $p
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  if ([Environment]::GetEnvironmentVariable('FLUJO_PRIVATE_ACTION') -eq 'protect') {
    if ($item.PSIsContainer) {
      $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
      $inherit = [Security.AccessControl.InheritanceFlags]::None
    }
    # Modify only the DACL. Replacing the entire descriptor or resetting its
    # owner can require SeSecurityPrivilege on an already protected directory.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($oldRule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($oldRule) }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($rule)
    # The PowerShell provider's Set-Acl can request SeSecurityPrivilege when
    # reapplying a protected ACL. Persist only .NET's modified access section.
    if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
    $acl = Get-Acl -LiteralPath $p
  }
  if (-not $acl.AreAccessRulesProtected) { throw 'unsafe' }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw 'unsafe' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'unsafe' }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'unsafe' }
  }
  [Console]::Out.Write('private')
} catch { [Environment]::Exit(1) }
`;

async function windowsAcl(filename, protect) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await runFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(windowsAclScript, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15_000, maxBuffer: 1024,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        FLUJO_PRIVATE_PATH: filename, FLUJO_PRIVATE_ACTION: protect ? 'protect' : 'check' },
    });
    if (stdout !== 'private') throw unsafe();
  } catch { throw unsafe(); }
}

function plainDirectory(stat) { return stat.isDirectory() && !stat.isSymbolicLink(); }
function owned(stat) { return process.platform === 'win32' || stat.uid === process.getuid(); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }

async function directoryTree(directory, create) {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  if (resolved === root) throw unsafe();
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (!plainDirectory(stat)) throw unsafe();
  }
  return resolved;
}

async function checkPrivate(filename, { directory = false, protect = false } = {}) {
  const before = await fs.lstat(filename);
  if (!owned(before) || before.isSymbolicLink()
    || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1)) throw unsafe();
  if (process.platform === 'win32') await windowsAcl(filename, protect);
  else if (protect) await fs.chmod(filename, directory ? 0o700 : 0o600);
  const after = await fs.lstat(filename);
  if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink()
    || !owned(after) || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)) throw unsafe();
  return after;
}

export async function assertPrivateDirectory(directory) {
  const resolved = await directoryTree(directory, false);
  await checkPrivate(resolved, { directory: true });
  return resolved;
}

export async function ensurePrivateDirectory(directory) {
  try {
    const resolved = await directoryTree(directory, true);
    await checkPrivate(resolved, { directory: true, protect: true });
    return resolved;
  } catch { throw unsafe(); }
}

export async function readPrivateJson(filename, { maxBytes = 65536 } = {}) {
  let handle;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw unsafe();
    const resolved = path.resolve(filename);
    await assertPrivateDirectory(path.dirname(resolved));
    const before = await checkPrivate(resolved);
    if (before.size > maxBytes) throw unsafe();
    handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!sameFile(before, opened) || opened.nlink !== 1 || !opened.isFile()) throw unsafe();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== before.size || !sameFile(before, await handle.stat())) throw unsafe();
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Private file was not found.'), { code: 'ENOENT' });
    throw unsafe();
  } finally { await handle?.close().catch(() => undefined); }
}

export async function writePrivateJson(filename, value, { exclusive = false } = {}) {
  const resolved = path.resolve(filename);
  let temporary;
  let handle;
  try {
    await ensurePrivateDirectory(path.dirname(resolved));
    try {
      await checkPrivate(resolved);
      if (exclusive) throw Object.assign(new Error('Private file already exists.'), { code: 'EEXIST' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
    handle = await fs.open(temporary, 'wx', 0o600);
    await checkPrivate(temporary, { protect: true });
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (exclusive) {
      // link() publishes the completed file atomically and refuses replacement.
      await fs.link(temporary, resolved);
      await fs.unlink(temporary);
    } else await fs.rename(temporary, resolved);
    temporary = undefined;
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Private file already exists.'), { code: 'EEXIST' });
    throw unsafe();
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}
