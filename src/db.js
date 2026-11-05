// Koneksi PostgreSQL + skema. Semua state kecil (identitas, metadata objek, state
// multipart) disimpan di sini; file aslinya tetap di MEGA.
//
// DATABASE_URL boleh dua format:
//   jdbc:postgresql://host:port/db?user=..&password=..   (gaya Java)
//   postgres://user:pass@host:port/db                    (gaya native)
import { SQL } from 'bun'

/**
 * Ubah URL gaya JDBC menjadi URL native yang dimengerti klien Postgres.
 * Kalau sudah native, dikembalikan apa adanya.
 */
export function toNativeUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''

  const jdbc = value.match(/^jdbc:([a-z0-9]+):\/\/([^/?#]+)(\/[^?#]*)?(?:\?(.*))?$/i)
  if (!jdbc) return value

  const [, sub, authority, path = '', query = ''] = jdbc
  const params = new URLSearchParams(query)
  const user = params.get('user') ?? ''
  const password = params.get('password') ?? ''
  params.delete('user')
  params.delete('password')

  const scheme = sub === 'postgresql' ? 'postgres' : sub
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : ''
  const rest = params.toString()
  return `${scheme}://${auth}${authority}${path}${rest ? `?${rest}` : ''}`
}

const URL_NATIVE = toNativeUrl(process.env.DATABASE_URL)

/** True kalau DATABASE_URL diisi — tanpa ini aplikasi tetap jalan mode file. */
export const dbEnabled = Boolean(URL_NATIVE)

/**
 * Kolom jsonb dikembalikan driver sebagai string JSON, bukan objek.
 * Helper ini menormalkan keduanya jadi objek biasa.
 */
export function parseJson(value) {
  if (!value) return {}
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

let client = null

/** Klien SQL tunggal (dibuat saat pertama dipakai). */
export function db() {
  if (!dbEnabled) throw new Error('DATABASE_URL belum diisi')
  if (!client) client = new SQL(URL_NATIVE)
  return client
}

const SCHEMA = [
  `create table if not exists identities (
     name text primary key,
     access_key_id text not null unique,
     secret_access_key text not null,
     password text,
     root text not null,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists object_meta (
     identity text not null,
     bucket text not null,
     "key" text not null,
     content_type text,
     cache_control text,
     metadata jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now(),
     primary key (identity, bucket, "key")
   )`,
  `create table if not exists multipart_uploads (
     upload_id text primary key,
     identity text not null,
     bucket text not null,
     "key" text not null,
     content_type text,
     cache_control text,
     metadata jsonb not null default '{}'::jsonb,
     initiated timestamptz not null default now()
   )`,
  `create index if not exists multipart_uploads_scope_idx
     on multipart_uploads (identity, bucket, "key")`,
  `create table if not exists multipart_parts (
     upload_id text not null references multipart_uploads(upload_id) on delete cascade,
     part_number int not null,
     etag text not null,
     size bigint not null,
     updated_at timestamptz not null default now(),
     primary key (upload_id, part_number)
   )`,
]

/** Buat tabel kalau belum ada. Aman dipanggil berkali-kali. */
export async function initSchema() {
  if (!dbEnabled) return false
  const sql = db()
  for (const statement of SCHEMA) await sql.unsafe(statement)
  return true
}

/** Tutup koneksi (dipakai saat server berhenti). */
export async function closeDb() {
  if (!client) return
  await client.close()
  client = null
}
