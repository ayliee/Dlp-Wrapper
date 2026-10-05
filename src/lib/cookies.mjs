// © Author: aliyie
// https://discord.gg/aerox

// Cookie management for sites that require an authenticated session.
//
// A single global cookies.txt only ever worked well for one site at a time:
// YouTube wants a YouTube jar, Instagram wants an Instagram jar, and
// handing a site someone else's cookies is at best useless and at worst a
// fast way to get the account flagged. So this supports both:
//
//   YTDLP_COOKIES_FILE  — one jar used for every site (back-compatible)
//   YTDLP_COOKIES_DIR   — a directory of per-site jars named after the
//                         domain they belong to: youtube.com.txt,
//                         instagram.com.txt, x.com.txt, ...
//   YTDLP_COOKIES_FROM_BROWSER — pass straight through to yt-dlp's
//                         --cookies-from-browser (only useful when the
//                         server runs on a desktop with that browser)
//
// This does NOT log into anything on your behalf — you still export cookies
// from a real logged-in browser. What's automatic:
//
//   1. Every jar is copied to a writable temp path and *that* path is what
//      yt-dlp gets. yt-dlp rewrites the jar as session tokens rotate, and
//      hosting platforms often mount secrets read-only (Render Secret
//      Files), which silently breaks the rewrite.
//   2. Sources are re-synced on an interval, so dropping in a freshly
//      exported file is picked up without a restart.
//   3. Expiry timestamps are parsed and warned about per domain, so you
//      know which jar to re-export before requests start failing.
import { copyFile, chmod, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from './logger.mjs';

const SOURCE_FILE = process.env.YTDLP_COOKIES_FILE;
const SOURCE_DIR = process.env.YTDLP_COOKIES_DIR;
const FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER;

const WORK_DIR = path.join(tmpdir(), 'dlp-wrapper-cookies');
const GLOBAL_KEY = '*';
const SYNC_INTERVAL_MS = Number(process.env.COOKIE_SYNC_INTERVAL_MS ?? 5 * 60_000);
const EXPIRY_WARNING_WINDOW_MS = Number(process.env.COOKIE_EXPIRY_WARNING_MS ?? 24 * 60 * 60_000);

/** domain (or '*') -> { source, writable, mtimeMs } */
const jars = new Map();

/** `youtube.com.txt` / `cookies-youtube.com.txt` -> `youtube.com` */
export function domainFromCookieFilename(filename) {
  const name = path.basename(filename);
  if (!/\.(txt|cookies|cookie)$/i.test(name)) return null;
  const base = name.replace(/\.(txt|cookies|cookie)$/i, '');
  const cleaned = base.replace(/^(cookies?[-_.])/i, '').trim().toLowerCase();
  if (!cleaned || cleaned === 'cookies') return null;
  if (cleaned === 'default' || cleaned === 'all' || cleaned === 'global') return GLOBAL_KEY;
  // Must look like a hostname: at least one dot, no path separators.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) return null;
  return cleaned.replace(/^www\./, '');
}

/** Longest-suffix match: a jar for `youtube.com` also covers `m.youtube.com`. */
export function matchDomain(hostname, domains) {
  if (!hostname) return null;
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  let best = null;
  for (const domain of domains) {
    if (domain === GLOBAL_KEY) continue;
    if (host === domain || host.endsWith(`.${domain}`)) {
      if (!best || domain.length > best.length) best = domain;
    }
  }
  return best;
}

/** Warns about expired or soon-to-expire entries in a Netscape cookies.txt. */
async function checkExpiry(label, filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return;
  }

  const now = Date.now();
  const soonThreshold = now + EXPIRY_WARNING_WINDOW_MS;
  let expired = 0;
  let expiringSoon = 0;
  let total = 0;

  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    total += 1;
    const expirySeconds = Number(cols[4]);
    if (!expirySeconds) continue; // session cookie — no fixed expiry to check
    const expiryMs = expirySeconds * 1000;
    if (expiryMs < now) expired += 1;
    else if (expiryMs < soonThreshold) expiringSoon += 1;
  }

  if (total === 0) {
    logger.warn({ jar: label }, 'Cookie file has no usable entries — is it Netscape format?');
  } else if (expired > 0) {
    logger.warn({ jar: label, expired }, 'Cookie jar has expired entries — re-export from a logged-in browser');
  } else if (expiringSoon > 0) {
    logger.warn({ jar: label, expiringSoon }, 'Cookie jar has entries expiring within 24h — re-export soon');
  }
}

async function syncJar(key, sourcePath) {
  try {
    const info = await stat(sourcePath);
    const existing = jars.get(key);
    if (existing && existing.source === sourcePath && existing.mtimeMs === info.mtimeMs) return;

    await mkdir(WORK_DIR, { recursive: true, mode: 0o700 });
    const writable = path.join(WORK_DIR, `${key === GLOBAL_KEY ? 'global' : key}.txt`);

    // copyFile() truncates-and-writes in place, so a yt-dlp process reading
    // the jar at that moment could see a half-written file. Copy aside and
    // rename() into place — atomic on POSIX, readers always see a whole file.
    const tempPath = `${writable}.tmp`;
    await copyFile(sourcePath, tempPath);
    await chmod(tempPath, 0o600); // session credentials — owner only
    await rename(tempPath, writable);

    jars.set(key, { source: sourcePath, writable, mtimeMs: info.mtimeMs });
    logger.info({ jar: key, source: sourcePath }, 'Cookie jar synced to writable working copy');
    await checkExpiry(key, writable);
  } catch (err) {
    logger.warn({ err, jar: key, source: sourcePath }, 'Failed to sync cookies file');
  }
}

async function syncOnce() {
  if (SOURCE_FILE) await syncJar(GLOBAL_KEY, SOURCE_FILE);

  if (SOURCE_DIR) {
    let entries;
    try {
      entries = await readdir(SOURCE_DIR, { withFileTypes: true });
    } catch (err) {
      logger.warn({ err, dir: SOURCE_DIR }, 'Failed to read YTDLP_COOKIES_DIR');
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const domain = domainFromCookieFilename(entry.name);
      if (!domain) {
        logger.warn(
          { file: entry.name },
          'Ignoring cookie file — name must be <domain>.txt (e.g. youtube.com.txt)',
        );
        continue;
      }
      await syncJar(domain, path.join(SOURCE_DIR, entry.name));
    }
  }
}

/** Path of the global jar, or null. Kept for backwards compatibility. */
export function activeCookiesPath() {
  return jars.get(GLOBAL_KEY)?.writable ?? null;
}

/** Domains we currently hold a jar for (diagnostics / health output). */
export function configuredCookieDomains() {
  return [...jars.keys()].map((k) => (k === GLOBAL_KEY ? 'global' : k)).sort();
}

/** The jar that applies to `url`: site-specific first, global as fallback. */
export function cookiesPathForUrl(url) {
  if (jars.size === 0) return null;
  let hostname = null;
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* fall through to the global jar */
  }
  const domain = matchDomain(hostname, [...jars.keys()]);
  if (domain) return jars.get(domain).writable;
  return jars.get(GLOBAL_KEY)?.writable ?? null;
}

/** yt-dlp arguments for whichever cookie source applies to `url`. */
export function cookieArgsForUrl(url) {
  const jarPath = cookiesPathForUrl(url);
  if (jarPath) return ['--cookies', jarPath];
  if (FROM_BROWSER) return ['--cookies-from-browser', FROM_BROWSER];
  return [];
}

/** Starts the initial sync + periodic re-sync. No-op when nothing is configured. */
export async function startCookieManager() {
  if (!SOURCE_FILE && !SOURCE_DIR) {
    if (FROM_BROWSER) logger.info({ browser: FROM_BROWSER }, 'Using --cookies-from-browser');
    return;
  }
  await syncOnce();
  if (jars.size > 0) {
    logger.info({ domains: configuredCookieDomains() }, 'Cookie jars ready');
  }
  setInterval(() => {
    syncOnce().catch((err) => logger.warn({ err }, 'Cookie sync failed'));
  }, SYNC_INTERVAL_MS).unref();
}
