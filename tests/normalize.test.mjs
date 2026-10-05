// © Author: aliyie
// https://discord.gg/aerox

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKind,
  extractStreams,
  guessUrlExpiry,
  isStoryboardFormat,
  normalizeInfo,
  parseDuration,
  parseUploadDate,
  pickThumbnail,
  toMediaFormat,
} from '../src/lib/normalize.mjs';

test('storyboard formats are detected and dropped', () => {
  assert.ok(isStoryboardFormat({ ext: 'mhtml', protocol: 'mhtml' }));
  assert.ok(isStoryboardFormat({ format_id: 'sb2' }));
  assert.ok(!isStoryboardFormat({ format_id: '137', ext: 'mp4' }));

  const info = normalizeInfo({
    id: 'x',
    formats: [
      { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml' },
      { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a' },
    ],
  });
  assert.equal(info.formats.length, 1);
  assert.equal(info.formats[0].formatId, '18');
});

test('audio-only sources report audio kind and resolution', () => {
  const info = normalizeInfo({
    id: 'track',
    title: 'Song',
    extractor: 'soundcloud',
    duration_string: '3:42',
    formats: [{ format_id: 'hls', ext: 'mp3', vcodec: 'none', acodec: 'mp3', abr: 128, protocol: 'm3u8_native' }],
  });
  assert.equal(info.kind, 'audio');
  assert.equal(info.hasVideo, false);
  assert.equal(info.hasAudio, true);
  assert.equal(info.durationSeconds, 222);
  assert.equal(info.formats[0].resolution, 'audio only');
  assert.equal(info.formats[0].isManifest, true);
});

test('extractors with no formats array still return one format', () => {
  const info = normalizeInfo({
    id: 'sample',
    title: 'sample',
    ext: 'mp4',
    url: 'https://files.example.com/sample.mp4',
    protocol: 'https',
    extractor: 'generic',
  });
  assert.equal(info.formats.length, 1);
  assert.equal(info.formats[0].ext, 'mp4');
});

test('a post containing several clips collapses to the first with a playlist note', () => {
  const raw = {
    _type: 'playlist',
    id: 'status-1',
    title: 'thread',
    playlist_count: 2,
    entries: [
      { id: 'c1', title: 'Clip 1', formats: [{ format_id: 'a', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a' }] },
      { id: 'c2', title: 'Clip 2', formats: [{ format_id: 'b', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a' }] },
    ],
  };
  const collapsed = normalizeInfo(raw);
  assert.equal(collapsed.isPlaylist, false);
  assert.equal(collapsed.id, 'c1');
  assert.equal(collapsed.partOfPlaylist.itemCount, 2);

  const expanded = normalizeInfo(raw, { expandPlaylist: true });
  assert.equal(expanded.isPlaylist, true);
  assert.equal(expanded.entries.length, 2);
  assert.equal(expanded.entries[1].index, 2);
  assert.deepEqual(expanded.formats, []);
});

test('playlist entries without formats still normalize (flat-playlist output)', () => {
  const expanded = normalizeInfo(
    {
      _type: 'playlist',
      id: 'pl',
      title: 'Channel uploads',
      entries: [
        { _type: 'url', id: 'v1', title: 'One', url: 'https://example.com/v1', duration: 10 },
        { _type: 'url', id: 'v2', title: 'Two', url: 'https://example.com/v2' },
      ],
    },
    { expandPlaylist: true },
  );
  assert.equal(expanded.entries.length, 2);
  assert.equal(expanded.entries[0].url, 'https://example.com/v1');
});

test('uploader and thumbnail fall back across extractor-specific fields', () => {
  assert.equal(
    normalizeInfo({ id: 'x', channel: 'Chan', formats: [] }).uploader,
    'Chan',
  );
  assert.equal(normalizeInfo({ id: 'x', artist: 'Band', formats: [] }).uploader, 'Band');
  assert.equal(
    pickThumbnail({ thumbnails: [{ url: 'a', width: 10, height: 10 }, { url: 'b', width: 100, height: 100 }] }),
    'b',
  );
  assert.equal(pickThumbnail({}), null);
});

test('live status is derived from either field', () => {
  assert.equal(normalizeInfo({ id: 'x', is_live: true, formats: [] }).isLive, true);
  assert.equal(normalizeInfo({ id: 'x', live_status: 'is_live', formats: [] }).isLive, true);
  assert.equal(normalizeInfo({ id: 'x', live_status: 'was_live', formats: [] }).wasLive, true);
});

test('image posts are classified as images', () => {
  const formats = [toMediaFormat({ format_id: 'img', ext: 'jpg', vcodec: 'none', acodec: 'none' })];
  assert.equal(detectKind({ ext: 'jpg' }, formats), 'image');
  assert.equal(detectKind({}, formats), 'image');
});

test('upload date is converted to ISO-ish form', () => {
  assert.equal(parseUploadDate({ upload_date: '20240131' }), '2024-01-31');
  assert.equal(parseUploadDate({ upload_date: 'nope' }), null);
  assert.equal(parseDuration({ duration: 12.5 }), 12.5);
  assert.equal(parseDuration({ duration_string: '1:02:03' }), 3723);
});

test('streams are read from requested_formats, requested_downloads or url', () => {
  const merged = extractStreams({
    requested_formats: [
      { url: 'https://v', vcodec: 'avc1', acodec: 'none', http_headers: { Referer: 'r' } },
      { url: 'https://a', vcodec: 'none', acodec: 'mp4a' },
    ],
  });
  assert.equal(merged.streams.length, 2);
  assert.deepEqual(merged.streams[0].headers, { Referer: 'r' });

  const single = extractStreams({ requested_downloads: [{ url: 'https://one', ext: 'mp4' }] });
  assert.equal(single.streams.length, 1);

  const bare = extractStreams({ url: 'https://bare', ext: 'mp4' });
  assert.equal(bare.streams[0].url, 'https://bare');

  const nested = extractStreams({
    _type: 'playlist',
    entries: [{ title: 'inner', url: 'https://inner.mp4', ext: 'mp4' }],
  });
  assert.equal(nested.streams[0].url, 'https://inner.mp4');
  assert.equal(nested.node.title, 'inner');
});

test('CDN expiry timestamps are surfaced when present', () => {
  assert.equal(guessUrlExpiry('https://cdn.example.com/v.mp4?expire=4000000000'), '2096-10-02T07:06:40.000Z');
  assert.equal(guessUrlExpiry('https://cdn.example.com/v.mp4'), null);
  assert.equal(guessUrlExpiry('not a url'), null);
});

test('codecs are inferred from the container when an extractor omits them', () => {
  const video = toMediaFormat({ format_id: 'mp4', ext: 'mp4', protocol: 'http' });
  assert.equal(video.hasVideo, true);
  assert.equal(video.hasAudio, true);

  const audio = toMediaFormat({ format_id: 'mp3', ext: 'mp3' });
  assert.equal(audio.hasVideo, false);
  assert.equal(audio.hasAudio, true);

  // An explicit "none" is still authoritative.
  assert.equal(toMediaFormat({ ext: 'mp4', vcodec: 'none', acodec: 'mp4a' }).hasVideo, false);
  assert.equal(detectKind({ ext: 'mp4' }, [video]), 'video');
});
