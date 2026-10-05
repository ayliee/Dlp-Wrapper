// © Author: aliyie
// https://discord.gg/aerox

// End-to-end smoke test. Boots the API on a random port, then hits every
// endpoint with a real public URL and verifies the response shape and binary
// integrity.
//
// Usage:  node scripts/smoke-test.mjs
// Env:
//   SMOKE_URL          — the source URL to test (defaults to a known public test video)
//   SMOKE_URLS         — comma-separated extra sources to run /media/info against,
//                        for checking a spread of extractors in one go
//   SMOKE_API_KEY      — if set, sent as x-api-key on every request
//   SMOKE_PORT         — port to run the server on (default: 0 = random)
//
// For the offline test suite (no network, no yt-dlp binary required) run
// `npm test` instead — this script deliberately talks to real sites.
//
// The script intentionally downloads a tiny MP3 + tiny MP4 so the test stays
// fast even on slow connections. It writes the downloaded files to
// test-output/ for visual inspection.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-output');

// The default URL points at a tiny, public, no-auth-required sample. If the
// user passes SMOKE_URL we honour it instead. The script is hard-coded to
// not depend on YouTube (which needs cookies from a real browser session on
// most cloud IPs). Vimeo is reachable without authentication from cloud
// environments and exercises the full pipeline: format selection, ffmpeg
// merge, MP3 extraction with re-encoding.
const TEST_URL =
  process.env.SMOKE_URL ??
  // "The New Vimeo Player (You Know, For Videos)" — Vimeo's official sample,
  // ~62s, public, no auth required.
  'https://vimeo.com/76979871';

// Extra sources to sanity-check metadata extraction against. Anything that
// fails for an environmental reason (login wall, site rate limit, network)
// is reported as a warning rather than a failure — those say nothing about
// whether this code works.
const EXTRA_URLS = (process.env.SMOKE_URLS ?? 'https://soundcloud.com/forss/flickermood')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

const ENVIRONMENTAL_CODES = new Set([
  'auth_required',
  'forbidden_by_source',
  'rate_limited',
  'network_error',
  'geo_restricted',
  'timeout',
]);

const API_KEY = process.env.SMOKE_API_KEY ?? '';
const PORT = process.env.SMOKE_PORT ?? '0';

const COL = { ok: '\x1b[32m', err: '\x1b[31m', info: '\x1b[36m', reset: '\x1b[0m' };
const ok = (msg) => console.log(`${COL.ok}✓${COL.reset} ${msg}`);
const warn = (msg) => console.log(`\x1b[33m!\x1b[0m ${msg}`);
const info = (msg) => console.log(`${COL.info}•${COL.reset} ${msg}`);
const fail = (msg) => {
  console.error(`${COL.err}✗${COL.reset} ${msg}`);
  process.exitCode = 1;
};

async function waitForServer(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/healthz', timeout: 1000 },
          (res) => {
            res.resume();
            if (res.statusCode === 200) resolve();
            else reject(new Error(`status ${res.statusCode}`));
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server didn't come up on port ${port}`);
}

function fetchRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function fetchJson(url, options) {
  return fetchRaw(url, options).then(({ status, headers, body }) => {
    return {
      status,
      headers,
      body,
      json: (() => {
        try {
          return JSON.parse(body.toString('utf-8'));
        } catch {
          return null;
        }
      })(),
    };
  });
}

function buildHeaders() {
  const h = {};
  if (API_KEY) h['x-api-key'] = API_KEY;
  return h;
}

async function main() {
  console.log('\n=== Dlp Wrapper smoke test ===\n');
  info(`Source URL: ${TEST_URL}`);
  if (API_KEY) info('Using x-api-key header');

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Spawn server with stdio inherited so all server output flows to the
  // test runner's terminal — makes failures easier to diagnose. We bind to
  // a known port (SMOKE_PORT or a deterministic default) instead of letting
  // the OS pick one, which is simpler than parsing logged port info through
  // a buffered pipe.
  const PORT_TO_USE = process.env.SMOKE_PORT ?? '8765';
  info(`Spawning server on port ${PORT_TO_USE}...`);
  const server = spawn('node', ['--enable-source-maps', 'src/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: PORT_TO_USE,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      YTDLP_DOWNLOAD_TIMEOUT_MS: '120000',
      ...(API_KEY ? { API_KEY } : {}),
    },
    stdio: 'inherit',
  });

  const actualPort = Number(PORT_TO_USE);
  // Race the server becoming healthy against it unexpectedly exiting.
  const serverExitPromise = new Promise((_resolve, reject) => {
    server.on('exit', (code) =>
      reject(new Error(`server exited with code ${code} before becoming healthy`)),
    );
  });
  info(`Server bound to port ${actualPort}`);
  await Promise.race([waitForServer(actualPort), serverExitPromise]);
  ok('Server is up');

  const BASE = `http://127.0.0.1:${actualPort}/api`;
  let passed = 0;
  let failed = 0;
  const tally = (passed_, failed_) => ({ passed: passed + passed_, failed: failed + failed_ });

  try {
    // 1. healthz -------------------------------------------------------------
    {
      const r = await fetchJson(`${BASE}/healthz`, { headers: buildHeaders() });
      if (r.status === 200 && r.json?.status === 'ok') {
        ok('GET /api/healthz returns { status: "ok" }');
        passed++;
      } else {
        fail(`GET /api/healthz expected 200 {status:"ok"}, got ${r.status} ${r.body.toString().slice(0, 200)}`);
        failed++;
      }
    }

    // 2. media/info ----------------------------------------------------------
    let infoOk = false;
    {
      info('Calling GET /api/media/info (this may take 5-15s)...');
      const r = await fetchJson(`${BASE}/media/info?url=${encodeURIComponent(TEST_URL)}`, { headers: buildHeaders() });
      if (r.status !== 200) {
        fail(`/media/info returned ${r.status}: ${r.body.toString().slice(0, 500)}`);
        failed++;
      } else {
        const required = ['id', 'title', 'formats', 'durationSeconds'];
        const missing = required.filter((k) => !(k in (r.json ?? {})));
        if (missing.length) {
          fail(`/media/info response missing keys: ${missing.join(', ')}`);
          failed++;
        } else if (!Array.isArray(r.json.formats) || r.json.formats.length === 0) {
          fail(`/media/info returned 0 formats — title: ${r.json.title}`);
          failed++;
        } else {
          ok(`/media/info: title="${r.json.title}", formats=${r.json.formats.length}`);
          infoOk = true;
          passed++;
        }
      }
    }

    // 3. media/direct-url ----------------------------------------------------
    {
      const r = await fetchJson(
        `${BASE}/media/direct-url?url=${encodeURIComponent(TEST_URL)}&format=best`,
        { headers: buildHeaders() },
      );
      if (r.status !== 200) {
        fail(`/media/direct-url returned ${r.status}: ${r.body.toString().slice(0, 500)}`);
        failed++;
      } else if (!r.json?.urls?.length || !r.json.urls[0].startsWith('http')) {
        fail(`/media/direct-url returned no valid URL: ${JSON.stringify(r.json)}`);
        failed++;
      } else {
        ok(`/media/direct-url: title="${r.json.title}", first URL: ${r.json.urls[0].slice(0, 80)}...`);
        passed++;
      }
    }

    // 4. media/download?ext=mp3 ----------------------------------------------
    {
      info('Downloading MP3 (this is the slowest step)...');
      const t0 = Date.now();
      const r = await fetchJson(
        `${BASE}/media/download?url=${encodeURIComponent(TEST_URL)}&ext=mp3`,
        { headers: buildHeaders() },
      );
      if (r.status !== 200) {
        fail(`/media/download?ext=mp3 returned ${r.status}: ${r.body.toString().slice(0, 500)}`);
        failed++;
      } else if (r.body.length < 1024) {
        fail(`/media/download?ext=mp3 returned ${r.body.length} bytes (too small to be an mp3)`);
        failed++;
      } else if (!r.headers['content-type']?.includes('audio')) {
        fail(`/media/download?ext=mp3 wrong content-type: ${r.headers['content-type']}`);
        failed++;
      } else {
        const out = path.join(OUT, 'smoke.mp3');
        await pipeline(async function* () { yield r.body; }, createWriteStream(out));
        const { size } = await stat(out);
        ok(`/media/download?ext=mp3: ${(size / 1024).toFixed(1)} KiB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
        passed++;
      }
    }

    // 5. media/download?ext=mp4 ----------------------------------------------
    {
      info('Downloading MP4...');
      const t0 = Date.now();
      const r = await fetchJson(
        `${BASE}/media/download?url=${encodeURIComponent(TEST_URL)}&ext=mp4`,
        { headers: buildHeaders() },
      );
      if (r.status !== 200) {
        fail(`/media/download?ext=mp4 returned ${r.status}: ${r.body.toString().slice(0, 500)}`);
        failed++;
      } else if (r.body.length < 4096) {
        fail(`/media/download?ext=mp4 returned ${r.body.length} bytes (too small)`);
        failed++;
      } else if (!r.headers['content-type']?.includes('video')) {
        fail(`/media/download?ext=mp4 wrong content-type: ${r.headers['content-type']}`);
        failed++;
      } else {
        const out = path.join(OUT, 'smoke.mp4');
        await pipeline(async function* () { yield r.body; }, createWriteStream(out));
        const { size } = await stat(out);
        ok(`/media/download?ext=mp4: ${(size / 1024).toFixed(1)} KiB in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`);
        passed++;
      }
    }

    // 6. capabilities --------------------------------------------------------
    {
      const r = await fetchJson(`${BASE}/capabilities`, { headers: buildHeaders() });
      if (r.status === 200 && r.json?.ytdlpVersion) {
        ok(`/capabilities: yt-dlp ${r.json.ytdlpVersion}, ffmpeg=${r.json.ffmpeg}, ffprobe=${r.json.ffprobe}, cookies=[${r.json.cookieDomains.join(', ')}]`);
        if (!r.json.ffmpeg) warn('ffmpeg missing — merged formats and mp3/m4a conversion cannot work');
        passed++;
      } else {
        fail(`/capabilities returned ${r.status}: ${r.body.toString().slice(0, 200)}`);
        failed++;
      }
    }

    // 7. extractors ------------------------------------------------------------
    {
      const r = await fetchJson(`${BASE}/media/extractors?query=youtube`, { headers: buildHeaders() });
      if (r.status === 200 && r.json?.total > 100 && r.json.matched > 0) {
        ok(`/media/extractors: ${r.json.total} extractors available, ${r.json.matched} match "youtube"`);
        passed++;
      } else {
        fail(`/media/extractors returned ${r.status}: ${r.body.toString().slice(0, 200)}`);
        failed++;
      }
    }

    // 8. error classification --------------------------------------------------
    {
      const r = await fetchJson(
        `${BASE}/media/info?url=${encodeURIComponent('https://example.com/definitely-not-media')}`,
        { headers: buildHeaders() },
      );
      if (r.status >= 400 && r.status < 500 && r.json?.code) {
        ok(`Unsupported URL classified as ${r.status} ${r.json.code}`);
        passed++;
      } else {
        fail(`Expected a classified 4xx for a junk URL, got ${r.status} ${r.body.toString().slice(0, 200)}`);
        failed++;
      }
    }

    // 9. ext=auto (no conversion — the path that works on every source) --------
    {
      info('Downloading with ext=auto...');
      const r = await fetchJson(
        `${BASE}/media/download?url=${encodeURIComponent(TEST_URL)}&ext=auto`,
        { headers: buildHeaders() },
      );
      const disposition = r.headers['content-disposition'] ?? '';
      if (r.status !== 200 || r.body.length < 4096) {
        fail(`/media/download?ext=auto returned ${r.status} (${r.body.length} bytes)`);
        failed++;
      } else if (!disposition.includes("filename*=UTF-8''")) {
        fail(`/media/download?ext=auto missing RFC 6266 filename: ${disposition}`);
        failed++;
      } else {
        ok(`/media/download?ext=auto: ${(r.body.length / 1024).toFixed(1)} KiB, ${r.headers['content-type']}`);
        passed++;
      }
    }

    // 10. a spread of other extractors ----------------------------------------
    for (const extraUrl of EXTRA_URLS) {
      const r = await fetchJson(`${BASE}/media/info?url=${encodeURIComponent(extraUrl)}`, {
        headers: buildHeaders(),
      });
      if (r.status === 200 && r.json?.formats?.length > 0) {
        ok(`/media/info on ${r.json.extractor ?? extraUrl}: kind=${r.json.kind}, formats=${r.json.formats.length}`);
        passed++;
      } else if (ENVIRONMENTAL_CODES.has(r.json?.code)) {
        warn(`${extraUrl} → ${r.status} ${r.json.code} (environmental, not a code failure): ${r.json.error}`);
      } else {
        fail(`/media/info on ${extraUrl} returned ${r.status}: ${r.body.toString().slice(0, 300)}`);
        failed++;
      }
    }

    // 11. Auth: 401 when a key is configured but missing ----------------------
    // /healthz is intentionally unauthenticated (liveness probes need no
    // creds), so we test the auth gate against a protected endpoint instead.
    if (API_KEY) {
      const noKey = await fetchJson(`${BASE}/media/info?url=${encodeURIComponent(TEST_URL)}`);
      if (noKey.status === 401) {
        ok('API_KEY enforced — request to /media/info without key returns 401');
        passed++;
      } else {
        fail(`API_KEY set but /media/info without key got ${noKey.status} (expected 401)`);
        failed++;
      }
      const wrongKey = await fetchJson(
        `${BASE}/media/info?url=${encodeURIComponent(TEST_URL)}`,
        { headers: { 'x-api-key': 'definitely-wrong' } },
      );
      if (wrongKey.status === 401) {
        ok('API_KEY enforced — wrong key returns 401');
        passed++;
      } else {
        fail(`Wrong x-api-key got ${wrongKey.status} (expected 401)`);
        failed++;
      }
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
  }
}

main().catch((err) => {
  console.error('\nSmoke test threw:', err);
  process.exit(1);
});
