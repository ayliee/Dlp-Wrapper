<!--
  © Author: aliyie
  https://discord.gg/aerox
-->

<div align="center">

# Dlp Wrapper

**Made by Ayle**

[![Join Discord](https://img.shields.io/badge/Discord-Join%20AeroX%20Development-5865F2?logo=discord&logoColor=white)](https://discord.gg/aerox)
[![Online](https://img.shields.io/discord/1414217749038891102?label=online&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/aerox)

</div>

## Tech stack

| Layer | Used for |
|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Core extraction logic — every metadata/URL/download operation shells out to it |
| ffmpeg | Muxing video+audio and audio extraction (MP3) |
| Node.js 20+ / Express | HTTP API |
| Redis (optional) | Distributed rate limiting, shared metadata cache, per-IP quotas |
| Prometheus (`prom-client`) | Metrics at `/metrics` |
| Docker | Packaging — bundles yt-dlp + ffmpeg with the app |
| Render | Recommended host (Blueprint included) |

---

## What this is

A self-hosted REST API wrapping yt-dlp. Fetch metadata, resolve direct CDN URLs, or download video/audio from 1,750+ sites — drop it into a web app or a Discord bot over plain HTTP. You host it yourself; it is not a public service.

Every endpoint returns the same response shape whatever the source is: a video site, an audio host (SoundCloud, Bandcamp, podcasts), a live stream, an image post, a thread with several clips, or a bare `.mp4` on someone's web server.

Once deployed, visiting the base URL in a browser serves a full built-in documentation page (`src/public/docs.html`) with every endpoint, parameter, example, and environment variable.

## Features

- Metadata, direct-URL resolution, and download endpoints (`mp4`, `webm`, `mp3`, `m4a`, `opus`, `audio`, or `auto` for the untouched source container)
- **Normalized across every extractor** — one response shape for video, audio-only, image and live sources, with codecs inferred when a site doesn't report them and storyboard formats filtered out
- **Multi-item posts handled** — X/Twitter threads, Reddit galleries, TikTok carousels and Instagram multi-posts collapse to the first clip, or list in full with `playlist=true`
- **Fallback format selection** — defaults degrade muxed → merge → audio-only → video-only, and an unsatisfiable selector or failed remux is retried instead of erroring
- **Classified errors** — login wall (403), geo-block (451), dead link (404), live stream (422), rate limit (429)… each with a machine-readable `code` and an actionable `hint`, instead of one generic 422
- **Per-site cookie jars** (`YTDLP_COOKIES_DIR`), TLS impersonation (`YTDLP_IMPERSONATE`) and proxy support for the sites that fight back
- `GET /api/capabilities` reports yt-dlp/ffmpeg/cookie state; `GET /api/media/extractors` lists every supported site
- Correct `Content-Type` and RFC 6266 filenames (non-ASCII titles included) on downloads
- SSRF-guarded URL input, constant-time API key check (`x-api-key` or `Authorization: Bearer`), closed-by-default CORS
- Rate limiting and concurrency caps, with optional request queuing instead of immediate rejection
- Optional Redis backing for the rate limiter, metadata cache, and per-IP quotas — falls back to in-memory if unset
- Per-IP daily quotas, separate from short-window rate limits
- Prometheus metrics at `/metrics`, including per-outcome extraction counters

## Quick start (local)

```bash
git clone https://github.com/ayliee/Dlp-Wrapper.git
cd Dlp-Wrapper
npm install
cp .env.example .env    # set API_KEY at minimum before exposing this anywhere
npm start
# → listening on http://localhost:8080
```

### Try it in a browser

With the server running, open **<http://localhost:8080/test>** — a built-in test console for every endpoint: paste a URL, inspect metadata and the format table, resolve CDN URLs (with a player preview), and download in any supported `ext` with a progress bar. It's served from the same origin as the API, so CORS never gets in the way, and errors are shown with their `code`/`hint`.

### Share it over a Cloudflare tunnel

To reach that console (or the API) from your phone, a teammate, or a Discord bot — without opening a port or buying a domain:

```bash
npm start            # terminal 1
npm run tunnel       # terminal 2 → https://<random>.trycloudflare.com
```

The script checks the API is up, starts a Cloudflare Quick Tunnel against it, and prints the public URL plus direct links to `/test`, `/api/healthz` and `/api/capabilities`. It needs [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on `PATH` (`brew install cloudflared`, `winget install Cloudflare.cloudflared`, or `npm i -g cloudflared`) and prints install instructions if it's missing. No Cloudflare account is required for a quick tunnel.

```bash
npm run tunnel 3000                      # non-default port
TUNNEL_HOSTNAME=dlp.example.com npm run tunnel   # named tunnel on your own domain
```

A quick tunnel URL is public to anyone holding the link and changes on every restart — **set `API_KEY` before sharing one**.

Requires Node.js 20+, plus `yt-dlp` and `ffmpeg`/`ffprobe` on `PATH` (all bundled if you run it via Docker instead — see below). Check what the running instance found with:

```bash
curl localhost:8080/api/capabilities
# { "ytdlpVersion": "...", "ffmpeg": true, "ffprobe": true, "cookieDomains": [], ... }
```

Run the test suite (no network or yt-dlp binary needed — it stubs the binary with fixtures covering each source type):

```bash
npm test
```

---

## Deploy — Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ayliee/Dlp-Wrapper)

Clicking that takes you straight to Render with this repo pre-filled — it reads `render.yaml` and provisions the service, generating `API_KEY` for you.

1. Click the button above (or **New → Blueprint** on [render.com](https://render.com) and connect this repo yourself)
2. Set `ALLOWED_ORIGINS` if a web app will call the API directly from browser JS
3. Deploy — your base URL is `https://<service-name>.onrender.com`

`render.yaml` must sit at the root of the repo Render reads from for the button/Blueprint to find it — if you've nested this project under a subfolder in your own repo, move `render.yaml` (and the rest of this project) up to the root first.

Optional: uncomment the `keyvalue` block in `render.yaml` to add a managed Redis-compatible instance for the shared cache/rate-limit/quota features.

## Deploy — VPS

No Docker required if you'd rather run it directly:

```bash
# 1. System dependencies
sudo apt update && sudo apt install -y python3 python3-pip ffmpeg curl

# 2. Node.js 22.x — Ubuntu's default apt repo only ships Node 18, which is
# below this project's Node >=20 requirement, so pull from NodeSource instead.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. yt-dlp
pip3 install --break-system-packages -U yt-dlp

# 4. This project
git clone https://github.com/ayliee/Dlp-Wrapper.git
cd Dlp-Wrapper
npm install
cp .env.example .env   # edit: set API_KEY, ALLOWED_ORIGINS, etc.

# 5. Run it under a process manager so it survives reboots/crashes
npm install -g pm2
pm2 start src/index.mjs --name dlp-wrapper
pm2 save && pm2 startup
```

Put a reverse proxy (nginx, Caddy) in front of it for TLS. A minimal nginx config:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Prefer Docker instead? The included `Dockerfile` bundles yt-dlp + ffmpeg so you don't manage those separately:

```bash
docker build -t dlp-wrapper .
docker run -d --restart unless-stopped -p 8080:8080 \
  -e PORT=8080 -e API_KEY=your-secret-key \
  --name dlp-wrapper dlp-wrapper
```

---

## Project structure

```
dlp-wrapper/
├── src/
│   ├── index.mjs              # Entry point — startup checks, Redis connect, graceful shutdown
│   ├── app.mjs                 # Express app: middleware, rate limiting, /metrics, docs route
│   ├── lib/
│   │   ├── ytdlp.mjs            # yt-dlp CLI wrapper — args, retries, info/direct-url/download
│   │   ├── normalize.mjs        # extractor-specific JSON → one stable response shape
│   │   ├── ytdlpErrors.mjs      # yt-dlp stderr → HTTP status + code + hint
│   │   ├── files.mjs            # output-file picking, MIME types, RFC 6266 filenames
│   │   ├── security.mjs         # SSRF guard, URL normalization, key check, semaphore
│   │   ├── cache.mjs            # Metadata cache (Redis or in-memory TTL)
│   │   ├── quota.mjs            # Per-IP quota counters (Redis or in-memory)
│   │   ├── redis.mjs            # Shared optional Redis client
│   │   ├── rateLimitStore.mjs   # Redis-or-memory store for express-rate-limit
│   │   ├── metrics.mjs          # Prometheus metrics (prom-client)
│   │   ├── cookies.mjs          # Per-site cookie jars: sync, refresh, expiry warnings
│   │   └── logger.mjs           # Pino logger
│   ├── routes/
│   │   ├── index.mjs            # Route mounting
│   │   ├── health.mjs           # GET /healthz, /capabilities
│   │   └── media.mjs            # GET /media/info, /media/direct-url, /media/download, /media/extractors
│   └── public/
│       ├── docs.html            # Built-in documentation page, served at GET /
│       └── test.html            # Interactive test console, served at GET /test
├── examples/
│   ├── discord-bot/             # Minimal discord.js integration
│   └── web-app/                 # Minimal browser demo
├── tests/                       # node:test suite (stubs yt-dlp — no network needed)
├── scripts/
│   ├── smoke-test.mjs           # End-to-end check against a real yt-dlp + live sites
│   └── tunnel.mjs               # `npm run tunnel` — public URL via Cloudflare Quick Tunnel
├── Dockerfile
├── render.yaml                  # Render Blueprint
└── .env.example
```

## API reference

The full reference — every endpoint, parameter, response shape, and environment variable — lives in the built-in docs page, served at your deployed base URL (`/`), or open `src/public/docs.html` directly.

Endpoints at a glance:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Built-in documentation page |
| GET | `/test` | Interactive test console for every endpoint |
| GET | `/api/healthz` | Liveness check |
| GET | `/api/capabilities` | yt-dlp version, ffmpeg/ffprobe, impersonation, loaded cookie jars |
| GET | `/api/media/info` | Metadata: title, thumbnail, duration, live status, formats |
| GET | `/api/media/direct-url` | Resolve the underlying CDN URL(s) + the headers they need, no bytes proxied |
| GET | `/api/media/download` | Download as mp4/webm/mp3/m4a/opus/audio/auto, streamed back |
| GET | `/api/media/extractors` | List/search the sites this yt-dlp build supports |
| GET | `/metrics` | Prometheus metrics |

### Making a stubborn site work

| Symptom (`code` in the error body) | Fix |
|---|---|
| `auth_required` — login wall, age gate, "confirm you're not a bot" | Export cookies from a logged-in browser → `YTDLP_COOKIES_FILE`, or per-site jars in `YTDLP_COOKIES_DIR` (`youtube.com.txt`, `instagram.com.txt`, …) |
| `forbidden_by_source` — blanket 403 from a cloud IP | `YTDLP_IMPERSONATE=chrome` (Docker image ships `yt-dlp[curl-cffi]`), or a proxy |
| `geo_restricted` | `YTDLP_PROXY`, or `YTDLP_GEO_BYPASS_COUNTRY` |
| `postprocessing_failed` | ffmpeg/ffprobe missing — check `/api/capabilities` |
| `live_stream` | Retry with `allowLive=true` |
| `format_unavailable` | Omit `format`, or pick one from `/api/media/info` |
| Site needs specific extractor options | `YTDLP_EXTRACTOR_ARGS="youtube:player_client=android,web"` |

## License

MIT.
