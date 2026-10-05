#!/usr/bin/env node
// © Author: aliyie
// https://discord.gg/aerox

// A stand-in for the yt-dlp binary used by the integration tests.
//
// It replays canned `-J` output shaped like what real extractors return —
// YouTube (split video/audio + storyboards), SoundCloud (audio only),
// X/Twitter (playlist wrapper around one post), Twitch (live HLS), a photo
// carousel, a bare file via the generic extractor — plus the characteristic
// failure modes (login wall, geo block, bot check). That lets the whole
// request path be tested on every kind of source without network access.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(name);
}
function value(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

const url = argv[argv.length - 1];

if (flag('--version')) {
  process.stdout.write('2099.01.01\n');
  process.exit(0);
}
if (flag('--list-extractors')) {
  process.stdout.write(['youtube', 'youtube:tab', 'soundcloud', 'TikTok', 'twitter', 'twitch:stream'].join('\n'));
  process.exit(0);
}
if (flag('--list-impersonate-targets')) {
  process.stdout.write('chrome-110:windows-10\n');
  process.exit(0);
}

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

if (url.includes('authwall')) {
  fail('ERROR: [instagram] 123: Requested content is not available, rate-limit reached or login required');
}
if (url.includes('geoblock')) {
  fail('ERROR: [youtube] abc: The uploader has not made this video available in your country');
}
if (url.includes('botcheck')) {
  fail("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies for the authentication.");
}
if (url.includes('gone')) {
  fail('ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader');
}
if (url.includes('nosite')) {
  fail('ERROR: Unsupported URL: https://example.invalid/whatever');
}
if (url.includes('noformat') && value('-f') && !value('-f').startsWith('b/')) {
  fail('ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats');
}

const httpHeaders = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/' };

const videoFormat = {
  format_id: '137',
  ext: 'mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  vcodec: 'avc1.640028',
  acodec: 'none',
  protocol: 'https',
  filesize: 10_000_000,
  url: 'https://cdn.example.com/video.mp4?expire=4000000000',
  http_headers: httpHeaders,
};
const audioFormat = {
  format_id: '140',
  ext: 'm4a',
  vcodec: 'none',
  acodec: 'mp4a.40.2',
  abr: 128,
  asr: 44100,
  protocol: 'https',
  filesize_approx: 1_000_000,
  url: 'https://cdn.example.com/audio.m4a?expire=4000000000',
  http_headers: httpHeaders,
};
const storyboard = { format_id: 'sb0', ext: 'mhtml', protocol: 'mhtml', format_note: 'storyboard', url: 'https://cdn.example.com/sb.mhtml' };

function youtubeLike() {
  return {
    id: 'dQw4w9WgXcQ',
    _type: 'video',
    title: 'Пример видео 🎬',
    description: 'desc',
    thumbnails: [
      { url: 'https://i.example.com/small.jpg', width: 120, height: 90 },
      { url: 'https://i.example.com/big.jpg', width: 1280, height: 720 },
    ],
    duration: 212,
    channel: 'Example Channel',
    channel_url: 'https://example.com/c',
    webpage_url: url,
    extractor: 'youtube',
    extractor_key: 'Youtube',
    upload_date: '20091025',
    view_count: 42,
    live_status: 'not_live',
    subtitles: { en: [{ ext: 'vtt' }] },
    formats: [storyboard, audioFormat, videoFormat],
  };
}

function soundcloudLike() {
  return {
    id: 'track-1',
    title: 'Flickermood',
    duration_string: '3:42',
    uploader: 'Forss',
    webpage_url: url,
    extractor: 'soundcloud',
    formats: [
      {
        format_id: 'hls_mp3',
        ext: 'mp3',
        vcodec: 'none',
        acodec: 'mp3',
        abr: 128,
        protocol: 'm3u8_native',
        url: 'https://cdn.soundcloud.example/stream.m3u8',
      },
    ],
  };
}

function twitterLike() {
  const entry = (n) => ({
    id: `clip-${n}`,
    title: `Clip ${n}`,
    duration: 12 + n,
    webpage_url: `${url}#${n}`,
    extractor: 'twitter',
    formats: [{ ...videoFormat, format_id: `http-${n}`, url: `https://video.twimg.example/${n}.mp4` }],
    requested_formats: undefined,
  });
  return {
    _type: 'playlist',
    id: 'status-1',
    title: 'A thread with two clips',
    webpage_url: url,
    extractor: 'twitter',
    playlist_count: 2,
    entries: [entry(1), entry(2)],
  };
}

function genericLike() {
  return {
    id: 'sample',
    title: 'sample',
    ext: 'mp4',
    url: 'https://files.example.com/sample.mp4',
    protocol: 'https',
    extractor: 'generic',
    webpage_url: url,
  };
}

function liveLike() {
  return {
    id: 'live-1',
    title: 'Live right now',
    is_live: true,
    live_status: 'is_live',
    extractor: 'twitch:stream',
    webpage_url: url,
    formats: [
      {
        format_id: '1080p60',
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: 'avc1',
        acodec: 'mp4a.40.2',
        url: 'https://live.example.com/playlist.m3u8',
        http_headers: httpHeaders,
      },
    ],
  };
}

function photoLike() {
  return {
    _type: 'playlist',
    id: 'photo-post',
    title: 'Photo carousel',
    extractor: 'TikTok',
    webpage_url: url,
    entries: [
      {
        id: 'img-1',
        title: 'Photo 1',
        ext: 'jpg',
        url: 'https://img.example.com/1.jpg',
        extractor: 'TikTok',
        formats: [{ format_id: 'img', ext: 'jpg', vcodec: 'none', acodec: 'none', url: 'https://img.example.com/1.jpg' }],
      },
    ],
  };
}

function pickFixture() {
  if (url.includes('soundcloud')) return soundcloudLike();
  if (url.includes('twitter') || url.includes('x.com')) return twitterLike();
  if (url.includes('generic')) return genericLike();
  if (url.includes('live')) return liveLike();
  if (url.includes('photo')) return photoLike();
  return youtubeLike();
}

const info = pickFixture();

// ---- JSON dump mode -------------------------------------------------------
if (flag('-J') || flag('--dump-single-json')) {
  const selector = value('-f');
  if (selector) {
    const attach = (node) => {
      if (node._type === 'playlist') {
        node.entries = node.entries.map(attach);
        return node;
      }
      const formats = node.formats ?? [];
      const videos = formats.filter((f) => f.vcodec && f.vcodec !== 'none');
      const audios = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
      if (selector.includes('+') && videos.length && audios.length && !selector.startsWith('b/')) {
        node.requested_formats = [videos[0], audios[0]];
      } else {
        const chosen = formats.find((f) => f.acodec && f.acodec !== 'none') ?? formats[0];
        if (chosen) node.requested_downloads = [chosen];
        else if (node.url) node.requested_downloads = [{ url: node.url, ext: node.ext, protocol: node.protocol }];
      }
      return node;
    };
    attach(info);
  }
  process.stdout.write(JSON.stringify(info));
  process.exit(0);
}

// ---- download mode --------------------------------------------------------
const template = value('-o');
if (!template) fail('ERROR: no output template');

const matchFilter = value('--match-filter');
if (matchFilter === '!is_live' && (info.is_live || url.includes('live'))) {
  process.stderr.write('[download] Skipping Live right now: does not pass filter (!is_live), test\n');
  process.exit(0);
}

const audioFormatArg = value('--audio-format');
const mergeFormat = value('--merge-output-format');
let ext = 'mp4';
if (flag('-x')) ext = audioFormatArg ?? 'm4a';
else if (url.includes('photo')) ext = 'jpg';
else if (url.includes('soundcloud')) ext = 'mp3';
else if (mergeFormat) ext = mergeFormat;

if (url.includes('remuxfail') && value('--remux-video')) {
  fail('ERROR: Postprocessing: Unable to remux: the container does not support the codec');
}

const dir = path.dirname(template);
await mkdir(dir, { recursive: true });
const title = (info.title ?? 'media').replace(/[/\\]/g, '_');
const name = `${title} [${info.id ?? 'id'}].${ext}`;
// A realistic temp dir also contains leftovers the response must not pick.
await writeFile(path.join(dir, `${name}.part`), Buffer.alloc(99));
await writeFile(path.join(dir, `${title}.info.json`), JSON.stringify(info));
await writeFile(path.join(dir, name), Buffer.alloc(4096, 7));
process.stdout.write(`[download] Destination: ${path.join(dir, name)}\n`);
process.exit(0);
