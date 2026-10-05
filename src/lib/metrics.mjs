// © Author: aliyie
// https://discord.gg/aerox

// Prometheus metrics via prom-client, exposed at GET /metrics (app.mjs).
// Optionally gated behind METRICS_KEY the same way API_KEY gates /media/*.
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'dlpwrapper_' });

export const httpRequestsTotal = new client.Counter({
  name: 'dlpwrapper_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'dlpwrapper_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const activeJobs = new client.Gauge({
  name: 'dlpwrapper_active_jobs',
  help: 'Currently running yt-dlp jobs',
  labelNames: ['kind'], // 'info' | 'download'
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'dlpwrapper_cache_events_total',
  help: 'Metadata cache hits and misses',
  labelNames: ['namespace', 'result'], // result: 'hit' | 'miss'
  registers: [registry],
});

export const extractionResults = new client.Counter({
  name: 'dlpwrapper_extraction_results_total',
  help: 'Outcome of each yt-dlp extraction, by classified result code',
  // 'ok' | 'auth_required' | 'geo_restricted' | 'not_found' | ... (see lib/ytdlpErrors.mjs)
  labelNames: ['result'],
  registers: [registry],
});

export const quotaRejections = new client.Counter({
  name: 'dlpwrapper_quota_rejected_total',
  help: 'Requests rejected for exceeding a per-IP quota',
  labelNames: ['route'],
  registers: [registry],
});

/** Records request count + duration per route/status once the response finishes. */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, seconds);
  });
  next();
}
