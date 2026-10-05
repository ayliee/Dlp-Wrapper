// © Author: aliyie
// https://discord.gg/aerox

// Helpers for turning whatever yt-dlp left in the temp dir into a correct
// HTTP response. Pure functions — unit-tested in tests/files.test.mjs.

import path from 'node:path';

/**
 * Content types for every container yt-dlp realistically produces. The old
 * code hard-coded video/mp4 or audio/mpeg based on the *requested* ext,
 * which lied whenever the source only had webm/opus (common outside
 * YouTube) or when the "video" was actually an image post (TikTok photo
 * mode, Reddit galleries, Instagram carousels).
 */
const CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  '3gp': 'video/3gpp',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ogv: 'video/ogg',

  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',

  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
};

/** MIME type for a filename/extension, defaulting to a safe binary type. */
export function contentTypeFor(filename) {
  const ext = path.extname(String(filename ?? '')).replace('.', '').toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// Sidecars yt-dlp may leave next to the media file.
const SIDECAR_EXTS = new Set([
  '.part', '.ytdl', '.temp', '.tmp', '.json', '.description', '.annotations',
  '.srt', '.vtt', '.ass', '.lrc', '.ttml', '.sbv', '.url', '.txt',
]);

/**
 * Choose the real output among everything in the temp dir.
 *
 * Previously this took `files[0]`, which is whatever order readdir happened
 * to return — with a merged download that can easily be the leftover
 * `.f140.m4a` audio fragment or a thumbnail instead of the finished file.
 * Largest non-sidecar file is a far better bet.
 *
 * @param {Array<{name: string, size: number}>} entries
 */
export function pickOutputFile(entries) {
  const candidates = (entries ?? []).filter((e) => {
    if (!e?.name) return false;
    const ext = path.extname(e.name).toLowerCase();
    if (SIDECAR_EXTS.has(ext)) return false;
    if (/\.info\.json$/i.test(e.name)) return false;
    return (e.size ?? 0) > 0;
  });
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.size - a.size)[0];
}

/** Strip characters that are unsafe in a filename or an HTTP header. */
export function sanitizeFilename(name, maxLength = 120) {
  let out = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) out = 'download';
  if (out.length > maxLength) out = out.slice(0, maxLength).trim();
  return out;
}

/**
 * RFC 6266 Content-Disposition with both an ASCII fallback and a UTF-8
 * encoded form. Non-ASCII titles (Japanese, Cyrillic, Arabic, emoji — i.e.
 * most of the internet outside English YouTube) used to be interpolated raw
 * into the header, which produced either mojibake or an outright invalid
 * header that some proxies reject.
 */
export function contentDispositionFor(filename) {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Final download filename: prefer the media title yt-dlp wrote to disk,
 * but always keep the real extension of the file we're actually sending
 * (an mp4 request against a webm-only source still yields webm when
 * remuxing isn't possible).
 */
export function buildDownloadName(diskName, fallbackBase = 'download') {
  const name = String(diskName ?? '');
  // path.extname('.mp4') is '' (it's a dotfile), but here such a name only
  // happens when the title was empty — treat it as a bare extension.
  const ext = path.extname(name) || (/^\.[a-z0-9]+$/i.test(name) ? name : '');
  let base = path.basename(name, ext) || fallbackBase;
  // yt-dlp's "%(title)s [%(id)s]" template is redundant when an extractor
  // uses the id as the title (common on file hosts) — "sample [sample]".
  const duplicated = /^(.*) \[(.*)\]$/.exec(base);
  if (duplicated && duplicated[1] === duplicated[2]) base = duplicated[1];
  return `${sanitizeFilename(base, 120)}${ext.toLowerCase()}`;
}
