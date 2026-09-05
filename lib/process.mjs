import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Never echo Fly output: errors and config output can contain secret values. */
export function createFlyRunner({ binary = process.env.FLYCTL_PATH || 'flyctl', env = process.env, cwd } = {}) {
  const options = { env, cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
  return {
    run(args, { input = '', timeoutMs = 300_000 } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, args, options);
        const chunks = [];
        let bytes = 0;
        let failed = false;
        const label = args.slice(0, 2).join(' ');
        const fail = (message) => {
          if (failed) return;
          failed = true;
          child.kill();
          reject(new Error(message));
        };
        const timer = setTimeout(() => fail(`Fly ${label} timed out.`), timeoutMs);
        child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > OUTPUT_LIMIT) fail(`Fly ${label} exceeded the output limit.`);
          else chunks.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on('error', () => undefined);
        child.on('error', () => { clearTimeout(timer); fail(`Could not start Fly ${label}. Check FLYCTL_PATH and your Fly login.`); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (failed) return;
          if (code !== 0) reject(new Error(`Fly ${label} failed (exit ${code}). Fly output is withheld to protect credentials.`));
          else resolve(Buffer.concat(chunks).toString('utf8'));
        });
        child.stdin.end(input);
      });
    },
    async proxy({ app, org, machineId, localPort }) {
      const child = spawn(binary, [
        'proxy', `${localPort}:4200`, `${machineId}.vm.${app}.internal`,
        '--app', app, '--org', org, '--bind-addr', '127.0.0.1', '--watch-stdin', '--quiet',
      ], options);
      let failure;
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      child.on('error', () => { failure = new Error('Could not start the private Fly proxy.'); });
      child.on('exit', () => { failure ??= new Error('The private Fly proxy exited.'); });
      return {
        origin: `http://127.0.0.1:${localPort}`,
        check() { if (failure) throw failure; },
        async stop() {
          child.stdin.end();
          child.kill();
        },
      };
    },
  };
}

export async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
