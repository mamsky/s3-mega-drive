// Identitas S3: tiap access key punya ruang sendiri di MEGA (folder "s3/<nama>").
//
// Sumber data (urut prioritas):
//   1. tabel "identities" di PostgreSQL (kalau DATABASE_URL diisi)
//   2. file s3-identities.local.json (mode lama, dipakai untuk mengisi tabel pertama kali)
//   3. env S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (satu identitas "default")
//
// Password disimpan sebagai hash (Bun.password). Secret key harus bisa dibaca server
// untuk verifikasi tanda tangan SigV4, jadi disimpan apa adanya — lindungi akses ke DB.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, dbEnabled } from '../db.js'

const ROOT = join(import.meta.dir, '..', '..')
const FILE = process.env.S3_IDENTITIES_FILE
  ? join(ROOT, process.env.S3_IDENTITIES_FILE)
  : join(ROOT, 's3-identities.local.json')
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function text(value) {
  return String(value ?? '').trim()
}

/** Baca + validasi file JSON lama. Return [] kalau file tidak ada. */
function readFile() {
  if (!existsSync(FILE)) return []

  let raw
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'))
  } catch (err) {
    throw new Error(`s3-identities.local.json bukan JSON valid: ${err.message}`)
  }

  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.identities) ? raw.identities : null
  if (!list) throw new Error('s3-identities.local.json harus berupa array, atau objek dengan kunci "identities"')

  const seenKeys = new Set()
  const seenNames = new Set()

  return list.map((item, index) => {
    const label = `entri #${index + 1}`

    const name = text(item?.name).toLowerCase()
    if (!NAME_RE.test(name)) {
      throw new Error(
        `${label}: "name" wajib diisi, 1-64 karakter, hanya huruf kecil/angka/"_"/"-", diawali huruf atau angka`
      )
    }
    if (seenNames.has(name)) throw new Error(`${label}: nama identitas "${name}" dipakai lebih dari sekali`)
    seenNames.add(name)

    const accessKeyId = text(item?.accessKeyId)
    if (!accessKeyId) throw new Error(`${label} ("${name}"): "accessKeyId" wajib diisi`)
    if (seenKeys.has(accessKeyId)) throw new Error(`${label}: accessKeyId "${accessKeyId}" dipakai lebih dari sekali`)
    seenKeys.add(accessKeyId)

    const secretAccessKey = text(item?.secretAccessKey)
    if (!secretAccessKey) throw new Error(`${label} ("${name}"): "secretAccessKey" wajib diisi`)

    return {
      name,
      accessKeyId,
      secretAccessKey,
      password: text(item?.password),
      root: `s3/${name}`,
    }
  })
}

function readEnv() {
  const accessKeyId = text(process.env.S3_ACCESS_KEY_ID)
  const secretAccessKey = text(process.env.S3_SECRET_ACCESS_KEY)
  if (!accessKeyId || !secretAccessKey) return []
  return [
    {
      name: 'default',
      accessKeyId,
      secretAccessKey,
      password: text(process.env.S3_UI_PASSWORD),
      root: 's3/default',
    },
  ]
}

/** Hash password untuk disimpan; string kosong dibiarkan kosong (tidak bisa login UI). */
async function hashPassword(password) {
  return password ? Bun.password.hash(password) : null
}

/** Isi tabel identities dari file JSON kalau tabel masih kosong. */
async function seedFromFile(sql) {
  const rows = await sql`select count(*)::int as total from identities`
  if (rows[0].total > 0) return 0

  const seed = readFile().length > 0 ? readFile() : readEnv()
  if (seed.length === 0) return 0

  for (const item of seed) {
    await sql`
      insert into identities (name, access_key_id, secret_access_key, password, root)
      values (${item.name}, ${item.accessKeyId}, ${item.secretAccessKey},
              ${await hashPassword(item.password)}, ${item.root})
      on conflict (name) do nothing
    `
  }
  return seed.length
}

async function loadFromDb(sql) {
  const rows = await sql`
    select name, access_key_id, secret_access_key, password, root
    from identities order by name
  `
  return rows.map((row) => ({
    name: row.name,
    accessKeyId: row.access_key_id,
    secretAccessKey: row.secret_access_key,
    // password di DB sudah hash; di memori kita simpan hash-nya dan verifikasi lewat Bun.password
    passwordHash: row.password ?? null,
    root: row.root,
  }))
}

/**
 * Identitas aktif. Diisi oleh loadIdentities(); sebelum itu kosong.
 * Dibuat mutable supaya modul lain bisa memakai referensi yang sama.
 */
export const identities = []

export let isConfigured = false

let loaded = false

/**
 * Muat identitas sekali saat startup. Kalau DATABASE_URL diisi, tabel jadi sumber
 * kebenaran (dan diisi otomatis dari file/env kalau masih kosong).
 */
export async function loadIdentities() {
  if (loaded) return identities
  loaded = true

  if (dbEnabled) {
    const sql = db()
    const seeded = await seedFromFile(sql)
    if (seeded > 0) console.log(`[db] ${seeded} identitas disalin dari file/env ke tabel identities`)
    identities.push(...(await loadFromDb(sql)))
  } else {
    const fromFile = readFile()
    const list = fromFile.length > 0 ? fromFile : readEnv()
    for (const item of list) {
      identities.push({ ...item, passwordHash: await hashPassword(item.password) })
    }
  }

  isConfigured = identities.length > 0
  return identities
}

/** Cari identitas berdasarkan access key (dipakai verifikasi SigV4). */
export function findByIdentityKey(accessKeyId) {
  return identities.find((item) => item.accessKeyId === accessKeyId) ?? null
}

export function findByName(name) {
  const target = text(name).toLowerCase()
  return identities.find((item) => item.name === target) ?? null
}

/** Tambah identitas baru (password langsung di-hash). */
export async function createIdentity({ name, accessKeyId, secretAccessKey, password }) {
  const cleanName = text(name).toLowerCase()
  if (!NAME_RE.test(cleanName)) {
    throw new Error('Nama identitas 1-64 karakter, huruf kecil/angka/"_"/"-", diawali huruf atau angka')
  }
  if (!text(accessKeyId)) throw new Error('accessKeyId wajib diisi')
  if (!text(secretAccessKey)) throw new Error('secretAccessKey wajib diisi')
  if (findByName(cleanName)) throw new Error(`Identitas "${cleanName}" sudah ada`)
  if (findByIdentityKey(text(accessKeyId))) throw new Error(`accessKeyId "${accessKeyId}" sudah dipakai`)

  const passwordHash = await hashPassword(text(password))

  if (dbEnabled) {
    await db()`
      insert into identities (name, access_key_id, secret_access_key, password, root)
      values (${cleanName}, ${text(accessKeyId)}, ${text(secretAccessKey)}, ${passwordHash}, ${`s3/${cleanName}`})
    `
  }

  const identity = {
    name: cleanName,
    accessKeyId: text(accessKeyId),
    secretAccessKey: text(secretAccessKey),
    passwordHash,
    root: `s3/${cleanName}`,
  }
  identities.push(identity)
  isConfigured = true
  return identity
}

/** Hapus identitas (hanya dari DB; data MEGA tidak disentuh). */
export async function removeIdentity(name) {
  const identity = findByName(name)
  if (!identity) throw new Error(`Identitas "${name}" tidak ditemukan`)

  if (dbEnabled) await db()`delete from identities where name = ${identity.name}`

  const index = identities.indexOf(identity)
  if (index >= 0) identities.splice(index, 1)
  isConfigured = identities.length > 0
  return identity
}
