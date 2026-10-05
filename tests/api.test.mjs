// © Author: aliyie
// https://discord.gg/aerox

// End-to-end tests over the real Express app, with the yt-dlp binary
// swapped for tests/fixtures/fake-ytdlp.mjs. That stand-in replays the JSON
// shapes and failure messages real extractors produce, so every source type
// (split streams, audio-only, multi-clip posts, live HLS, image carousels,
// bare files) and every common failure is covered without network access.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'silent';
process.env.YTDLP_BIN = path.join(FIXTURES, 'fake-ytdlp.mjs');
process.env.FFMPEG_LOCATION = path.join(FIXTURES, 'bin');
process.env.ALLOW_PRIVATE_URLS = 'true'; // fixture hosts don't resolve
process.env.RATE_LIMIT_MAX = '1000';
process.env.DOWNLOAD_RATE_LIMIT_MAX = '1000';
process.env.YTDLP_IMPERSONATE = 'chrome-110';
delete process.env.API_KEY;
delete process.env.REDIS_URL;

const { checkMediaTools, checkYtDlpBinary } = await import('../src/lib/ytdlp.mjs');
await checkYtDlpBinary();
await checkMediaTools();
const { default: app } = await import('../src/app.mjs');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const get = (p) => fetch(`${base}${p}`);
const getJson = async (p) => {
  const res = await get(p);
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const u = (raw) => encodeURIComponent(raw);

// ---------------------------------------------------------------- metadata

test('info: a split-stream site returns normalized metadata without storyboards', async () => {
  const { status, body } = await getJson(`/media/info?url=${u('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`);
  assert.equal(status, 200);
  assert.equal(body.kind, 'video');
  assert.equal(body.title, 'Пример видео 🎬');
  assert.equal(body.uploader, 'Example Channel');
  assert.equal(body.thumbnail, 'https://i.example.com/big.jpg'); // largest, not first
  assert.equal(body.durationSeconds, 212);
  assert.equal(body.uploadDate, '2009-10-25');
  assert.deepEqual(body.subtitleLanguages, ['en']);
  assert.equal(body.formats.length, 2); // storyboard dropped
  assert.ok(body.formats.every((f) => f.ext !== 'mhtml'));
  assert.equal(body.hasVideo, true);
  assert.equal(body.hasAudio, true);
  assert.equal(body.isLive, false);
});

test('info: an audio-only site is not treated as a broken video', async () => {
  const { status, body } = await getJson(`/media/info?url=${u('https://soundcloud.com/forss/flickermood')}`);
  assert.equal(status, 200);
  assert.equal(body.kind, 'audio');
  assert.equal(body.hasVideo, false);
  assert.equal(body.durationSeconds, 222);
  assert.equal(body.formats[0].isManifest, true);
});

test('info: a multi-clip post collapses to the first item and says so', async () => {
  const { status, body } = await getJson(`/media/info?url=${u('https://x.com/user/status/1')}`);
  assert.equal(status, 200);
  assert.equal(body.isPlaylist, false);
  assert.equal(body.id, 'clip-1');
  assert.equal(body.partOfPlaylist.itemCount, 2);
});

test('info: playlist=true returns every entry', async () => {
  const { status, body } = await getJson(`/media/info?url=${u('https://x.com/user/status/1')}&playlist=true`);
  assert.equal(status, 200);
  assert.equal(body.isPlaylist, true);
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[0].index, 1);
});

test('info: an extractor with no formats array still yields a format', async () => {
  const { status, body } = await getJson(`/media/info?url=${u('https://files.example.com/generic/sample.mp4')}`);
  assert.equal(status, 200);
  assert.equal(body.formats.length, 1);
  assert.equal(body.formats[0].ext, 'mp4');
});

test('info: a live stream is reported as live', async () => {
  const { body } = await getJson(`/media/info?url=${u('https://twitch.tv/live/somebody')}`);
  assert.equal(body.isLive, true);
  assert.equal(body.liveStatus, 'is_live');
});

test('info: a schemeless URL is accepted', async () => {
  const { status } = await getJson(`/media/info?url=${u('youtube.com/watch?v=dQw4w9WgXcQ')}`);
  assert.equal(status, 200);
});

// ------------------------------------------------------------------ errors

const ERROR_CASES = [
  ['https://instagram.com/p/authwall', 403, 'auth_required', true],
  ['https://youtube.com/watch?v=geoblock', 451, 'geo_restricted', true],
  ['https://youtube.com/watch?v=botcheck', 403, 'auth_required', true],
  ['https://youtube.com/watch?v=gone', 404, 'not_found', false],
  ['https://example.com/nosite', 400, 'unsupported_url', true],
];

for (const [url, status, code, hasHint] of ERROR_CASES) {
  test(`errors: ${code} is reported as HTTP ${status}`, async () => {
    const res = await getJson(`/media/info?url=${u(url)}`);
    assert.equal(res.status, status);
    assert.equal(res.body.code, code);
    assert.ok(res.body.error);
    if (hasHint) assert.ok(res.body.hint, 'expected an actionable hint');
  });
}

test('errors: an invalid url is rejected before yt-dlp runs', async () => {
  const res = await getJson('/media/info?url=file:///etc/passwd');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_url');
});

test('errors: a missing url is a 400', async () => {
  const res = await getJson('/media/info');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'missing_url');
});

// -------------------------------------------------------------- direct-url

test('direct-url: returns urls, per-stream headers, protocol and expiry', async () => {
  const { status, body } = await getJson(`/media/direct-url?url=${u('https://www.youtube.com/watch?v=abc')}`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.urls) && body.urls.length >= 1);
  assert.ok(body.urls[0].startsWith('https://'));
  assert.ok(body.streams[0].headers.Referer);
  assert.equal(body.streams[0].protocol, 'https');
  assert.equal(typeof body.requiresMerge, 'boolean');
  assert.equal(body.expiresAt, '2096-10-02T07:06:40.000Z');
});

test('direct-url: an unsatisfiable format selector falls back instead of failing', async () => {
  const { status, body } = await getJson(
    `/media/direct-url?url=${u('https://www.youtube.com/watch?v=noformat')}&format=${u('bv[height=99999]')}`,
  );
  assert.equal(status, 200);
  assert.ok(body.urls.length >= 1);
});

test('direct-url: HLS manifests are flagged so clients know to use a player', async () => {
  const { body } = await getJson(`/media/direct-url?url=${u('https://twitch.tv/live/somebody')}`);
  assert.equal(body.streams[0].isManifest, true);
  assert.equal(body.isLive, true);
});

// ---------------------------------------------------------------- download

test('download: default mp4 streams the finished file, not a sidecar', async () => {
  const res = await get(`/media/download?url=${u('https://www.youtube.com/watch?v=abc')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 4096); // the .part leftover is 99 bytes
  assert.equal(res.headers.get('content-length'), '4096');
});

test('download: unicode titles survive the Content-Disposition round trip', async () => {
  const res = await get(`/media/download?url=${u('https://www.youtube.com/watch?v=abc')}`);
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /filename\*=UTF-8''/);
  const encoded = disposition.split("filename*=UTF-8''")[1];
  assert.match(decodeURIComponent(encoded), /Пример видео/);
  await res.arrayBuffer();
});

test('download: audio extraction reports an audio content type', async () => {
  const res = await get(`/media/download?url=${u('https://www.youtube.com/watch?v=abc')}&ext=mp3`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  await res.arrayBuffer();
});

test('download: the content type follows the real container, not the request', async () => {
  // The photo fixture produces a .jpg no matter what ext was requested.
  const res = await get(`/media/download?url=${u('https://tiktok.com/@u/photo/1')}&ext=mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  await res.arrayBuffer();
});

test('download: live streams are refused by default and allowed on request', async () => {
  const refused = await getJson(`/media/download?url=${u('https://twitch.tv/live/somebody')}`);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'live_stream');
  assert.ok(refused.body.hint.includes('allowLive'));

  const allowed = await get(`/media/download?url=${u('https://twitch.tv/live/somebody')}&allowLive=true`);
  assert.equal(allowed.status, 200);
  await allowed.arrayBuffer();
});

test('download: a failed remux retries with the source container', async () => {
  const res = await get(`/media/download?url=${u('https://example.com/remuxfail/video')}`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
});

test('download: ext is validated', async () => {
  const res = await getJson(`/media/download?url=${u('https://www.youtube.com/watch?v=abc')}&ext=exe`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_ext');
});

test('download: a bogus format selector is rejected', async () => {
  const res = await getJson(`/media/download?url=${u('https://www.youtube.com/watch?v=abc')}&format=${u('a;rm -rf /')}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_format');
});

// ------------------------------------------------------------ introspection

test('extractors: the supported-site list is queryable', async () => {
  const all = await getJson('/media/extractors');
  assert.equal(all.status, 200);
  assert.ok(all.body.total > 0);

  const filtered = await getJson('/media/extractors?query=tik');
  assert.equal(filtered.body.matched, 1);
  assert.deepEqual(filtered.body.extractors, ['TikTok']);
});

test('capabilities: reports the versions and tools actually present', async () => {
  const { status, body } = await getJson('/capabilities');
  assert.equal(status, 200);
  assert.equal(body.ytdlpVersion, '2099.01.01');
  assert.equal(body.ffmpeg, true);
  assert.equal(body.impersonation, true);
  assert.ok(Array.isArray(body.notes));
});

test('healthz still answers for liveness probes', async () => {
  const { status, body } = await getJson('/healthz');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('auth: API_KEY gates media endpoints and accepts a bearer token', async () => {
  process.env.API_KEY = 'super-secret';
  try {
    const anonymous = await getJson(`/media/info?url=${u('https://www.youtube.com/watch?v=abc')}`);
    assert.equal(anonymous.status, 401);

    const withHeader = await fetch(`${base}/media/info?url=${u('https://www.youtube.com/watch?v=abc')}`, {
      headers: { 'x-api-key': 'super-secret' },
    });
    assert.equal(withHeader.status, 200);

    const withBearer = await fetch(`${base}/media/info?url=${u('https://www.youtube.com/watch?v=abc')}`, {
      headers: { authorization: 'Bearer super-secret' },
    });
    assert.equal(withBearer.status, 200);
  } finally {
    delete process.env.API_KEY;
  }
});
