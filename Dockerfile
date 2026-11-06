# syntax=docker/dockerfile:1.7
ARG BUN_VERSION=1.4.2-alpine

# ---------- stage 1: dependensi produksi ----------
# devDependencies (@aws-sdk/*) hanya dipakai test, jadi tidak ikut ke image.
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
# Pembersihan di stage ini (bukan di runtime) supaya hasilnya ikut terlipat ke
# satu layer COPY --from=deps. Kalau dihapus di stage runtime, byte-nya tetap
# tersimpan di layer sebelumnya dan image tidak mengecil sama sekali.
RUN bun install --production --frozen-lockfile --no-progress \
 && find node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name '*.ts' \) -delete \
 && find node_modules -type d \( -name 'test' -o -name 'tests' -o -name '__tests__' -o -name '.github' -o -name 'docs' -o -name 'example' -o -name 'examples' \) -prune -exec rm -rf {} + \
 && rm -rf node_modules/.cache node_modules/.bin \
 && rm -rf node_modules/@img/sharp-linux-x64 node_modules/@img/sharp-libvips-linux-x64 \
 && du -sh node_modules

# ---------- stage 2: runtime ----------
FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    S3_PORT=3001 \
    S3_HOSTNAME=0.0.0.0 \
    S3_UI_PORT=3002 \
    S3_UI_HOSTNAME=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN mkdir -p /app/.s3-state /app/.s3-tmp \
 && chown -R bun:bun /app/.s3-state /app/.s3-tmp

LABEL org.opencontainers.image.title="s3-mega-drive" \
      org.opencontainers.image.description="REST API + S3 gateway di atas akun MEGA" \
      org.opencontainers.image.source="https://github.com/mamsky/s3-mega-drive"

USER bun
EXPOSE 3000 3001 3002

CMD ["bun", "run", "src/s3/server.js"]
