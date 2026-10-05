# © Author: aliyie
# https://discord.gg/aerox

# Multi-stage build: install deps with a full Node image, then ship a slim
# runtime. We keep yt-dlp + ffmpeg in a venv so they're easy to bump without
# touching system packages.
FROM node:22-bookworm-slim AS base

# yt-dlp (Python) + ffmpeg + Python tooling. ca-certificates is needed for
# HTTPS to sites that use Let's Encrypt.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dedicated venv so pip never writes to system Python and we can pin yt-dlp
# independently. yt-dlp updates daily — re-running the build always pulls
# the latest.
# The [curl-cffi] extra adds TLS/JA3 impersonation, which is what gets past
# sites that 403 anything that doesn't look like a real browser (TikTok,
# several Cloudflare-fronted hosts). Enable it at runtime with
# YTDLP_IMPERSONATE=chrome.
RUN python3 -m venv /opt/ytdlp-venv \
    && /opt/ytdlp-venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default,curl-cffi]"
ENV YTDLP_BIN=/opt/ytdlp-venv/bin/yt-dlp

WORKDIR /app

# Install only production deps first so the layer caches when only source
# changes (most common rebuild case during dev).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Then copy the source. ESM with .mjs means no build step.
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Healthcheck requires wget; useful but optional in many containers, so we
# use the API's own /api/healthz. Node's image ships wget via busybox.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/api/healthz || exit 1

CMD ["node", "--enable-source-maps", "src/index.mjs"]
