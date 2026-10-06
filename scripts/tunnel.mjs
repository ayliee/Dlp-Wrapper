// © Author: aliyie
// https://discord.gg/aerox

// Expose a locally running instance on a public HTTPS URL via a Cloudflare
// Quick Tunnel — handy for trying the test console from your phone, sharing
// it with someone, or pointing a Discord bot at your laptop without opening
// a port or buying a domain.
//
//   npm start            # terminal 1 — the API itself
//   npm run tunnel       # terminal 2 — prints https://<random>.trycloudflare.com
//
// Usage:
//   node scripts/tunnel.mjs [port]
// Env:
//   PORT              port the API is listening on (default 8080)
//   TUNNEL_HOSTNAME   use a named tunnel on your own domain instead of a
//                     random trycloudflare.com one (requires `cloudflared
//                     login` first)
//
// No account is needed for the default quick tunnel. The URL is public to
// anyone who has it, so set API_KEY before sharing it around.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PORT = process.argv[2] ?? process.env.PORT ?? '8080';
const LOCAL = `http://localhost:${PORT}`;
const HOSTNAME = process.env.TUNNEL_HOSTNAME ?? '';

const C = { ok: '\x1b[32m', err: '\x1b[31m', info: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' };
const log = (msg) => console.log(msg);
const info = (msg) => log(`${C.info}•${C.reset} ${msg}`);
const ok = (msg) => log(`${C.ok}✓${C.reset} ${msg}`);
const err = (msg) => console.error(`${C.err}✗${C.reset} ${msg}`);

const INSTALL_HELP = `
Install cloudflared (any one of these):

  macOS        brew install cloudflared
  Debian/Ubuntu curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \\
                  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
                echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \\
                  https://pkg.cloudflare.com/cloudflared any main" \\
                  | sudo tee /etc/apt/sources.list.d/cloudflared.list
                sudo apt update && sudo apt install cloudflared
  Any Linux    curl -L -o cloudflared \\
                  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
                chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
  Windows      winget install --id Cloudflare.cloudflared
  npm          npm i -g cloudflared        (downloads the binary on install)
`;

/** Is the API actually up? A tunnel to nothing is a confusing 502. */
async function checkLocal() {
  try {
    const res = await fetch(`${LOCAL}/api/healthz`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      ok(`API is up on ${LOCAL}`);
      return true;
    }
    err(`${LOCAL}/api/healthz returned ${res.status}`);
  } catch {
    err(`Nothing is listening on ${LOCAL} — start the API first (npm start), or pass the right port.`);
  }
  return false;
}

/** cloudflared on PATH, else the npm-installed one, else null. */
function resolveCloudflared() {
  const require = createRequire(import.meta.url);
  try {
    // The npm package exposes the downloaded binary's path.
    const { bin } = require('cloudflared');
    if (bin) return bin;
  } catch {
    /* not installed via npm — fall through to PATH */
  }
  return 'cloudflared';
}

function buildArgs() {
  if (HOSTNAME) {
    return ['tunnel', '--no-autoupdate', 'run', '--url', LOCAL, HOSTNAME];
  }
  return ['tunnel', '--no-autoupdate', '--url', LOCAL];
}

async function main() {
  log(`\n${C.bold}=== Dlp Wrapper — Cloudflare tunnel ===${C.reset}\n`);
  const alive = await checkLocal();
  if (!alive) {
    info('Continuing anyway — start the API and the tunnel will pick it up.');
  }

  const bin = resolveCloudflared();
  info(`Starting cloudflared (${bin})…`);

  const child = spawn(bin, buildArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });

  child.on('error', (e) => {
    if (e.code === 'ENOENT') {
      err('cloudflared is not installed or not on PATH.');
      log(INSTALL_HELP);
    } else {
      err(`Failed to start cloudflared: ${e.message}`);
    }
    process.exit(1);
  });

  let announced = false;
  const handle = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !announced) {
      announced = true;
      const url = match[0];
      log(`
${C.ok}${C.bold}Public URL ready${C.reset}

  ${C.bold}${url}${C.reset}

  docs           ${url}/
  test console   ${url}/test
  health         ${url}/api/healthz
  capabilities   ${url}/api/capabilities

  ${C.dim}curl "${url}/api/media/info?url=https://vimeo.com/76979871"${C.reset}

${C.dim}Anyone with this link can reach your instance — set API_KEY before sharing it,
and remember the URL changes every time a quick tunnel restarts.
Press Ctrl+C to close the tunnel.${C.reset}
`);
    }
    // cloudflared is chatty at INF level; surface only what matters.
    for (const line of text.split('\n')) {
      if (/ERR|WRN|error|failed/i.test(line) && line.trim()) console.error(`${C.dim}${line.trim()}${C.reset}`);
    }
  };

  child.stdout.on('data', handle);
  child.stderr.on('data', handle);

  const shutdown = () => {
    child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const startedAt = Date.now();
  child.on('close', (code) => {
    if (!announced) {
      err(`cloudflared exited with code ${code} before a tunnel came up.`);
      if (Date.now() - startedAt < 3000) {
        info(
          'It quit immediately — usually the binary never finished downloading, ' +
            'or outbound access to Cloudflare (443/7844) is firewalled.',
        );
        log(INSTALL_HELP);
      }
      if (HOSTNAME) info('For a named tunnel you need `cloudflared login` and a configured tunnel first.');
    }
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  err(String(e));
  process.exit(1);
});
