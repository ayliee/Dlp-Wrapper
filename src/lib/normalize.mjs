// © Author: aliyie
// https://discord.gg/aerox

// yt-dlp's JSON dump is extractor-dependent: YouTube fills in almost every
// field, SoundCloud has no video at all, Twitter/Reddit/TikTok hand back a
// playlist wrapper for a single post, Twitch gives you an HLS manifest with
// no filesize, and plenty of small extractors only set `url` with no
// `formats` array at all.
//
// Everything in this file normalizes those shapes into one stable API
// response so a client doesn't need per-site special cases. Pure functions
// only — unit-tested in tests/normalize.test.mjs.

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'flv', 'avi', 'm4v', 'ts', '3gp', 'mpg', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'oga', 'wav', 'flac', 'wma', 'aiff']);
const MANIFEST_PROTOCOLS = /m3u8|dash|ism|rtmp|rtsp|f4m/i;

const isNoCodec = (c) => !c || c === 'none';
const nullIfUndef = (v) => (v === undefined ? null : v);

/**
 * Storyboards (grids of thumbnails yt-dlp exposes as `mhtml` formats) are
 * never something a caller wants to download, and on YouTube they outnumber
 * the real formats. Dropped by default.
 */
export function isStoryboardFormat(raw) {
  if (!raw) return true;
  if (raw.ext === 'mhtml' || raw.protocol === 'mhtml') return true;
  if (typeof raw.format_note === 'string' && /storyboard/i.test(raw.format_note)) return true;
  if (typeof raw.format_id === 'string' && /^sb\d*$/i.test(raw.format_id)) return true;
  return false;
}

/** A single entry of the `formats` array, normalized. */
export function toMediaFormat(raw) {
  const vcodec = nullIfUndef(raw.vcodec);
  const acodec = nullIfUndef(raw.acodec);
  const ext = typeof raw.ext === 'string' ? raw.ext.toLowerCase() : '';
  // The generic extractor (and a long tail of small ones) report no codecs
  // at all. Falling back to the container beats telling the caller a plain
  // .mp4 has neither video nor audio.
  const codecsUnknown = vcodec == null && acodec == null;
  const hasVideo =
    !isNoCodec(vcodec) || Boolean(raw.width || raw.height) || (codecsUnknown && VIDEO_EXTS.has(ext));
  const hasAudio =
    !isNoCodec(acodec) ||
    Boolean(raw.abr || raw.asr) ||
    (codecsUnknown && (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)));
  const protocol = nullIfUndef(raw.protocol);

  let resolution = raw.resolution ?? null;
  if (!resolution && raw.width && raw.height) resolution = `${raw.width}x${raw.height}`;
  if (!resolution && !hasVideo && hasAudio) resolution = 'audio only';

  return {
    formatId: raw.format_id ?? null,
    ext: raw.ext ?? null,
    resolution,
    width: nullIfUndef(raw.width),
    height: nullIfUndef(raw.height),
    fps: nullIfUndef(raw.fps),
    note: raw.format_note ?? null,
    filesize: nullIfUndef(raw.filesize),
    filesizeApprox: raw.filesize ?? raw.filesize_approx ?? null,
    tbr: nullIfUndef(raw.tbr),
    abr: nullIfUndef(raw.abr),
    vbr: nullIfUndef(raw.vbr),
    asr: nullIfUndef(raw.asr),
    audioChannels: nullIfUndef(raw.audio_channels),
    language: nullIfUndef(raw.language),
    protocol,
    container: raw.container ?? null,
    vcodec,
    acodec,
    hasVideo,
    hasAudio,
    // HLS/DASH/ISM URLs are manifests: a browser <video src> can't always
    // play them directly and a plain HTTP GET won't give you the media.
    isManifest: Boolean(protocol && MANIFEST_PROTOCOLS.test(protocol)),
    isDrm: Boolean(raw.has_drm),
  };
}

/**
 * Some extractors (plain file hosts, a lot of the small ones, and the
 * generic extractor) return no `formats` array — just top-level `url`/`ext`.
 * Synthesize a single format so clients always get a non-empty list.
 */
function formatsFrom(raw) {
  const list = Array.isArray(raw.formats) ? raw.formats : [];
  const usable = list.filter((f) => f && !isStoryboardFormat(f));
  if (usable.length > 0) return usable.map(toMediaFormat);

  if (typeof raw.url === 'string' && raw.url) {
    return [
      toMediaFormat({
        format_id: raw.format_id ?? 'source',
        ext: raw.ext,
        url: raw.url,
        width: raw.width,
        height: raw.height,
        fps: raw.fps,
        vcodec: raw.vcodec,
        acodec: raw.acodec,
        protocol: raw.protocol,
        filesize: raw.filesize,
        filesize_approx: raw.filesize_approx,
        tbr: raw.tbr,
        abr: raw.abr,
      }),
    ];
  }
  return [];
}

/** Best available thumbnail: explicit field first, else the largest in `thumbnails`. */
export function pickThumbnail(raw) {
  if (typeof raw.thumbnail === 'string' && raw.thumbnail) return raw.thumbnail;
  const thumbs = Array.isArray(raw.thumbnails) ? raw.thumbnails.filter((t) => t?.url) : [];
  if (thumbs.length === 0) return null;
  const scored = [...thumbs].sort((a, b) => {
    const area = (t) => (t.width ?? 0) * (t.height ?? 0);
    if (area(a) !== area(b)) return area(b) - area(a);
    return (b.preference ?? 0) - (a.preference ?? 0);
  });
  return scored[0].url ?? null;
}

/** `20240131` → `2024-01-31`. Returns null for anything else. */
export function parseUploadDate(raw) {
  const value = raw.upload_date ?? raw.release_date ?? null;
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** Duration in seconds, falling back to parsing `duration_string` ("1:02:03"). */
export function parseDuration(raw) {
  if (typeof raw.duration === 'number' && Number.isFinite(raw.duration)) return raw.duration;
  const str = raw.duration_string;
  if (typeof str !== 'string' || !/^\d+(:\d{1,2})*$/.test(str)) return null;
  return str
    .split(':')
    .map(Number)
    .reduce((acc, part) => acc * 60 + part, 0);
}

/** 'video' | 'audio' | 'image' — lets clients pick a sensible player/embed. */
export function detectKind(raw, formats) {
  if (raw._type === 'playlist' || raw._type === 'multi_video') return 'playlist';
  const ext = typeof raw.ext === 'string' ? raw.ext.toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (formats.some((f) => f.hasVideo)) return 'video';
  if (formats.some((f) => f.hasAudio)) return 'audio';
  if (formats.length && formats.every((f) => IMAGE_EXTS.has(String(f.ext).toLowerCase()))) {
    return 'image';
  }
  if (typeof raw.duration === 'number' && raw.duration > 0) return 'video';
  return 'unknown';
}

/** live_status is newer than is_live; derive one from the other when missing. */
function liveFields(raw) {
  const liveStatus = raw.live_status ?? (raw.is_live ? 'is_live' : raw.was_live ? 'was_live' : null);
  return {
    isLive: Boolean(raw.is_live) || liveStatus === 'is_live',
    wasLive: Boolean(raw.was_live) || liveStatus === 'was_live',
    liveStatus: liveStatus ?? null,
  };
}

/** Normalize one media item (not a playlist). */
export function normalizeMediaItem(raw) {
  const formats = formatsFrom(raw);
  const { isLive, wasLive, liveStatus } = liveFields(raw);

  return {
    kind: detectKind(raw, formats),
    id: raw.id ?? null,
    title: raw.title ?? raw.fulltitle ?? raw.alt_title ?? raw.description?.slice(0, 80) ?? raw.id ?? null,
    description: raw.description ?? null,
    thumbnail: pickThumbnail(raw),
    durationSeconds: parseDuration(raw),
    // Extractors disagree on which of these they fill in — collapse to one.
    uploader: raw.uploader ?? raw.channel ?? raw.creator ?? raw.artist ?? raw.uploader_id ?? null,
    uploaderUrl: raw.uploader_url ?? raw.channel_url ?? null,
    webpageUrl: raw.webpage_url ?? raw.original_url ?? null,
    extractor: raw.extractor ?? raw.extractor_key ?? null,
    extractorKey: raw.extractor_key ?? null,
    uploadDate: parseUploadDate(raw),
    timestamp: nullIfUndef(raw.timestamp),
    viewCount: nullIfUndef(raw.view_count),
    likeCount: nullIfUndef(raw.like_count),
    ageLimit: nullIfUndef(raw.age_limit),
    availability: raw.availability ?? null,
    isLive,
    wasLive,
    liveStatus,
    hasVideo: formats.some((f) => f.hasVideo),
    hasAudio: formats.some((f) => f.hasAudio),
    subtitleLanguages: Object.keys(raw.subtitles ?? {}),
    automaticCaptionLanguages: Object.keys(raw.automatic_captions ?? {}),
    formats,
  };
}

/** Compact shape used for playlist/carousel entries. */
export function normalizePlaylistEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  const formats = formatsFrom(entry);
  return {
    index: index + 1, // 1-based: matches yt-dlp's --playlist-items numbering
    id: entry.id ?? null,
    title: entry.title ?? entry.id ?? null,
    url: entry.webpage_url ?? entry.url ?? entry.original_url ?? null,
    thumbnail: pickThumbnail(entry),
    durationSeconds: parseDuration(entry),
    uploader: entry.uploader ?? entry.channel ?? null,
    kind: detectKind(entry, formats),
  };
}

/**
 * Top-level normalizer. Handles both the single-media case and the playlist
 * wrapper that a lot of extractors return even for one post (Twitter threads
 * with several clips, Reddit galleries, TikTok photo carousels, Instagram
 * multi-item posts, and of course real playlists/channels).
 *
 * @param {object} raw            parsed `yt-dlp -J` output
 * @param {object} [opts]
 * @param {boolean} [opts.expandPlaylist] keep the playlist shape instead of
 *   collapsing to its first playable entry
 */
export function normalizeInfo(raw, { expandPlaylist = false } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('normalizeInfo: expected an object');
  }

  const isPlaylist = raw._type === 'playlist' || raw._type === 'multi_video';
  if (!isPlaylist) return { ...normalizeMediaItem(raw), isPlaylist: false };

  const entries = (Array.isArray(raw.entries) ? raw.entries : []).filter(Boolean);

  if (!expandPlaylist) {
    // One post containing several clips is far more common than a real
    // playlist here, so collapse to the first entry that actually has media
    // and tell the caller the rest exist.
    const playable = entries.find((e) => formatsFrom(e).length > 0) ?? entries[0];
    if (playable) {
      const item = normalizeMediaItem(playable);
      return {
        ...item,
        title: item.title ?? raw.title ?? null,
        isPlaylist: false,
        partOfPlaylist: {
          id: raw.id ?? null,
          title: raw.title ?? null,
          url: raw.webpage_url ?? null,
          itemCount: raw.playlist_count ?? entries.length,
          note:
            'This URL contains multiple items; showing the first. Call with playlist=true for all of them.',
        },
      };
    }
  }

  return {
    kind: 'playlist',
    isPlaylist: true,
    id: raw.id ?? null,
    title: raw.title ?? null,
    description: raw.description ?? null,
    thumbnail: pickThumbnail(raw),
    uploader: raw.uploader ?? raw.channel ?? null,
    webpageUrl: raw.webpage_url ?? raw.original_url ?? null,
    extractor: raw.extractor ?? raw.extractor_key ?? null,
    extractorKey: raw.extractor_key ?? null,
    itemCount: raw.playlist_count ?? entries.length,
    entries: entries.map(normalizePlaylistEntry).filter(Boolean),
    // Keep the key present so clients can always read `.formats`.
    formats: [],
  };
}

/**
 * Pull the playable URL(s) out of a `-J -f <selector>` dump.
 *
 * yt-dlp puts them in a different place depending on the selector:
 * `requested_formats` for merged video+audio, `requested_downloads` for a
 * single resolved download, and a bare top-level `url` for simple
 * extractors. Playlist wrappers nest all of that one level deeper.
 *
 * Returns per-stream objects including the HTTP headers the CDN expects —
 * lots of sites (Instagram, TikTok, Facebook, Bilibili) 403 a direct URL
 * that's fetched without the original Referer/User-Agent.
 */
export function extractStreams(raw) {
  const node =
    raw?._type === 'playlist' || raw?._type === 'multi_video'
      ? ((Array.isArray(raw.entries) ? raw.entries : []).find(
          (e) => e && (e.requested_formats || e.requested_downloads || e.url),
        ) ?? raw)
      : raw;

  const candidates =
    (Array.isArray(node?.requested_formats) && node.requested_formats.length
      ? node.requested_formats
      : null) ??
    (Array.isArray(node?.requested_downloads) && node.requested_downloads.length
      ? node.requested_downloads
      : null) ??
    (typeof node?.url === 'string' && node.url ? [node] : []);

  const streams = candidates
    .filter((f) => typeof f?.url === 'string' && f.url.length > 0)
    .map((f) => {
      const normalized = toMediaFormat(f);
      return {
        url: f.url,
        formatId: normalized.formatId,
        ext: normalized.ext,
        protocol: normalized.protocol,
        resolution: normalized.resolution,
        filesizeApprox: normalized.filesizeApprox,
        hasVideo: normalized.hasVideo,
        hasAudio: normalized.hasAudio,
        isManifest: normalized.isManifest,
        // Replay these when fetching the URL yourself, or the CDN may 403.
        headers: f.http_headers ?? node?.http_headers ?? null,
      };
    });

  return { node, streams };
}

/**
 * Many CDN URLs carry their own expiry (`?expire=`, `?Expires=`, `/exp/`).
 * Surfacing it lets callers cache sensibly instead of guessing.
 */
export function guessUrlExpiry(url) {
  try {
    const parsed = new URL(url);
    for (const key of ['expire', 'expires', 'Expires', 'oe', 'exp', 'x-amz-expires']) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const seconds = /^[0-9a-f]{8}$/i.test(value) && Number.isNaN(Number(value))
        ? parseInt(value, 16)
        : Number(value);
      if (!Number.isFinite(seconds)) continue;
      // Heuristic: plausible unix timestamp (2020..2100), not a duration.
      if (seconds > 1_577_836_800 && seconds < 4_102_444_800) {
        return new Date(seconds * 1000).toISOString();
      }
    }
  } catch {
    /* not a parseable URL — no expiry to report */
  }
  return null;
}
