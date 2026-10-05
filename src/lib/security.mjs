// © Author: aliyie
// https://discord.gg/aerox

// Security helpers: SSRF guard, constant-time API key check, concurrency semaphore.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Timing-safe string compare (hashes both sides first so length isn't leaked either). */
export function safeEqual(a, b) {
  const digestA = createHash('sha256').update(String(a)).digest();
  const digestB = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(digestA, digestB);
}

// ---------------- SSRF guard ------------------

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr4(ip, base, bits) {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Loopback, RFC1918 private space, link-local (incl. 169.254.169.254 cloud
// metadata), CGNAT, and reserved/broadcast ranges — none of these should
// ever be reachable on the caller's behalf.
const PRIVATE_V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPrivateV4(ip) {
  return PRIVATE_V4_RANGES.some(([base, bits]) => inCidr4(ip, base, bits));
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped IPv6
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

function isPrivateIp(ip) {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // unparseable — fail closed
}

export class SsrfError extends Error {}

// Self-hosters sometimes point this at media on their own LAN (a Jellyfin
// box, an internal HLS origin). That's a legitimate use, but it's also
// exactly what the SSRF guard exists to stop, so it's opt-in and loud.
const ALLOW_PRIVATE_URLS = process.env.ALLOW_PRIVATE_URLS === 'true';

/**
 * Clean up whatever the caller pasted in.
 *
 * Share sheets and chat clients hand out URLs wrapped in <>, trailing
 * punctuation, or with the scheme stripped ("youtu.be/xyz"). yt-dlp copes
 * with a bare host; `new URL()` doesn't, so these used to come back as a
 * flat "url must be a valid, absolute URL".
 */
export function normalizeInputUrl(raw) {
  let value = String(raw ?? '').trim();
  value = value.replace(/^<+|>+$/g, '').replace(/^["']|["']$/g, '').trim();
  if (!value) return '';
  // Scheme-relative ("//example.com/x") and schemeless ("example.com/x").
  if (value.startsWith('//')) value = `https:${value}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)) value = `https://${value}`;
  }
  return value;
}

/**
 * Reject anything but a public http(s) URL before it's handed to yt-dlp.
 * Note: this is defense-in-depth, not a guarantee — yt-dlp does its own DNS
 * resolution and follows redirects after this check runs, so a DNS record
 * that changes between our check and yt-dlp's request (DNS rebinding) isn't
 * caught here.
 */
export async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError('url must be a valid, absolute URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError('url must use http or https');
  }

  // IPv6 literals arrive bracketed ("[::1]") — strip for the IP checks.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new SsrfError('url host is not allowed');
  }

  if (ALLOW_PRIVATE_URLS) return;

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new SsrfError('url host is not allowed');
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new SsrfError('url resolves to a disallowed address');
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError('url host could not be resolved');
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new SsrfError('url resolves to a disallowed address');
  }
}

// ---------------- concurrency limiter ------------------

/**
 * Counting semaphore guarding concurrent yt-dlp/ffmpeg jobs.
 * - tryAcquire(): never waits — false means "reject now" (429).
 * - acquireQueued(): optionally waits for a free slot instead of rejecting
 *   immediately. Used when QUEUE_ENABLED=true (see media.mjs).
 */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  tryAcquire() {
    if (this.current >= this.max) return false;
    this.current += 1;
    return true;
  }

  /**
   * Waits up to `maxWaitMs` for a free slot. Resolves `true` once acquired,
   * or `false` if the wait times out or the queue is already at
   * `maxQueueLength` (fail fast rather than piling on more waiters).
   */
  acquireQueued(maxWaitMs, maxQueueLength) {
    if (this.tryAcquire()) return Promise.resolve(true);
    if (this.queue.length >= maxQueueLength) return Promise.resolve(false);

    return new Promise((resolve) => {
      const entry = {
        resolve: (acquired) => {
          clearTimeout(entry.timer);
          resolve(acquired);
        },
      };
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false);
      }, maxWaitMs);
      this.queue.push(entry);
    });
  }

  /** Releases a slot, handing it directly to the next queued waiter if any. */
  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      this.current += 1;
      next.resolve(true);
    }
  }

  queueLength() {
    return this.queue.length;
  }
}
