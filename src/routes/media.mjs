// © Author: aliyie
// https://discord.gg/aerox

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DOWNLOAD_EXTS,
  downloadToDir,
  fetchMediaInfo,
  listExtractors,
  resolveDirectUrls,
  TEMP_DIR_PREFIX,
  YtDlpError,
} from '../lib/ytdlp.mjs';
import {
  assertPublicHttpUrl,
  normalizeInputUrl,
  safeEqual,
  Semaphore,
  SsrfError,
} from '../lib/security.mjs';
import { buildDownloadName, contentDispositionFor, contentTypeFor } from '../lib/files.mjs';
import { buildRateLimitStore } from '../lib/rateLimitStore.mjs';
import { cacheGet, cacheSet } from '../lib/cache.mjs';
import { incrementQuota } from '../lib/quota.mjs';
import { activeJobs, cacheEvents, extractionResults, quotaRejections } from '../lib/metrics.mjs';

const router = Router();

function sendError(res, status, message, extra = {}) {
  if (res.headersSent) return;
  res.status(status).json({ error: message, ...extra });
}

/** Map a YtDlpError onto a real status code + machine-readable code/hint. */
function sendYtDlpError(res, req, err, fallbackMessage) {
  if (err instanceof YtDlpError) {
    if (err.code === 'cancelled') return; // client went away; nothing to send
    extractionResults.inc({ result: err.code });
    req.log?.warn({ code: err.code, detail: err.detail }, 'yt-dlp extraction failed');
    sendError(res, err.status, err.message, {
      code: err.code,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.detail && err.detail !== err.message ? { detail: err.detail } : {}),
    });
    return;
  }
  req.log?.error({ err }, fallbackMessage);
  extractionResults.inc({ result: 'internal_error' });
  sendError(res, 500, fallbackMessage, { code: 'internal_error' });
}

/**
 * When API_KEY is unset the endpoint is open (fine for local/private use,
 * not for a public deployment). Comparison is constant-time.
 */
function requireApiKey(req, res) {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) return true;

  const providedKey = req.header('x-api-key') ?? bearerToken(req);
  if (providedKey && safeEqual(providedKey, configuredKey)) return true;

  sendError(res, 401, 'Invalid or missing API key', { code: 'unauthorized' });
  return false;
}

/** Some HTTP clients only speak Authorization headers — accept both. */
function bearerToken(req) {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function parseUrlParam(req, res) {
  const raw = req.query.url ?? req.body?.url;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    sendError(res, 400, "Query parameter 'url' is required", { code: 'missing_url' });
    return null;
  }
  const url = normalizeInputUrl(raw);
  if (!url) {
    sendError(res, 400, "Query parameter 'url' is required", { code: 'missing_url' });
    return null;
  }
  return url;
}

/** Rejects (400) unless `url` is a public http(s) address — SSRF guard. */
async function assertUrlIsSafe(url, req, res) {
  try {
    await assertPublicHttpUrl(url);
    return true;
  } catch (err) {
    if (err instanceof SsrfError) {
      sendError(res, 400, err.message, { code: 'invalid_url' });
      return false;
    }
    req.log?.error({ err }, 'Unexpected error validating url');
    sendError(res, 400, 'Invalid url', { code: 'invalid_url' });
    return false;
  }
}

// yt-dlp format selectors are built from a small character set: format ids,
// +, *, /, [], (), comparison operators (<, >, =, !=, ^=, $=, *=, ~=), and
// quoted regexes for codec matching.
const SAFE_FORMAT_RE = /^[a-zA-Z0-9_\-+*/,.:<>=!~^$&|?'"\[\]() ]{1,300}$/;

function parseFormatParam(req, res, fallback) {
  const raw = req.query.format;
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !SAFE_FORMAT_RE.test(raw)) {
    sendError(res, 400, "Query parameter 'format' is invalid", { code: 'invalid_format' });
    return null;
  }
  return raw;
}

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** 1-based playlist item selector (`item=3`). Returns undefined when absent. */
function parseItemParam(req, res) {
  const raw = req.query.item ?? req.query.index;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) {
    sendError(res, 400, "Query parameter 'item' must be a positive integer", { code: 'invalid_item' });
    return undefined;
  }
  return n;
}

const PLAYLIST_LIMIT_MAX = Number(process.env.PLAYLIST_MAX_ITEMS ?? 200);

function parseLimitParam(req, res) {
  const raw = req.query.limit;
  if (raw === undefined || raw === '') return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > PLAYLIST_LIMIT_MAX) {
    sendError(res, 400, `Query parameter 'limit' must be between 1 and ${PLAYLIST_LIMIT_MAX}`, {
      code: 'invalid_limit',
    });
    return undefined;
  }
  return n;
}

/** AbortSignal that fires when the client hangs up, so yt-dlp dies with it. */
function abortOnDisconnect(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);
  res.on('close', () => req.off('close', onClose));
  return controller.signal;
}

// ---------------- concurrency: immediate-reject or queued ----------------

// Each yt-dlp/ffmpeg call is a real subprocess (CPU, RAM, and for downloads,
// disk). These caps stop a handful of concurrent requests from taking the
// whole service down on a small container — raise via env vars if the plan
// is sized for more.
const infoSemaphore = new Semaphore(Number(process.env.DLP_MAX_CONCURRENT_INFO ?? 8));
const downloadSemaphore = new Semaphore(Number(process.env.DLP_MAX_CONCURRENT_DOWNLOADS ?? 2));

// By default, hitting the concurrency cap returns 429 immediately. Setting
// QUEUE_ENABLED=true instead makes the request wait (bounded by
// QUEUE_MAX_WAIT_MS, with at most QUEUE_MAX_LENGTH requests waiting at
// once) for a slot to free up — trades latency for a lower rejection rate
// under bursty load.
const QUEUE_ENABLED = process.env.QUEUE_ENABLED === 'true';
const QUEUE_MAX_WAIT_MS = Number(process.env.QUEUE_MAX_WAIT_MS ?? 15_000);
const QUEUE_MAX_LENGTH = Number(process.env.QUEUE_MAX_LENGTH ?? 50);

/** Acquires a slot (immediately or via the queue); sends 429 itself on failure. */
async function acquireSlot(semaphore, kind, req, res, busyMessage) {
  const acquired = QUEUE_ENABLED
    ? await semaphore.acquireQueued(QUEUE_MAX_WAIT_MS, QUEUE_MAX_LENGTH)
    : semaphore.tryAcquire();

  if (!acquired) {
    sendError(res, 429, busyMessage, { code: 'server_busy' });
    return false;
  }
  if (req.destroyed || res.writableEnded) {
    // Client gave up while we were queued — free the slot, don't spawn work.
    semaphore.release();
    return false;
  }
  activeJobs.inc({ kind });
  return true;
}

function releaseSlot(semaphore, kind) {
  semaphore.release();
  activeJobs.dec({ kind });
}

// ---------------- per-IP quotas (opt-in, longer window than rate limits) ----------------

const QUOTA_ENABLED = process.env.QUOTA_ENABLED === 'true';
const QUOTA_WINDOW_MS = Number(process.env.QUOTA_WINDOW_MS ?? 24 * 60 * 60_000);
const QUOTA_MAX_INFO = Number(process.env.QUOTA_MAX_INFO ?? 500);
const QUOTA_MAX_DIRECT_URL = Number(process.env.QUOTA_MAX_DIRECT_URL ?? 500);
const QUOTA_MAX_DOWNLOADS = Number(process.env.QUOTA_MAX_DOWNLOADS ?? 50);

/** Enforces the per-IP daily quota for `route`; sends 429 itself on the caller's behalf. */
async function enforceQuota(route, max, req, res) {
  if (!QUOTA_ENABLED) return true;
  const { limited, resetAt } = await incrementQuota(`${route}:${req.ip}`, QUOTA_WINDOW_MS, max);
  if (!limited) return true;

  quotaRejections.inc({ route });
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
  sendError(res, 429, `Daily quota exceeded for this endpoint — resets ${new Date(resetAt).toISOString()}`, {
    code: 'quota_exceeded',
  });
  return false;
}

// ---------------- metadata cache (opt-in speedup, Redis or in-memory) ----------------

const CACHE_TTL_INFO_MS = Number(process.env.CACHE_TTL_INFO_MS ?? 5 * 60_000);
const CACHE_TTL_DIRECT_URL_MS = Number(process.env.CACHE_TTL_DIRECT_URL_MS ?? 2 * 60_000);

// Downloads spin up ffmpeg and can run for minutes — a stricter limit on
// top of the general one in app.mjs. Shares the same Redis store as the
// general limiter when REDIS_URL is configured.
const downloadLimiter = rateLimit({
  windowMs: Number(process.env.DOWNLOAD_RATE_LIMIT_WINDOW_MS ?? 10 * 60_000),
  limit: Number(process.env.DOWNLOAD_RATE_LIMIT_MAX ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimitStore('dlpwrapper:rl:download:'),
  passOnStoreError: true, // same reasoning as the general limiter in app.mjs
  message: { error: 'Too many download requests — please slow down', code: 'rate_limited' },
});

/**
 * GET /api/media/info?url=<url>[&playlist=true&limit=50][&item=2]
 *
 * Metadata for any yt-dlp-supported URL: title, thumbnail, duration,
 * uploader, live status and the full format list.
 *
 * Sources that bundle several clips into one post (Twitter threads, Reddit
 * galleries, TikTok photo carousels, Instagram multi-item posts) come back
 * as the first item plus a `partOfPlaylist` summary; pass playlist=true to
 * get every entry instead.
 */
router.get('/media/info', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const url = parseUrlParam(req, res);
  if (!url) return;
  if (!(await assertUrlIsSafe(url, req, res))) return;

  const item = parseItemParam(req, res);
  if (item === undefined) return;
  const limit = parseLimitParam(req, res);
  if (limit === undefined) return;
  const playlist = parseBool(req.query.playlist);

  if (!(await enforceQuota('info', QUOTA_MAX_INFO, req, res))) return;

  const cacheKey = [url, `playlist=${playlist}`, `limit=${limit}`, `item=${item ?? ''}`];
  const cached = await cacheGet('info', cacheKey);
  if (cached) {
    cacheEvents.inc({ namespace: 'info', result: 'hit' });
    res.json(cached);
    return;
  }
  cacheEvents.inc({ namespace: 'info', result: 'miss' });

  if (!(await acquireSlot(infoSemaphore, 'info', req, res, 'Server is busy — please retry shortly'))) return;

  try {
    const info = await fetchMediaInfo(url, { playlist, limit, item, signal: abortOnDisconnect(req, res) });
    extractionResults.inc({ result: 'ok' });
    await cacheSet('info', cacheKey, info, CACHE_TTL_INFO_MS);
    res.json(info);
  } catch (err) {
    sendYtDlpError(res, req, err, 'Failed to extract media info');
  } finally {
    releaseSlot(infoSemaphore, 'info');
  }
});

/**
 * GET /api/media/direct-url?url=<url>[&format=<selector>][&item=2]
 *
 * Resolves the underlying CDN URL(s) with no bytes routed through this
 * server — good for Discord embeds or `<video src>`.
 *
 * Each entry in `streams` carries the protocol and the HTTP headers the CDN
 * expects: plenty of sites (Instagram, TikTok, Facebook, Bilibili) 403 a
 * direct URL fetched without the original Referer/User-Agent, and HLS/DASH
 * entries (`isManifest: true`) need a player rather than a plain GET.
 * Fall back to /media/download when either gets in the way.
 */
router.get('/media/direct-url', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const url = parseUrlParam(req, res);
  if (!url) return;
  if (!(await assertUrlIsSafe(url, req, res))) return;

  const format = parseFormatParam(req, res, '');
  if (format === null) return;
  const item = parseItemParam(req, res);
  if (item === undefined) return;
  if (!(await enforceQuota('direct-url', QUOTA_MAX_DIRECT_URL, req, res))) return;

  const cacheKey = [url, `format=${format}`, `item=${item ?? ''}`];
  const cached = await cacheGet('direct-url', cacheKey);
  if (cached) {
    cacheEvents.inc({ namespace: 'direct-url', result: 'hit' });
    res.json(cached);
    return;
  }
  cacheEvents.inc({ namespace: 'direct-url', result: 'miss' });

  if (!(await acquireSlot(infoSemaphore, 'info', req, res, 'Server is busy — please retry shortly'))) return;

  try {
    const result = await resolveDirectUrls(url, format, { item, signal: abortOnDisconnect(req, res) });
    extractionResults.inc({ result: 'ok' });
    await cacheSet('direct-url', cacheKey, result, CACHE_TTL_DIRECT_URL_MS);
    res.json(result);
  } catch (err) {
    sendYtDlpError(res, req, err, 'Failed to resolve direct url');
  } finally {
    releaseSlot(infoSemaphore, 'info');
  }
});

/**
 * GET /api/media/download?url=<url>[&ext=mp4|mp3|m4a|opus|webm|audio|auto]
 *                        [&format=<selector>][&item=2][&allowLive=true]
 *
 * Streams the media back as an attachment: yt-dlp downloads into a temp
 * dir, then we pipe the file to the response.
 *
 * `ext` is best-effort, not a promise to transcode: a webm-only source
 * requested as mp4 is remuxed when the codecs allow it and otherwise comes
 * back in its original container — the Content-Type and filename always
 * describe what's actually in the body. Use ext=auto to skip conversion
 * entirely (fastest, works everywhere), or ext=mp3/m4a/opus for audio.
 */
router.get('/media/download', downloadLimiter, async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const url = parseUrlParam(req, res);
  if (!url) return;
  if (!(await assertUrlIsSafe(url, req, res))) return;

  const rawExt = req.query.ext;
  const ext = rawExt === undefined || rawExt === '' ? 'mp4' : String(rawExt).toLowerCase();
  if (!DOWNLOAD_EXTS.includes(ext)) {
    sendError(res, 400, `Query parameter 'ext' must be one of: ${DOWNLOAD_EXTS.join(', ')}`, {
      code: 'invalid_ext',
    });
    return;
  }

  const format = parseFormatParam(req, res, null);
  if (format === null && req.query.format !== undefined && req.query.format !== '') return;
  const item = parseItemParam(req, res);
  if (item === undefined) return;
  const allowLive = parseBool(req.query.allowLive);

  if (!(await enforceQuota('download', QUOTA_MAX_DOWNLOADS, req, res))) return;

  if (!(await acquireSlot(downloadSemaphore, 'download', req, res, 'Too many downloads in progress — please retry shortly'))) return;

  // mkdtemp can fail (disk full, permissions) — without this guard the
  // rejection is unhandled (Express 4 doesn't forward async rejections to
  // error middleware), which takes down every in-flight request, not just
  // this one.
  let workDir;
  try {
    workDir = await mkdtemp(path.join(tmpdir(), TEMP_DIR_PREFIX));
  } catch (err) {
    req.log?.error({ err }, 'Failed to create temp download directory');
    releaseSlot(downloadSemaphore, 'download');
    sendError(res, 500, 'Failed to prepare download', { code: 'internal_error' });
    return;
  }

  let released = false;
  const cleanup = () => {
    if (!released) {
      released = true;
      releaseSlot(downloadSemaphore, 'download');
    }
    rm(workDir, { recursive: true, force: true }).catch((err) => {
      req.log?.warn({ err, workDir }, 'Failed to clean up temp download dir');
    });
  };

  try {
    const { file } = await downloadToDir({
      url,
      workDir,
      ext,
      format: format || null,
      allowLive,
      item,
      signal: abortOnDisconnect(req, res),
    });

    if (res.writableEnded || req.destroyed) {
      cleanup();
      return;
    }

    const downloadName = buildDownloadName(file.name);
    res.setHeader('Content-Disposition', contentDispositionFor(downloadName));
    // Derived from the file we actually produced, not from what was asked
    // for — those differ whenever a remux wasn't possible.
    res.setHeader('Content-Type', contentTypeFor(file.name));
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Media-Filename', encodeURIComponent(downloadName));
    extractionResults.inc({ result: 'ok' });

    const readStream = createReadStream(file.path);
    readStream.on('error', (err) => {
      req.log?.error({ err }, 'Error streaming downloaded file');
      if (!res.headersSent) sendError(res, 500, 'Failed to stream download', { code: 'internal_error' });
      res.destroy();
      cleanup();
    });
    readStream.on('close', cleanup);
    readStream.pipe(res);
  } catch (err) {
    sendYtDlpError(res, req, err, 'Download failed');
    cleanup();
  }
});

/**
 * GET /api/media/extractors[?query=tiktok][&limit=100]
 *
 * The list of sites this yt-dlp build supports, straight from the binary —
 * handy for checking whether a source is covered before wiring it up.
 */
router.get('/media/extractors', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';
  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 100;

  try {
    const all = await listExtractors();
    const matched = query ? all.filter((name) => name.toLowerCase().includes(query)) : all;
    res.json({
      total: all.length,
      matched: matched.length,
      query: query || null,
      extractors: matched.slice(0, limit),
    });
  } catch (err) {
    sendYtDlpError(res, req, err, 'Failed to list extractors');
  }
});

export default router;
