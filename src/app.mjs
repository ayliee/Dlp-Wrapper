// © Author: aliyie
// https://discord.gg/aerox

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import router from './routes/index.mjs';
import { logger } from './lib/logger.mjs';
import { buildRateLimitStore } from './lib/rateLimitStore.mjs';
import { safeEqual } from './lib/security.mjs';
import { registry, metricsMiddleware } from './lib/metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Render (and most PaaS hosts) sit a reverse proxy in front of us. Without
// this, req.ip is always the proxy's IP, which breaks per-client rate
// limiting (everyone shares one bucket).
app.set('trust proxy', 1);

// One structured log line per request. Query strings are stripped so
// user-supplied URLs/params don't end up verbatim in logs.
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split('?')[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// CSP/COEP are meant for HTML pages with subresources — this is a JSON API.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ALLOWED_ORIGINS is a comma-separated allowlist for browser JS callers.
// Left unset, no browser can call this cross-origin — server-to-server
// callers (Discord bots, curl) are unaffected either way, since CORS is a
// browser-enforced concept.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  logger.warn(
    'ALLOWED_ORIGINS is not set — no browser origin can call this API. ' +
      'Discord bots and other server-side callers are unaffected.',
  );
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // non-browser caller
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(metricsMiddleware);

// General rate limit across the API, keyed by client IP. Uses a Redis store
// when REDIS_URL is configured (shared across instances, survives
// restarts); otherwise the default in-memory store, scoped to this process.
const generalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  limit: Number(process.env.RATE_LIMIT_MAX ?? 30),
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimitStore('dlpwrapper:rl:general:'),
  // Default is to block traffic if the store throws — which would turn a
  // transient Redis blip into a total outage (confirmed: killing Redis
  // mid-session made even /healthz return 500). Fail open instead: no rate
  // limiting during the outage beats no API at all.
  passOnStoreError: true,
  message: { error: 'Too many requests — please slow down' },
});
// Documentation page. Not rate-limited or auth-gated — it's static and public.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// Interactive test console. Same-origin with the API, so it works over a
// tunnel/deployed URL without touching ALLOWED_ORIGINS. The page itself is
// static — the API key is typed in by whoever opens it and only travels in
// the requests it makes, never baked into the HTML.
app.get(['/test', '/console'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Prometheus scrape endpoint. Optionally gated behind METRICS_KEY, the same
// pattern as API_KEY on /media/* — left unset, it's open (typical when
// scraping happens over a private network rather than the public internet).
app.get('/metrics', async (req, res) => {
  const metricsKey = process.env.METRICS_KEY;
  if (metricsKey) {
    const provided = req.header('x-metrics-key');
    if (!provided || !safeEqual(provided, metricsKey)) {
      res.status(401).send('Unauthorized');
      return;
    }
  }
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to collect metrics');
    if (!res.headersSent) res.status(500).send('Failed to collect metrics');
  }
});

app.use('/api', generalLimiter);

app.use('/api', router);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'not_found' });
});

// Final error guard — always JSON, never an HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'Unhandled error');
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
});

export default app;
