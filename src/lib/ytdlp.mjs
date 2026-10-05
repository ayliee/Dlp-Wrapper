// © Author: aliyie
// https://discord.gg/aerox

// Thin wrapper around the yt-dlp CLI (shelling out since it has 1,750+
// extractors and updates daily — no realistic way to keep up otherwise).
//
// The job of this module is to make every one of those extractors behave
// the same way from the API's point of view: the same arguments, the same
// retry behaviour, the same normalized JSON, and the same classified errors
// whether the URL points at YouTube, TikTok, SoundCloud, Twitch, Reddit, a
// news site's embedded player, or a bare .mp4 on someone's web server.
import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from './logger.mjs';
import { configuredCookieDomains, cookieArgsForUrl } from './cookies.mjs';
import { classifyYtDlpFailure, isFormatSelectionFailure, isPostProcessingFailure } from './ytdlpErrors.mjs';
import { extractStreams, guessUrlExpiry, normalizeInfo } from './normalize.mjs';
import { pickOutputFile } from './files.mjs';

const YTDLP_BIN = process.env.YTDLP_BIN ?? 'yt-dlp';
const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION ?? process.env.YTDLP_FFMPEG_LOCATION ?? '';

const INFO_TIMEOUT_MS = Number(process.env.YTDLP_INFO_TIMEOUT_MS ?? 60_000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS ?? 10 * 60_000);
const RETRIES = String(process.env.YTDLP_RETRIES ?? 3);
const EXTRACTOR_RETRIES = String(process.env.YTDLP_EXTRACTOR_RETRIES ?? 2);
const SOCKET_TIMEOUT = String(process.env.YTDLP_SOCKET_TIMEOUT ?? 20);
const CONCURRENT_FRAGMENTS = String(process.env.YTDLP_CONCURRENT_FRAGMENTS ?? 4);
const GEO_BYPASS = process.env.YTDLP_GEO_BYPASS !== 'false';
const GEO_BYPASS_COUNTRY = process.env.YTDLP_GEO_BYPASS_COUNTRY ?? '';
const PROXY = process.env.YTDLP_PROXY ?? '';
const USER_AGENT = process.env.YTDLP_USER_AGENT ?? '';
const FORCE_IPV4 = process.env.YTDLP_FORCE_IPV4 === 'true';
const MAX_FILESIZE = process.env.YTDLP_MAX_FILESIZE ?? '';
const IMPERSONATE = process.env.YTDLP_IMPERSONATE ?? '';
const MAX_JSON_BYTES = Number(process.env.YTDLP_MAX_JSON_BYTES ?? 64 * 1024 * 1024);

/** Prefix used for every per-request temp dir. */
export const TEMP_DIR_PREFIX = 'ytdlp-';

export class YtDlpError extends Error {
  constructor(message, stderr, extra = {}) {
    super(message);
    this.name = 'YtDlpError';
    this.stderr = stderr;
    this.code = extra.code ?? 'extraction_failed';
    this.status = extra.status ?? 422;
    this.hint = extra.hint ?? null;
    this.detail = extra.detail ?? '';
  }

  static fromStderr(stderr, { timedOut = false } = {}) {
    const classified = classifyYtDlpFailure(stderr, { timedOut });
    return new YtDlpError(classified.message, stderr, classified);
  }
}

// ---------------------------------------------------------------------------
// capabilities — probed once at startup
// ---------------------------------------------------------------------------

const capabilities = {
  ytdlpVersion: null,
  ffmpeg: false,
  ffprobe: false,
  impersonation: false,
  impersonateTarget: null,
};

/** Snapshot of what this install can actually do (surfaced by /api/healthz). */
export function getCapabilities() {
  return { ...capabilities, cookieDomains: configuredCookieDomains() };
}

function probe(bin, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, output: String(err?.message ?? err) });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.stderr.on('data', (c) => {
      out += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out });
    });
  });
}

/**
 * Verify the configured binary actually runs, and record what optional
 * pieces (ffmpeg, ffprobe, curl-cffi impersonation) are available. Called
 * once at startup so a broken install shows up in logs immediately instead
 * of silently failing every request.
 */
export async function checkYtDlpBinary() {
  const result = await probe(YTDLP_BIN, ['--version']);
  if (!result.ok) {
    throw new YtDlpError(`yt-dlp binary check failed: ${result.output.trim().slice(0, 200)}`, '');
  }
  capabilities.ytdlpVersion = result.output.trim().split('\n').pop();
  return capabilities.ytdlpVersion;
}

/**
 * ffmpeg is required for merging separate video+audio streams (YouTube,
 * most DASH/HLS sites) and for MP3/M4A extraction. Without it the API can
 * still serve single-file formats, which is what a lot of sites give you —
 * so this warns rather than refusing to start.
 */
export async function checkMediaTools() {
  const ffmpegBin = FFMPEG_LOCATION ? path.join(FFMPEG_LOCATION, 'ffmpeg') : 'ffmpeg';
  const ffprobeBin = FFMPEG_LOCATION ? path.join(FFMPEG_LOCATION, 'ffprobe') : 'ffprobe';
  capabilities.ffmpeg = (await probe(ffmpegBin, ['-version'])).ok;
  capabilities.ffprobe = (await probe(ffprobeBin, ['-version'])).ok;

  if (IMPERSONATE) {
    const result = await probe(YTDLP_BIN, ['--list-impersonate-targets']);
    const supported = result.ok && result.output.toLowerCase().includes(IMPERSONATE.toLowerCase().split(':')[0]);
    capabilities.impersonation = supported;
    capabilities.impersonateTarget = supported ? IMPERSONATE : null;
    if (!supported) {
      logger.warn(
        { target: IMPERSONATE },
        'YTDLP_IMPERSONATE is set but this yt-dlp build has no matching impersonation target ' +
          '(install curl-cffi: pip install "yt-dlp[default,curl-cffi]") — continuing without it',
      );
    }
  }
  return { ffmpeg: capabilities.ffmpeg, ffprobe: capabilities.ffprobe };
}

// ---------------------------------------------------------------------------
// argument construction
// ---------------------------------------------------------------------------

/** Back-compat alias; prefer cookieArgsForUrl(url) so per-site jars apply. */
export function cookieArgs(url = '') {
  return cookieArgsForUrl(url);
}

function extractorArgs() {
  const raw = process.env.YTDLP_EXTRACTOR_ARGS;
  if (!raw) return [];
  // Entries are separated by newline or '|' — not ';', because yt-dlp uses
  // ';' *inside* a single --extractor-args value.
  return raw
    .split(/\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((entry) => ['--extractor-args', entry]);
}

function extraArgs() {
  const raw = process.env.YTDLP_EXTRA_ARGS;
  if (!raw) return [];
  // Minimal shell-style tokenizer: supports "quoted values with spaces".
  const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((t) => t.replace(/^["']|["']$/g, ''));
}

/**
 * Arguments shared by every invocation, for every site.
 *
 * --ignore-config matters more than it looks: without it a stray
 * ~/.config/yt-dlp/config on the host (or in the container image) can add
 * flags that change the JSON shape or the output filename, and the failures
 * that causes are extremely confusing.
 */
function baseArgs(url) {
  const args = [
    '--ignore-config',
    '--no-color',
    '--no-progress',
    '--no-warnings',
    '--retries', RETRIES,
    '--fragment-retries', RETRIES,
    '--extractor-retries', EXTRACTOR_RETRIES,
    '--socket-timeout', SOCKET_TIMEOUT,
  ];

  if (GEO_BYPASS) args.push('--geo-bypass');
  if (GEO_BYPASS_COUNTRY) args.push('--geo-bypass-country', GEO_BYPASS_COUNTRY);
  if (PROXY) args.push('--proxy', PROXY);
  if (USER_AGENT) args.push('--user-agent', USER_AGENT);
  if (FORCE_IPV4) args.push('--force-ipv4');
  if (FFMPEG_LOCATION) args.push('--ffmpeg-location', FFMPEG_LOCATION);
  if (capabilities.impersonation && capabilities.impersonateTarget) {
    args.push('--impersonate', capabilities.impersonateTarget);
  }
  args.push(...extractorArgs(), ...extraArgs(), ...cookieArgsForUrl(url));
  return args;
}

/**
 * Playlist scope. yt-dlp returns a playlist wrapper for a lot of things
 * that aren't really playlists (Twitter threads, Reddit galleries, TikTok
 * photo posts), so the default stays --no-playlist and callers opt in.
 */
function playlistArgs({ playlist = false, item = null, limit = 50 } = {}) {
  if (item) return ['--playlist-items', String(item)];
  if (playlist) return ['--flat-playlist', '--playlist-items', `1:${limit}`];
  return ['--no-playlist'];
}

/**
 * Format selectors with fallbacks that work across every kind of source:
 * progressive-only sites, split video+audio sites, audio-only sites
 * (SoundCloud, Bandcamp, podcasts) and image posts.
 *
 * Each `/` step is a fallback, so a selector that can't be satisfied on one
 * site quietly degrades instead of erroring out with "Requested format is
 * not available" — which is what used to happen on anything that wasn't
 * shaped like YouTube.
 */
export const FORMAT_SELECTORS = {
  // Prefer mp4/m4a so no remux is needed, then anything mergeable, then any
  // single file, then audio-only, then video-only.
  mp4: 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b/ba/bv*',
  webm: 'bv*[ext=webm]+ba[ext=webm]/bv*+ba/b[ext=webm]/b/ba/bv*',
  // Audio: real audio-only streams first, then anything that contains audio.
  mp3: 'ba[ext=m4a]/ba[ext=mp3]/ba/ba*/b',
  m4a: 'ba[ext=m4a]/ba/ba*/b',
  opus: 'ba[ext=webm]/ba/ba*/b',
  audio: 'ba/ba*/b',
  // Source-native: no conversion at all, container chosen by yt-dlp.
  auto: 'bv*+ba/b/ba/bv*',
  // Used when an explicit selector failed and we retry once, loosened.
  relaxed: 'b/ba/bv*+ba/bv*',
  // direct-url: a single playable file is preferable to a merge the caller
  // can't perform, but fall back to the merge pair when that's all there is.
  direct: 'b/bv*+ba/ba/bv*',
};

/** Extensions /media/download accepts for `ext`. */
export const DOWNLOAD_EXTS = ['mp4', 'mp3', 'm4a', 'opus', 'webm', 'audio', 'auto'];

const AUDIO_ONLY_EXTS = new Set(['mp3', 'm4a', 'opus', 'audio']);

// ---------------------------------------------------------------------------
// process runner
// ---------------------------------------------------------------------------

/** Run yt-dlp once, collecting stdout + stderr. SIGKILLs after timeoutMs. */
function runYtDlp(args, { timeoutMs = INFO_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      // A pathological page (huge channel dump) shouldn't be able to OOM us.
      if (stdoutBytes > MAX_JSON_BYTES) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      // Keep the tail only: some extractors are extremely chatty on failure.
      stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
    });

    child.on('error', (err) => {
      finish();
      reject(
        new YtDlpError(`Failed to launch yt-dlp: ${err.message}`, stderr, {
          code: 'ytdlp_unavailable',
          status: 500,
          hint: 'Check that yt-dlp is installed and YTDLP_BIN points at it.',
        }),
      );
    });

    child.on('close', (code) => {
      finish();
      if (aborted) {
        reject(new YtDlpError('Request cancelled', stderr, { code: 'cancelled', status: 499 }));
        return;
      }
      if (overflowed) {
        reject(
          new YtDlpError('yt-dlp output was too large to process', stderr, {
            code: 'response_too_large',
            status: 413,
            hint: 'Use playlist=true with a smaller limit, or request a single item.',
          }),
        );
        return;
      }
      if (timedOut) {
        reject(YtDlpError.fromStderr(stderr, { timedOut: true }));
        return;
      }
      if (code !== 0) {
        reject(YtDlpError.fromStderr(stderr));
        return;
      }
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

function parseJsonOutput(stdout, stderr, what) {
  const text = stdout.toString('utf-8').trim();
  if (!text) {
    throw YtDlpError.fromStderr(stderr || `yt-dlp produced no output for ${what}`);
  }
  // `-J` emits one JSON document, but a few extractors/`--flat-playlist`
  // combinations emit JSON Lines. Accept both.
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
    for (const line of lines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        /* keep looking */
      }
    }
    throw new YtDlpError(`yt-dlp returned non-JSON output for ${what}`, text.slice(0, 500), {
      code: 'bad_output',
      status: 502,
    });
  }
}

// ---------------------------------------------------------------------------
// public operations
// ---------------------------------------------------------------------------

/**
 * Full metadata for `url`.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.playlist] return every entry instead of the first
 * @param {number}  [opts.limit]    max entries when playlist=true
 * @param {number|string} [opts.item] 1-based item to extract from a playlist
 */
export async function fetchMediaInfo(url, { playlist = false, limit = 50, item = null, signal = null } = {}) {
  const { stdout, stderr } = await runYtDlp(
    ['-J', ...baseArgs(url), ...playlistArgs({ playlist, item, limit }), '--', url],
    { timeoutMs: INFO_TIMEOUT_MS, signal },
  );

  const raw = parseJsonOutput(stdout, stderr, 'info request');
  const info = normalizeInfo(raw, { expandPlaylist: playlist });

  if (info.formats?.length === 0 && !info.isPlaylist) {
    logger.warn({ extractor: info.extractor }, 'Extractor returned no formats');
  }
  return info;
}

/**
 * Resolve the underlying CDN URL(s) without routing bytes through this
 * server. Returns both the legacy `urls` array and richer `streams`
 * objects carrying protocol + the HTTP headers the CDN expects.
 */
export async function resolveDirectUrls(url, format, { item = null, signal = null } = {}) {
  const selector = format || FORMAT_SELECTORS.direct;

  const run = (sel) =>
    runYtDlp(['-J', '-f', sel, ...baseArgs(url), ...playlistArgs({ item }), '--', url], {
      timeoutMs: INFO_TIMEOUT_MS,
      signal,
    });

  let result;
  try {
    result = await run(selector);
  } catch (err) {
    // A selector that doesn't fit this site shouldn't be a dead end.
    if (err instanceof YtDlpError && isFormatSelectionFailure(err.stderr)) {
      logger.info({ selector }, 'Format selector unavailable — retrying with a relaxed selector');
      result = await run(FORMAT_SELECTORS.relaxed);
    } else {
      throw err;
    }
  }

  const raw = parseJsonOutput(result.stdout, result.stderr, 'direct-url request');
  const { node, streams } = extractStreams(raw);

  if (streams.length === 0) {
    throw new YtDlpError('No streamable URL found for the requested format', result.stderr, {
      code: 'format_unavailable',
      status: 422,
      hint: 'Call /api/media/info to see which formats this source offers.',
    });
  }

  const expiresAt = streams.map((s) => guessUrlExpiry(s.url)).find(Boolean) ?? null;

  return {
    title: node?.title ?? raw.title ?? null,
    extractor: node?.extractor ?? raw.extractor ?? null,
    webpageUrl: node?.webpage_url ?? raw.webpage_url ?? null,
    durationSeconds: node?.duration ?? raw.duration ?? null,
    thumbnail: node?.thumbnail ?? raw.thumbnail ?? null,
    isLive: Boolean(node?.is_live ?? raw.is_live),
    // `urls` is kept for backwards compatibility with existing clients.
    urls: streams.map((s) => s.url),
    streams,
    // True when the caller must merge two streams itself (or just use
    // /media/download instead).
    requiresMerge: streams.length > 1,
    expiresAt,
  };
}

/** Build the yt-dlp argv for a download into `outputTemplate`. */
export function buildDownloadArgs({
  url,
  ext = 'mp4',
  format = null,
  outputTemplate,
  allowLive = false,
  item = null,
  relaxFormat = false,
  skipRemux = false,
}) {
  const selector = relaxFormat
    ? FORMAT_SELECTORS.relaxed
    : format || FORMAT_SELECTORS[ext] || FORMAT_SELECTORS.auto;

  const args = ['-f', selector, ...baseArgs(url), ...playlistArgs({ item })];

  if (!allowLive) {
    // Cheaper than a separate info call: yt-dlp skips live items itself and
    // says so on stderr, which we turn into a clear 422.
    args.push('--match-filter', '!is_live');
  } else {
    args.push('--no-live-from-start');
  }

  if (MAX_FILESIZE) args.push('--max-filesize', MAX_FILESIZE);
  if (CONCURRENT_FRAGMENTS !== '1') args.push('--concurrent-fragments', CONCURRENT_FRAGMENTS);

  if (AUDIO_ONLY_EXTS.has(ext)) {
    args.push('-x');
    // `audio` keeps whatever codec the source has (no re-encode, fastest).
    if (ext !== 'audio') args.push('--audio-format', ext, '--audio-quality', '0');
  } else if (ext === 'mp4' || ext === 'webm') {
    args.push('--merge-output-format', ext);
    // Remux (stream copy, no re-encode) when the source container differs.
    // Skipped on retry: a few codec/container pairs simply can't be remuxed.
    if (!skipRemux && capabilities.ffmpeg) args.push('--remux-video', ext);
  }
  // ext === 'auto': no container forced — yt-dlp picks one that fits the codecs.

  args.push('-o', outputTemplate, '--', url);
  return args;
}

/**
 * Fork yt-dlp for a real download. Kept exported for compatibility; new
 * code should use downloadToDir() which adds retries and output discovery.
 */
export function spawnDownload(args, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  // Last arg is always the source URL (may contain tokens) — never log it.
  const loggableArgs = args.slice(0, -1).join(' ');
  logger.info({ args: loggableArgs }, 'Spawning yt-dlp download process');
  const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.resume();

  const timer = setTimeout(() => {
    logger.warn({ timeoutMs }, 'Killing yt-dlp download: exceeded max duration');
    child.timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.on('close', () => clearTimeout(timer));

  return child;
}

function runDownloadOnce(args, { signal, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawnDownload(args, { timeoutMs });
    let stderr = '';
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: -1, stderr: `${stderr}\nERROR: ${err.message}`, aborted, timedOut: false });
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stderr, aborted, timedOut: Boolean(child.timedOut) });
    });
  });
}

async function listMediaFiles(dir) {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        const info = await stat(path.join(dir, name));
        return info.isFile() ? { name, size: info.size } : null;
      } catch {
        return null;
      }
    }),
  );
  return entries.filter(Boolean);
}

/**
 * Download into `workDir` and return the resulting file.
 *
 * Retries once with a loosened format selector when the site simply doesn't
 * have what was asked for, and once without remuxing when the merge step is
 * what failed. Both are extremely common outside YouTube and used to
 * surface as a bare 422.
 */
export async function downloadToDir({
  url,
  workDir,
  ext = 'mp4',
  format = null,
  allowLive = false,
  item = null,
  signal = null,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  const outputTemplate = path.join(workDir, '%(title).120B [%(id).60B].%(ext)s');
  const attempts = [{ relaxFormat: false, skipRemux: false }];

  let lastResult = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const args = buildDownloadArgs({ url, ext, format, outputTemplate, allowLive, item, ...attempt });
    const result = await runDownloadOnce(args, { signal, timeoutMs });
    lastResult = result;

    if (result.aborted) {
      throw new YtDlpError('Request cancelled', result.stderr, { code: 'cancelled', status: 499 });
    }

    if (result.code === 0) {
      const file = pickOutputFile(await listMediaFiles(workDir));
      if (file) return { file: { ...file, path: path.join(workDir, file.name) }, stderr: result.stderr };

      // Exit code 0 with nothing on disk: almost always --match-filter
      // skipping a live stream, or an extractor that only had images.
      if (/does not pass filter/i.test(result.stderr)) {
        throw new YtDlpError('This is a live stream', result.stderr, {
          code: 'live_stream',
          status: 422,
          hint: 'Pass allowLive=true to record it (recording stops at the download timeout).',
        });
      }
      throw new YtDlpError('Download produced no output file', result.stderr, {
        code: 'no_output',
        status: 422,
      });
    }

    // Decide whether a different set of arguments could still succeed.
    if (!attempt.relaxFormat && !format && isFormatSelectionFailure(result.stderr)) {
      logger.info('Download format unavailable — retrying with a relaxed selector');
      attempts.push({ relaxFormat: true, skipRemux: attempt.skipRemux });
      await clearDir(workDir);
      continue;
    }
    if (!attempt.skipRemux && isPostProcessingFailure(result.stderr) && (ext === 'mp4' || ext === 'webm')) {
      logger.info({ ext }, 'Remux failed — retrying and keeping the source container');
      attempts.push({ relaxFormat: attempt.relaxFormat, skipRemux: true });
      await clearDir(workDir);
      continue;
    }
    break;
  }

  throw YtDlpError.fromStderr(lastResult?.stderr ?? '', { timedOut: Boolean(lastResult?.timedOut) });
}

async function clearDir(dir) {
  try {
    const names = await readdir(dir);
    await Promise.all(names.map((n) => rm(path.join(dir, n), { recursive: true, force: true })));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// supported-site discovery
// ---------------------------------------------------------------------------

let extractorCache = null;

/** The list of extractors this yt-dlp build supports (cached for the process). */
export async function listExtractors() {
  if (extractorCache) return extractorCache;
  const { stdout } = await runYtDlp(['--ignore-config', '--list-extractors'], { timeoutMs: 60_000 });
  extractorCache = stdout
    .toString('utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('[') && l !== 'generic');
  return extractorCache;
}

// ---------------------------------------------------------------------------
// temp dir housekeeping
// ---------------------------------------------------------------------------

/**
 * Remove leftover per-request temp dirs older than maxAgeMs. Each request
 * cleans up its own dir on close/error, but a crash or SIGKILL mid-request
 * can leave one behind; this is the safety net against that.
 */
export async function sweepStaleTempDirs(maxAgeMs) {
  const base = tmpdir();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err }, 'Temp dir sweep: failed to list tmpdir');
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) continue;
    const fullPath = path.join(base, entry.name);
    try {
      const info = await stat(fullPath);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(fullPath, { recursive: true, force: true });
        logger.info({ dir: fullPath }, 'Temp dir sweep: removed stale download dir');
      }
    } catch (err) {
      logger.warn({ err, dir: fullPath }, 'Temp dir sweep: failed to inspect/remove dir');
    }
  }
}

export { INFO_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS };
