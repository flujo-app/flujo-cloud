import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Never echo Fly output: errors and config output can contain secret values. */
export function createFlyRunner({ binary = process.env.FLYCTL_PATH || 'flyctl', env = process.env, cwd,
  spawnImpl = spawn, proxyStopTimeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(proxyStopTimeoutMs) || proxyStopTimeoutMs < 1 || proxyStopTimeoutMs > 60_000) {
    throw new Error('Invalid private proxy shutdown timeout.');
  }
  const options = { env, cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
  return {
    run(args, { input = '', timeoutMs = 300_000 } = {}) {
      return new Promise((resolve, reject) => {
        const child = spawnImpl(binary, args, options);
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
      const child = spawnImpl(binary, [
        'proxy', `${localPort}:4200`, `${machineId}.vm.${app}.internal`,
        '--app', app, '--org', org, '--bind-addr', '127.0.0.1', '--watch-stdin', '--quiet',
      ], options);
      let failure;
      let closed = false;
      let stopPromise;
      const childClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      child.on('error', () => { failure = new Error('Could not start the private Fly proxy.'); });
      child.on('exit', () => { failure ??= new Error('The private Fly proxy exited.'); });
      return {
        origin: `http://127.0.0.1:${localPort}`,
        check() { if (failure) throw failure; },
        stop() {
          stopPromise ??= (async () => {
            if (closed) return { childClosed: true };
            let requestError;
            try { child.stdin.end(); child.kill(); } catch (error) { requestError = error; }
            let timer;
            try {
              const observed = await Promise.race([childClosed.then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), proxyStopTimeoutMs); })]);
              if (!observed) throw Object.assign(new Error('Private Fly proxy child closure is unconfirmed; reconcile its process before another operation.',
                { cause: requestError }), { code: 'PROXY_CLEANUP_UNKNOWN' });
              return { childClosed: true };
            } finally { clearTimeout(timer); }
          })();
          return stopPromise;
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
