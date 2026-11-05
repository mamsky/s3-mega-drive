// Konfigurasi S3 gateway. Semua nilai dibaca dari environment (env.local didukung).
import '../env.js'
import { join } from 'node:path'
import { identities, isConfigured, loadIdentities } from './identities.js'

const ROOT = join(import.meta.dir, '..', '..')

function text(value, fallback = '') {
  const raw = String(value ?? '').trim()
  return raw || fallback
}

function flag(value, fallback = false) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return ['1', 'true', 'on', 'yes'].includes(raw)
}

function number(value, fallback) {
  const parsed = Number(text(value, String(fallback)))
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  port: number(process.env.S3_PORT, 3001),
  hostname: text(process.env.S3_HOSTNAME, '0.0.0.0'),
  region: text(process.env.S3_REGION, 'us-east-1'),
  // Referensi array yang sama dengan modul identities, supaya isinya ikut berubah
  // setelah loadIdentities() dipanggil saat startup.
  identities,
  forcePathStyle: flag(process.env.S3_FORCE_PATH_STYLE, true),
  strictPartSize: flag(process.env.S3_STRICT_PART_SIZE, false),
  maxClockSkew: number(process.env.S3_MAX_CLOCK_SKEW, 900),
  maxKeys: 1000,
  stateDir: join(ROOT, '.s3-state'),
  tmpDir: join(ROOT, '.s3-tmp'),
}

export { isConfigured, loadIdentities }
