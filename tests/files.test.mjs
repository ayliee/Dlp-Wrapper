// © Author: aliyie
// https://discord.gg/aerox

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDownloadName,
  contentDispositionFor,
  contentTypeFor,
  pickOutputFile,
  sanitizeFilename,
} from '../src/lib/files.mjs';

test('content type follows the real container, not the requested one', () => {
  assert.equal(contentTypeFor('clip.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('clip.webm'), 'video/webm');
  assert.equal(contentTypeFor('clip.mkv'), 'video/x-matroska');
  assert.equal(contentTypeFor('song.mp3'), 'audio/mpeg');
  assert.equal(contentTypeFor('song.opus'), 'audio/opus');
  assert.equal(contentTypeFor('photo.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('mystery.xyz'), 'application/octet-stream');
});

test('the largest non-sidecar file is chosen as the output', () => {
  const picked = pickOutputFile([
    { name: 'clip.f140.m4a', size: 2000 },
    { name: 'clip.mp4.part', size: 999999 },
    { name: 'clip.info.json', size: 50_000 },
    { name: 'clip.en.vtt', size: 10 },
    { name: 'clip.mp4', size: 50_000 },
  ]);
  assert.equal(picked.name, 'clip.mp4');
  assert.equal(pickOutputFile([]), null);
  assert.equal(pickOutputFile([{ name: 'only.part', size: 10 }]), null);
  assert.equal(pickOutputFile([{ name: 'empty.mp4', size: 0 }]), null);
});

test('unicode titles produce a valid, decodable Content-Disposition', () => {
  const header = contentDispositionFor('Пример видео 🎬.mp4');
  // Header values must stay ASCII-only, or Node rejects them outright.
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7e]*$/.test(header), header);
  assert.match(header, /filename="/);
  assert.match(header, /filename\*=UTF-8''/);
  const encoded = header.split("filename*=UTF-8''")[1];
  assert.equal(decodeURIComponent(encoded), 'Пример видео 🎬.mp4');
});

test('quotes, slashes and control characters cannot break out of the header', () => {
  const header = contentDispositionFor('evil"; rm -rf /\r\nX-Injected: 1.mp4');
  assert.ok(!header.includes('\r'));
  assert.ok(!header.includes('\n'));
  assert.equal(header.split('filename="')[1].split('"')[0].includes('"'), false);
  assert.equal(sanitizeFilename(''), 'download');
  assert.equal(sanitizeFilename('a/b\\c:d'), 'a_b_c_d');
});

test('download name keeps the real extension', () => {
  assert.equal(buildDownloadName('Some Title [abc123].webm'), 'Some Title [abc123].webm');
  assert.equal(buildDownloadName('.mp4'), 'download.mp4');
  assert.ok(buildDownloadName(`${'x'.repeat(300)}.mp4`).length < 140);
});

test('a title identical to the id is not repeated in the filename', () => {
  assert.equal(buildDownloadName('sample [sample].mp3'), 'sample.mp3');
  assert.equal(buildDownloadName('Real Title [abc123].mp3'), 'Real Title [abc123].mp3');
});
