// Multipart upload: part ditampung di disk lokal lalu digabung sekali upload ke MEGA.
// MEGA tidak punya konsep multipart. State upload disimpan di tabel
// multipart_uploads + multipart_parts; berkas part tetap di disk karena ukurannya besar.
// Kalau DATABASE_URL tidak diisi, state jatuh ke .s3-state/uploads/<id>/state.json.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, dbEnabled, parseJson } from '../db.js'
import { config } from './config.js'
import { S3Error } from './errors.js'

const DIR = join(config.stateDir, 'uploads')

function uploadDir(uploadId) {
  return join(DIR, uploadId)
}

function stateFile(uploadId) {
  return join(uploadDir(uploadId), 'state.json')
}

function partFile(uploadId, partNumber) {
  return join(uploadDir(uploadId), `part-${String(partNumber).padStart(5, '0')}`)
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value
}

/** Susun objek state dari baris DB + daftar part. */
function shape(row, parts) {
  return {
    uploadId: row.upload_id,
    identity: row.identity,
    bucket: row.bucket,
    key: row.key,
    contentType: row.content_type ?? null,
    cacheControl: row.cache_control ?? null,
    metadata: parseJson(row.metadata),
    initiated: toIso(row.initiated),
    parts: Object.fromEntries(
      parts.map((part) => [
        String(part.part_number),
        {
          partNumber: part.part_number,
          etag: part.etag,
          size: Number(part.size),
          lastModified: toIso(part.updated_at),
        },
      ])
    ),
  }
}

async function readFromDb(uploadId) {
  const sql = db()
  const rows = await sql`
    select upload_id, identity, bucket, "key", content_type, cache_control, metadata, initiated
    from multipart_uploads where upload_id = ${uploadId}
  `
  if (rows.length === 0) throw new S3Error('NoSuchUpload', `Upload tidak ditemukan: ${uploadId}`)
  const parts = await sql`
    select part_number, etag, size, updated_at from multipart_parts
    where upload_id = ${uploadId} order by part_number
  `
  return shape(rows[0], parts)
}

function readFromFile(uploadId) {
  const file = stateFile(uploadId)
  if (!existsSync(file)) throw new S3Error('NoSuchUpload', `Upload tidak ditemukan: ${uploadId}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new S3Error('NoSuchUpload', `State upload rusak: ${uploadId}`)
  }
}

async function readState(uploadId) {
  return dbEnabled ? readFromDb(uploadId) : readFromFile(uploadId)
}

function writeStateFile(state) {
  mkdirSync(uploadDir(state.uploadId), { recursive: true })
  writeFileSync(stateFile(state.uploadId), JSON.stringify(state, null, 2))
}

export async function createUpload({ identity, bucket, key, contentType, cacheControl, metadata }) {
  const uploadId = randomUUID().replace(/-/g, '')
  const state = {
    uploadId,
    identity: identity.name,
    bucket,
    key,
    contentType: contentType ?? null,
    cacheControl: cacheControl ?? null,
    metadata: metadata ?? {},
    initiated: new Date().toISOString(),
    parts: {},
  }

  if (dbEnabled) {
    await db()`
      insert into multipart_uploads (upload_id, identity, bucket, "key", content_type, cache_control, metadata)
      values (${uploadId}, ${identity.name}, ${bucket}, ${key}, ${state.contentType},
              ${state.cacheControl}, ${JSON.stringify(state.metadata)}::jsonb)
    `
  } else {
    writeStateFile(state)
  }

  // Folder part tetap dibuat supaya upload part pertama tidak perlu mkdir lagi.
  mkdirSync(uploadDir(uploadId), { recursive: true })
  return state
}

/** Upload milik identitas lain diperlakukan seolah tidak ada, supaya tidak bisa diintip/dibatalkan. */
export async function requireUpload(uploadId, identity) {
  const state = await readState(uploadId)
  if (state.identity !== identity.name) throw new S3Error('NoSuchUpload', `Upload tidak ditemukan: ${uploadId}`)
  return state
}

export async function listUploads(identity, bucket, prefix = '') {
  if (dbEnabled) {
    const rows = await db()`
      select upload_id, identity, bucket, "key", content_type, cache_control, metadata, initiated
      from multipart_uploads
      where identity = ${identity.name} and bucket = ${bucket} and "key" like ${`${prefix}%`}
      order by initiated
    `
    return rows.map((row) => shape(row, []))
  }

  if (!existsSync(DIR)) return []
  const uploads = []
  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const state = readFromFile(entry.name)
      if (state.identity === identity.name && state.bucket === bucket && state.key.startsWith(prefix)) {
        uploads.push(state)
      }
    } catch {
      // state rusak diabaikan
    }
  }
  return uploads.sort((a, b) => (a.initiated < b.initiated ? -1 : 1))
}

export async function savePart(uploadId, partNumber, buffer) {
  const number = Number(partNumber)
  if (!Number.isInteger(number) || number < 1 || number > 10000) {
    throw new S3Error('InvalidArgument', 'PartNumber harus 1-10000')
  }

  await readState(uploadId)
  mkdirSync(uploadDir(uploadId), { recursive: true })
  writeFileSync(partFile(uploadId, number), buffer)

  const etag = createHash('md5').update(buffer).digest('hex')
  const part = { partNumber: number, etag, size: buffer.length, lastModified: new Date().toISOString() }

  if (dbEnabled) {
    await db()`
      insert into multipart_parts (upload_id, part_number, etag, size, updated_at)
      values (${uploadId}, ${number}, ${etag}, ${buffer.length}, now())
      on conflict (upload_id, part_number) do update set
        etag = excluded.etag, size = excluded.size, updated_at = now()
    `
  } else {
    const state = readFromFile(uploadId)
    state.parts[String(number)] = part
    writeStateFile(state)
  }

  return part
}

export async function listParts(uploadId) {
  if (dbEnabled) {
    const rows = await db()`
      select part_number, etag, size, updated_at from multipart_parts
      where upload_id = ${uploadId} order by part_number
    `
    return rows.map((row) => ({
      partNumber: row.part_number,
      etag: row.etag,
      size: Number(row.size),
      lastModified: toIso(row.updated_at),
    }))
  }

  const state = readFromFile(uploadId)
  return Object.values(state.parts).sort((a, b) => a.partNumber - b.partNumber)
}

/** Gabungkan part sesuai urutan yang diminta klien, hasilnya satu Buffer. */
export async function assembleParts(uploadId, requested) {
  const state = await readState(uploadId)
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new S3Error('MalformedXML', 'CompleteMultipartUpload butuh minimal satu Part')
  }

  let previous = 0
  const chunks = []
  for (const item of requested) {
    const number = Number(item.partNumber)
    if (!Number.isInteger(number) || number < 1) {
      throw new S3Error('InvalidPart', `PartNumber tidak valid: ${item.partNumber}`)
    }
    if (number <= previous) {
      throw new S3Error('InvalidPartOrder', 'Part harus diurutkan naik berdasarkan PartNumber')
    }
    previous = number

    const stored = state.parts[String(number)]
    if (!stored) throw new S3Error('InvalidPart', `Part ${number} belum diupload`)
    if (item.etag && item.etag.replace(/"/g, '') !== stored.etag) {
      throw new S3Error('InvalidPart', `ETag part ${number} tidak cocok`)
    }
    const file = partFile(uploadId, number)
    if (!existsSync(file)) throw new S3Error('InvalidPart', `Berkas part ${number} hilang`)
    chunks.push(readFileSync(file))
  }

  // Aturan S3: semua part kecuali terakhir minimal 5 MB.
  if (config.strictPartSize) {
    for (const item of requested.slice(0, -1)) {
      const stored = state.parts[String(item.partNumber)]
      if (stored && stored.size < 5 * 1024 * 1024) {
        throw new S3Error('EntityTooSmall', `Part ${item.partNumber} kurang dari 5 MB`)
      }
    }
  }

  return { state, buffer: Buffer.concat(chunks) }
}

export async function removeUpload(uploadId) {
  if (dbEnabled) {
    // multipart_parts ikut terhapus lewat on delete cascade.
    await db()`delete from multipart_uploads where upload_id = ${uploadId}`
  }
  const dir = uploadDir(uploadId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** Bersihkan upload yang tidak pernah diselesaikan (default 24 jam). */
export async function sweepStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs)

  if (dbEnabled) {
    const rows = await db()`
      select upload_id from multipart_uploads where initiated < ${cutoff}
    `
    for (const row of rows) await removeUpload(row.upload_id)
    return rows.length
  }

  if (!existsSync(DIR)) return 0
  let removed = 0
  for (const entry of readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const state = readFromFile(entry.name)
      const age = Date.now() - new Date(state.initiated).getTime()
      if (age > maxAgeMs) {
        await removeUpload(entry.name)
        removed += 1
      }
    } catch {
      // state rusak: hapus saja
      rmSync(join(DIR, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}
