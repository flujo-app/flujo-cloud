// Temporary CI diagnosis: synthetic paths only; never emit paths, env values,
// raw PowerShell output/errors, ACL identities, or file contents.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') process.exit(0);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-acl-diagnostic-'));
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const psHome = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
const source = await fs.readFile(new URL('../lib/private-files.mjs', import.meta.url), 'utf8');
const original = source.match(/const windowsAclScript = String.raw`([\s\S]*?)`;/)?.[1];
if (!original) throw new Error('ACL diagnostic source was not found.');
const instrument = script => script
  .replace('try {', "try { [Console]::Out.WriteLine('stage:start');")
  .replace('$sid =', "[Console]::Out.WriteLine('stage:item'); $sid =")
  .replace("  if ($acl.GetOwner", "  [Console]::Out.WriteLine('stage:acl'); if ($acl.GetOwner")
  .replace("  if (-not $acl.AreAccessRulesProtected)", "  [Console]::Out.WriteLine('stage:protected'); if (-not $acl.AreAccessRulesProtected)")
  .replace("} catch { [Environment]::Exit(1) }", "} catch { [Console]::Out.WriteLine('stage:failed'); [Environment]::Exit(1) }");
const direct = original
  .replace('$item = Get-Item -LiteralPath $p -Force', '$isDirectory = ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Directory) -ne 0; $item = if ($isDirectory) { [IO.DirectoryInfo]::new($p) } else { [IO.FileInfo]::new($p) }')
  .replaceAll('$item.PSIsContainer', '$isDirectory')
  .replaceAll('$acl = Get-Acl -LiteralPath $p', '$acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }');

try {
  const profile = path.join(root, 'profile');
  const local = path.join(profile, 'local');
  const roaming = path.join(profile, 'roaming');
  await fs.mkdir(local, { recursive: true });
  await fs.mkdir(roaming);
  const cases = [
    { name: 'startup-only', script: "[Console]::Out.WriteLine('stage:startup'); [Console]::Out.Write('private')" },
    { name: 'original', script: instrument(original) },
    { name: 'closed-stdin', script: instrument(original), closeStdin: true },
    { name: 'system-modules', script: instrument(original), env: { PSModulePath: path.join(psHome, 'Modules') } },
    { name: 'synthetic-runtime-folders', script: instrument(original), env: {
      TEMP: root, TMP: root, USERPROFILE: profile, LOCALAPPDATA: local, APPDATA: roaming,
    } },
    { name: 'direct-dotnet', script: instrument(direct) },
  ];
  for (const [index, item] of cases.entries()) {
    const filename = path.join(root, `case-${index}`);
    await fs.mkdir(filename);
    const started = Date.now();
    const result = await new Promise(resolve => {
      const child = execFile(path.join(psHome, 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(item.script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 15_000, maxBuffer: 8192,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, FLUJO_PRIVATE_PATH: filename,
          FLUJO_PRIVATE_ACTION: 'protect', ...item.env },
      }, (error, stdout, stderr) => resolve({ name: item.name, elapsedMs: Date.now() - started,
        ok: !error, killed: error?.killed === true, exitCode: error?.code ?? 0,
        stages: stdout.match(/stage:[a-z-]+/g) || [], private: stdout.endsWith('private'),
        stderrBytes: Buffer.byteLength(stderr) }));
      if (item.closeStdin) child.stdin.end();
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  const relative = path.relative(os.tmpdir(), root);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('flujo-acl-diagnostic-')) throw new Error('Unexpected diagnostic directory.');
  await fs.rm(root, { recursive: true, force: true });
}
