// Metadata kecil per objek (Content-Type, Cache-Control, custom metadata).
// MEGA tidak menyimpan metadata ini, jadi disimpan di tabel object_meta.
// Kalau DATABASE_URL tidak diisi, jatuh ke file sidecar di disk (mode lama).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, dbEnabled, parseJson } from '../db.js'
import { config } from './config.js'

const DIR = join(config.stateDir, 'meta')

// Root identitas ikut di-hash supaya bucket/key yang sama di identitas berbeda tidak bertabrakan.
function fileFor(identity, bucket, key) {
  const hash = createHash('sha1').update(`${identity.root}/${bucket}/${key}`).digest('hex')
  return join(DIR, `${hash}.json`)
}

function normalize(row) {
  if (!row) return null
  return {
    identity: row.identity,
    bucket: row.bucket,
    key: row.key,
    contentType: row.content_type ?? null,
    cacheControl: row.cache_control ?? null,
    metadata: parseJson(row.metadata),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }
}

export async function readObjectMeta(identity, bucket, key) {
  if (dbEnabled) {
    const rows = await db()`
      select identity, bucket, "key", content_type, cache_control, metadata, updated_at
      from object_meta
      where identity = ${identity.name} and bucket = ${bucket} and "key" = ${key}
    `
    return normalize(rows[0])
  }

  const file = fileFor(identity, bucket, key)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export async function writeObjectMeta(identity, bucket, key, value) {
  const contentType = value?.contentType ?? null
  const cacheControl = value?.cacheControl ?? null
  const metadata = value?.metadata ?? {}

  if (dbEnabled) {
    await db()`
      insert into object_meta (identity, bucket, "key", content_type, cache_control, metadata, updated_at)
      values (${identity.name}, ${bucket}, ${key}, ${contentType}, ${cacheControl},
              ${JSON.stringify(metadata)}::jsonb, now())
      on conflict (identity, bucket, "key") do update set
        content_type = excluded.content_type,
        cache_control = excluded.cache_control,
        metadata = excluded.metadata,
        updated_at = now()
    `
    return
  }

  mkdirSync(DIR, { recursive: true })
  writeFileSync(
    fileFor(identity, bucket, key),
    JSON.stringify(
      {
        identity: identity.name,
        bucket,
        key,
        contentType,
        cacheControl,
        metadata,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  )
}

export async function deleteObjectMeta(identity, bucket, key) {
  if (dbEnabled) {
    await db()`
      delete from object_meta
      where identity = ${identity.name} and bucket = ${bucket} and "key" = ${key}
    `
    return
  }

  const file = fileFor(identity, bucket, key)
  if (existsSync(file)) rmSync(file, { force: true })
}

/** Hapus semua metadata milik satu bucket (dipakai saat bucket dihapus permanen). */
export async function deleteBucketMeta(identity, bucket) {
  if (!dbEnabled) return
  await db()`delete from object_meta where identity = ${identity.name} and bucket = ${bucket}`
}
