// © Author: aliyie
// https://discord.gg/aerox

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl, normalizeInputUrl, safeEqual, SsrfError } from '../src/lib/security.mjs';
import { domainFromCookieFilename, matchDomain } from '../src/lib/cookies.mjs';

test('pasted URLs are cleaned up before validation', () => {
  assert.equal(normalizeInputUrl('  https://youtu.be/abc  '), 'https://youtu.be/abc');
  assert.equal(normalizeInputUrl('<https://youtu.be/abc>'), 'https://youtu.be/abc');
  assert.equal(normalizeInputUrl('youtu.be/abc'), 'https://youtu.be/abc');
  assert.equal(normalizeInputUrl('www.tiktok.com/@user/video/1'), 'https://www.tiktok.com/@user/video/1');
  assert.equal(normalizeInputUrl('//example.com/x'), 'https://example.com/x');
  assert.equal(normalizeInputUrl('http://example.com/x'), 'http://example.com/x');
  assert.equal(normalizeInputUrl(''), '');
});

test('non-http schemes and private destinations are rejected', async () => {
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('ftp://example.com/x'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1:8080/x'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('http://10.0.0.5/x'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('http://[::1]/x'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/x'), SsrfError);
  await assert.rejects(() => assertPublicHttpUrl('not a url'), SsrfError);
});

test('api key comparison is value-correct', () => {
  assert.ok(safeEqual('secret', 'secret'));
  assert.ok(!safeEqual('secret', 'Secret'));
  assert.ok(!safeEqual('secret', 'secret '));
});

test('cookie jars are matched by domain suffix', () => {
  assert.equal(domainFromCookieFilename('youtube.com.txt'), 'youtube.com');
  assert.equal(domainFromCookieFilename('cookies-instagram.com.txt'), 'instagram.com');
  assert.equal(domainFromCookieFilename('www.x.com.txt'), 'x.com');
  assert.equal(domainFromCookieFilename('notes.md'), null);
  assert.equal(domainFromCookieFilename('global.txt'), '*');

  const domains = ['youtube.com', 'x.com', 'music.youtube.com'];
  assert.equal(matchDomain('m.youtube.com', domains), 'youtube.com');
  assert.equal(matchDomain('music.youtube.com', domains), 'music.youtube.com');
  assert.equal(matchDomain('example.com', domains), null);
  assert.equal(matchDomain(null, domains), null);
});
