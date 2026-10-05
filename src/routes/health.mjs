// © Author: aliyie
// https://discord.gg/aerox

import { Router } from 'express';
import { getCapabilities } from '../lib/ytdlp.mjs';

const router = Router();

/** GET /api/healthz — liveness probe, suitable as a container healthcheck. */
router.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /api/capabilities — what this particular install can actually do.
 *
 * Half of "site X doesn't work" reports come down to a missing piece of the
 * environment rather than the extractor: no ffmpeg (so nothing that needs
 * merging or MP3 extraction works), no cookies (so every login-walled site
 * 403s), no curl-cffi (so sites that fingerprint TLS block the request).
 * This makes that visible without reading the logs.
 */
router.get('/capabilities', (_req, res) => {
  const caps = getCapabilities();
  res.json({
    ytdlpVersion: caps.ytdlpVersion,
    ffmpeg: caps.ffmpeg,
    ffprobe: caps.ffprobe,
    impersonation: caps.impersonation,
    impersonateTarget: caps.impersonateTarget,
    cookieDomains: caps.cookieDomains,
    notes: [
      ...(caps.ffmpeg ? [] : ['ffmpeg is missing — merged video+audio and mp3/m4a conversion will fail']),
      ...(caps.cookieDomains.length
        ? []
        : ['no cookie jars configured — login-walled sites (YouTube from cloud IPs, Instagram, X) will fail']),
    ],
  });
});

export default router;
