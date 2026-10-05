// © Author: aliyie
// https://discord.gg/aerox

// Turning yt-dlp's stderr into something a caller can act on.
//
// yt-dlp has 1,750+ extractors and every one of them fails in its own
// dialect ("Sign in to confirm you're not a bot", "Requested content is not
// available, rate-limit reached or login required", "NSFW tweet requires
// authentication", ...). Collapsing all of that into a flat 422 — which is
// what this wrapper used to do — makes it impossible for a client to tell
// "this URL is garbage" from "add cookies for this site" from "retry in a
// minute".
//
// Everything here is pure string work so it can be unit-tested without a
// yt-dlp binary (see tests/ytdlpErrors.test.mjs).

/** Lines yt-dlp prints that are noise to an API consumer. */
const NOISE_PATTERNS = [
  /please report this issue on\s+https:\/\/github\.com\/yt-dlp[^\n]*/gi,
  /\s*,?\s*filling out the appropriate issue template\.?/gi,
  /\s*Confirm you are on the latest version using\s+yt-dlp -U\.?/gi,
  /\s*Make sure you are using the latest version[^\n]*/gi,
  /\s*\(caused by [^)]*\)/gi,
  /\s*Use --(verbose|ignore-errors|list-formats)[^\n]*/gi,
  /\s*You might want to use a VPN or a proxy server[^\n]*/gi,
  /\s*Type:\s*yt-dlp [^\n]*/gi,
];

/**
 * Collapse multi-line yt-dlp stderr into a single readable sentence:
 * prefer the last real `ERROR:` line, drop boilerplate, cap the length.
 */
export function summarizeStderr(stderr, maxLength = 400) {
  if (!stderr) return '';

  const lines = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const errorLines = lines.filter((l) => /^ERROR:/i.test(l));
  // Fall back to warnings, then to whatever the last line was.
  const candidates = errorLines.length
    ? errorLines
    : lines.filter((l) => /^WARNING:/i.test(l)).slice(-1).concat(lines.slice(-1));

  let message = (candidates[candidates.length - 1] ?? '').replace(/^(ERROR|WARNING):\s*/i, '');

  for (const pattern of NOISE_PATTERNS) message = message.replace(pattern, '');

  // Extractor prefixes like "[youtube] abc123: " are useful context but noisy
  // when they stack; keep at most the first one.
  message = message.replace(/\s{2,}/g, ' ').replace(/\s+([.;,])/g, '$1').trim();
  message = message.replace(/[;,\s]+$/, '');

  if (message.length > maxLength) message = `${message.slice(0, maxLength - 1).trimEnd()}…`;
  return message;
}

// Order matters: the first rule whose `test` matches wins, so put the
// specific diagnoses above the generic catch-alls.
const RULES = [
  {
    code: 'unsupported_url',
    status: 400,
    test: /unsupported url|is not a valid url|no suitable extractor|unable to extract webpage url/i,
    message: 'No yt-dlp extractor supports this URL',
    hint: 'Check the URL, or see GET /api/media/extractors for the list of supported sites.',
  },
  {
    code: 'drm_protected',
    status: 451,
    test: /drm[- ]?protected|this video is drm|protected by drm|widevine|fairplay/i,
    message: 'This media is DRM-protected and cannot be downloaded',
    hint: null,
  },
  {
    code: 'geo_restricted',
    status: 451,
    test: /not available (in|from) your (country|location|region)|not made (this|the)? ?\w* ?available in your|geo[- ]?(restrict|block)|blocked it in your country|available only in|this video is not available in/i,
    message: 'This media is geo-restricted from the server’s location',
    hint: 'Set YTDLP_PROXY to a proxy in an allowed region, or try YTDLP_GEO_BYPASS_COUNTRY.',
  },
  {
    code: 'auth_required',
    status: 403,
    test: /sign in to confirm (you|your)|confirm you'?re not a bot|login required|log in to|requires? (a )?(login|authentication|an account)|private (video|account|profile|post)|members[- ]only|subscriber[- ]only|paid (members|subscription)|premium (content|subscription)|this content is only available|only available to (subscribers|members)|cookies are no longer valid|use --cookies|account (is )?required|nsfw tweet requires authentication|age[- ]restrict|confirm your age|sign in to view/i,
    message: 'The source site requires an authenticated session for this media',
    hint: 'Export cookies from a logged-in browser and set YTDLP_COOKIES_FILE (or drop a <domain>.txt into YTDLP_COOKIES_DIR).',
  },
  {
    code: 'rate_limited',
    status: 429,
    test: /http error 429|too many requests|rate[- ]?limit(ed)? (reached|exceeded)?|slow down/i,
    message: 'The source site is rate-limiting this server',
    hint: 'Retry later, or configure cookies/a proxy for this site.',
  },
  {
    code: 'not_found',
    status: 404,
    test: /http error 404|video unavailable|no longer available|has been removed|does not exist|not found|deleted|unable to find video|no video could be found|empty media response|this (tweet|post) is unavailable/i,
    message: 'The requested media does not exist or was removed',
    hint: null,
  },
  {
    code: 'forbidden_by_source',
    status: 403,
    test: /http error 403/i,
    message: 'The source site refused this request (HTTP 403)',
    hint: 'This usually means the site blocks cloud IPs — configure cookies, a proxy, or YTDLP_IMPERSONATE.',
  },
  {
    code: 'live_stream',
    status: 422,
    test: /live event will begin|is (currently )?live|live stream|premieres in|does not pass filter \(!is_live\)/i,
    message: 'This is a live stream',
    hint: 'Pass allowLive=true to download/record a live stream (it only stops at the download timeout).',
  },
  {
    code: 'format_unavailable',
    status: 422,
    test: /requested format (is )?not available|no video formats found|only images are available|no formats found/i,
    message: 'No stream matched the requested format selector',
    hint: 'Call /api/media/info to list available formats, or omit the format parameter.',
  },
  {
    code: 'file_too_large',
    status: 413,
    test: /larger than max[- ]?filesize|file is larger than/i,
    message: 'The media exceeds the configured maximum file size',
    hint: 'Raise YTDLP_MAX_FILESIZE, or pick a smaller format.',
  },
  {
    code: 'postprocessing_failed',
    status: 500,
    test: /ffmpeg (is )?not (installed|found)|ffprobe (is )?not (installed|found)|postprocessing:|conversion failed|remux|unable to (merge|recode|convert)/i,
    message: 'Post-processing failed (ffmpeg/ffprobe)',
    hint: 'Make sure ffmpeg and ffprobe are installed and on PATH (the bundled Dockerfile includes both).',
  },
  {
    code: 'timeout',
    status: 504,
    test: /timed out|timeout|read operation timed out/i,
    message: 'The extraction timed out',
    hint: 'Raise YTDLP_INFO_TIMEOUT_MS / YTDLP_DOWNLOAD_TIMEOUT_MS, or retry.',
  },
  {
    code: 'network_error',
    status: 502,
    test: /unable to download (webpage|json|api page|m3u8)|connection (reset|refused|aborted|closed)|temporary failure in name resolution|ssl|network is unreachable|getaddrinfo|tunnel connection failed|unable to connect/i,
    message: 'The server could not reach the source site',
    hint: 'Transient network/TLS issue, or the site is blocking this host. Retry, or route through YTDLP_PROXY.',
  },
  {
    code: 'unsupported_media',
    status: 422,
    test: /there'?s no video|no media found|unable to extract (video|media|player|url)/i,
    message: 'The page was reached but no downloadable media was found on it',
    hint: null,
  },
];

/**
 * Classify a failed yt-dlp run.
 *
 * @param {string} stderr  raw stderr from the process
 * @param {object} [opts]
 * @param {boolean} [opts.timedOut] true when we killed the process ourselves
 * @returns {{code: string, status: number, message: string, hint: string|null, detail: string}}
 */
export function classifyYtDlpFailure(stderr, { timedOut = false } = {}) {
  const detail = summarizeStderr(stderr);

  if (timedOut) {
    return {
      code: 'timeout',
      status: 504,
      message: 'The extraction timed out',
      hint: 'Raise YTDLP_INFO_TIMEOUT_MS / YTDLP_DOWNLOAD_TIMEOUT_MS, or retry.',
      detail,
    };
  }

  const haystack = `${stderr ?? ''}`;
  for (const rule of RULES) {
    if (rule.test.test(haystack)) {
      return { code: rule.code, status: rule.status, message: rule.message, hint: rule.hint, detail };
    }
  }

  return {
    code: 'extraction_failed',
    status: 422,
    message: detail || 'yt-dlp could not extract this URL',
    hint: null,
    detail,
  };
}

/** True when a format-selector retry with a looser selector is worth attempting. */
export function isFormatSelectionFailure(stderr) {
  return /requested format (is )?not available|no video formats found|no formats found/i.test(
    String(stderr ?? ''),
  );
}

/** True when the failure came from the merge/remux step rather than the download. */
export function isPostProcessingFailure(stderr) {
  return /postprocessing:|remux|unable to (merge|recode|convert)|conversion failed|does not support/i.test(
    String(stderr ?? ''),
  );
}
