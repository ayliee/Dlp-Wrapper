// © Author: aliyie
// https://discord.gg/aerox

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyYtDlpFailure,
  isFormatSelectionFailure,
  isPostProcessingFailure,
  summarizeStderr,
} from '../src/lib/ytdlpErrors.mjs';

// Real-world stderr lines from a spread of extractors.
const CASES = [
  ["ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser", 'auth_required', 403],
  ['ERROR: [instagram] 1: Requested content is not available, rate-limit reached or login required', 'auth_required', 403],
  ['ERROR: [twitter] 1: NSFW tweet requires authentication', 'auth_required', 403],
  ['ERROR: [youtube] abc: Join this channel to get access to members-only content', 'auth_required', 403],
  ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users', 'auth_required', 403],
  ['ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader', 'not_found', 404],
  ['ERROR: [tiktok] 7: Unable to find video in feed', 'not_found', 404],
  ['ERROR: unable to download video data: HTTP Error 404: Not Found', 'not_found', 404],
  ['ERROR: [youtube] abc: The uploader has not made this video available in your country', 'geo_restricted', 451],
  ['ERROR: [generic] x: This video is DRM protected', 'drm_protected', 451],
  ['ERROR: Unsupported URL: https://example.com/not-a-site', 'unsupported_url', 400],
  ['ERROR: [soundcloud] 1: Unable to download JSON metadata: HTTP Error 429: Too Many Requests', 'rate_limited', 429],
  ['ERROR: [youtube] abc: Requested format is not available. Use --list-formats', 'format_unavailable', 422],
  ['ERROR: File is larger than max-filesize (600.00MiB > 500.00MiB)', 'file_too_large', 413],
  ['ERROR: You have requested merging of multiple formats but ffmpeg is not installed', 'postprocessing_failed', 500],
  ['ERROR: [twitch] x: This live event will begin in 2 hours', 'live_stream', 422],
  ['ERROR: [vimeo] 1: Unable to download webpage: TLS/SSL connection has been closed (EOF)', 'network_error', 502],
  ['ERROR: [facebook] 1: HTTP Error 403: Forbidden', 'forbidden_by_source', 403],
];

for (const [stderr, expectedCode, expectedStatus] of CASES) {
  test(`classifies: ${stderr.slice(0, 60)}…`, () => {
    const result = classifyYtDlpFailure(stderr);
    assert.equal(result.code, expectedCode);
    assert.equal(result.status, expectedStatus);
    assert.ok(result.message.length > 0);
  });
}

test('an unrecognised failure falls back to the cleaned-up message', () => {
  const result = classifyYtDlpFailure('ERROR: [weirdsite] 9: Something nobody has seen before');
  assert.equal(result.code, 'extraction_failed');
  assert.equal(result.status, 422);
  assert.match(result.message, /Something nobody has seen before/);
});

test('a timeout we caused ourselves wins over stderr content', () => {
  const result = classifyYtDlpFailure('ERROR: HTTP Error 404', { timedOut: true });
  assert.equal(result.code, 'timeout');
  assert.equal(result.status, 504);
});

test('boilerplate is stripped from the reported message', () => {
  const noisy =
    'WARNING: nsig extraction failed\n' +
    'ERROR: [vimeo] 76979871: Unable to download webpage: TLS/SSL connection has been closed (EOF) ' +
    "(caused by SSLError('EOF')); please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , " +
    'filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U';
  const summary = summarizeStderr(noisy);
  assert.ok(!summary.includes('github.com'), summary);
  assert.ok(!summary.includes('issue template'), summary);
  assert.match(summary, /Unable to download webpage/);
});

test('long stderr is truncated', () => {
  const summary = summarizeStderr(`ERROR: ${'x'.repeat(1000)}`, 100);
  assert.ok(summary.length <= 100);
});

test('retry predicates only fire for the right failures', () => {
  assert.ok(isFormatSelectionFailure('ERROR: Requested format is not available'));
  assert.ok(!isFormatSelectionFailure('ERROR: HTTP Error 404'));
  assert.ok(isPostProcessingFailure('ERROR: Postprocessing: Unable to remux'));
  assert.ok(!isPostProcessingFailure('ERROR: HTTP Error 404'));
});
