// Client MEGA (megajs) sebagai singleton + helper operasi file/folder.
import './env.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Storage } from 'megajs'
import { contentTypeFor } from './mime.js'

const CONFIG_PATH = join(import.meta.dir, '..', 'config.local.json')

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Nilai contoh (placeholder) di config.local.json tidak dianggap kredensial asli. */
function cleanCredential(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  if (/^(ISI_|email-kamu@|password-mega|password-kamu)/i.test(text)) return undefined
  return text
}

/** Kredensial: config.local.json sebagai dasar, environment variable menimpa. */
function loadCredentials() {
  const creds = {}

  if (existsSync(CONFIG_PATH)) {
    let raw
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch (err) {
      throw new Error(`config.local.json tidak bisa dibaca sebagai JSON: ${err.message}`)
    }
    const email = cleanCredential(raw.email)
    const password = cleanCredential(raw.password)
    const secondFactorCode = cleanCredential(raw.secondFactorCode)
    if (email) creds.email = email
    if (password) creds.password = password
    if (secondFactorCode) creds.secondFactorCode = secondFactorCode
  }

  const email = cleanCredential(process.env.MEGA_EMAIL)
  const password = cleanCredential(process.env.MEGA_PASSWORD)
  const secondFactorCode = cleanCredential(process.env.MEGA_2FA)
  if (email) creds.email = email
  if (password) creds.password = password
  if (secondFactorCode) creds.secondFactorCode = secondFactorCode

  if (!creds.email || !creds.password) {
    throw new Error(
      'Kredensial MEGA belum diisi. Set environment variable MEGA_EMAIL dan MEGA_PASSWORD, ' +
        `atau buat file ${CONFIG_PATH} berisi {"email":"...","password":"..."}`
    )
  }
  return creds
}

let storagePromise = null

// megajs baru membersihkan tree lokal saat event 'sc' dari server tiba (asinkron).
// Node yang sudah kita hapus ditandai di sini supaya langsung tidak terlihat.
const deletedNodes = new WeakSet()

function isVisible(node) {
  return !deletedNodes.has(node)
}

/** Anak-anak node yang belum dihapus (tree megajs baru bersih setelah event 'sc'). */
export function visibleChildren(node) {
  return (node?.children ?? []).filter(isVisible)
}

/** Login sekali, dipakai ulang oleh semua request. */
export function getStorage() {
  if (!storagePromise) {
    storagePromise = (async () => {
      const creds = loadCredentials()
      const storage = await new Storage({ ...creds, keepalive: true, autoload: true }).ready
      console.log(`[mega] login sukses sebagai ${storage.options?.email ?? creds.email}`)
      return storage
    })()
    // Kalau login gagal, jangan cache kegagalannya supaya bisa dicoba lagi.
    storagePromise.catch(() => {
      storagePromise = null
    })
  }
  return storagePromise
}

export async function closeStorage() {
  if (!storagePromise) return
  try {
    const storage = await storagePromise
    await storage.close()
    console.log('[mega] sesi ditutup')
  } catch {
    // diabaikan saat shutdown
  }
}

/** "a/b/c.txt" -> ["a","b","c.txt"], menolak "." dan ".." */
export function splitPath(input) {
  const parts = String(input ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new HttpError(400, `Segmen path tidak diizinkan: "${part}"`)
    }
  }
  return parts
}

export function validateName(raw, label = 'Nama') {
  const name = String(raw ?? '').trim()
  if (!name) throw new HttpError(400, `${label} wajib diisi`)
  if (name.includes('/')) throw new HttpError(400, `${label} tidak boleh mengandung "/"`)
  if (name === '.' || name === '..') throw new HttpError(400, `${label} tidak diizinkan: "${name}"`)
  return name
}

function pathOf(node) {
  const parts = []
  let cursor = node
  while (cursor && cursor.parent) {
    parts.unshift(cursor.name)
    cursor = cursor.parent
  }
  return parts.join('/')
}

export function meta(node) {
  return {
    name: node.name,
    path: pathOf(node),
    nodeId: node.nodeId ?? null,
    directory: !!node.directory,
    size: node.size ?? 0,
    mime: node.directory ? null : contentTypeFor(node.name),
    createdAt: node.createdAt ? new Date(node.createdAt).toISOString() : null,
  }
}

/** Cari node berdasarkan path. Path kosong = root. Return null kalau tidak ada. */
export function findNode(storage, path) {
  const parts = splitPath(path)
  let node = storage.root
  for (const part of parts) {
    if (!node.directory) return null
    const next = (node.children ?? []).find((child) => child.name === part && isVisible(child))
    if (!next) return null
    node = next
  }
  return node
}

/** Buat folder (dan parent-nya) kalau belum ada. Path kosong = root. */
export async function ensureFolder(storage, path) {
  const parts = splitPath(path)
  let node = storage.root
  for (const part of parts) {
    if (!node.directory) throw new HttpError(409, `"${node.name}" bukan folder`)
    let next = (node.children ?? []).find((child) => child.name === part && isVisible(child))
    if (!next) next = await node.mkdir(part)
    node = next
  }
  return node
}

/** Isi sebuah folder. Path kosong = root. */
export function listFolder(storage, path) {
  const parts = splitPath(path)
  const node = parts.length === 0 ? storage.root : findNode(storage, path)
  if (!node) throw new HttpError(404, `Folder tidak ditemukan: "${path}"`)
  if (!node.directory) throw new HttpError(400, `"${path}" adalah file, bukan folder`)

  const entries = (node.children ?? []).filter(isVisible).map(meta)
  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { path: pathOf(node), entries }
}

/**
 * Upload file ke path tujuan.
 * mode 'create'  -> gagal (409) kalau sudah ada.
 * mode 'replace' -> upload dulu, baru hapus node lama (tidak pernah hapus dulu).
 */
export async function putFile(storage, destPath, { stream, size, mode = 'create' }) {
  const parts = splitPath(destPath)
  if (parts.length === 0) throw new HttpError(400, 'Path tujuan wajib diisi')

  const name = parts[parts.length - 1]
  const folder = await ensureFolder(storage, parts.slice(0, -1).join('/'))
  const existing = findNode(storage, destPath)

  if (existing?.directory) throw new HttpError(409, `"${destPath}" adalah folder`)
  if (existing && mode !== 'replace') {
    throw new HttpError(409, `File sudah ada: "${destPath}". Pakai PUT untuk replace, atau tambahkan ?overwrite=1`)
  }

  const uploaded = await folder.upload({ name, size }, stream).complete

  let replaced = null
  let warning = null
  if (existing) {
    deletedNodes.add(existing)
    try {
      await existing.delete(true)
      replaced = existing.nodeId
    } catch (err) {
      deletedNodes.delete(existing)
      warning = `Upload berhasil tapi file lama gagal dihapus: ${err.message}`
    }
  }
  return { file: meta(uploaded), replaced, warning }
}

/** Hapus file/folder. permanent=false -> pindah ke Rubbish Bin. */
export async function deleteAtPath(storage, path, permanent = false) {
  const node = findNode(storage, path)
  if (!node) throw new HttpError(404, `Tidak ditemukan: "${path}"`)
  const info = meta(node)
  deletedNodes.add(node)
  try {
    await node.delete(!!permanent)
  } catch (err) {
    deletedNodes.delete(node)
    throw err
  }
  return { ...info, permanent: !!permanent }
}

export async function renameAtPath(storage, path, newName, overwrite = false) {
  const node = findNode(storage, path)
  if (!node) throw new HttpError(404, `Tidak ditemukan: "${path}"`)
  if (node === storage.root) throw new HttpError(400, 'Root tidak bisa diganti nama')

  const name = validateName(newName, 'Nama baru')
  const oldPath = splitPath(path).join('/')
  if (node.name === name) {
    return { renamed: meta(node), renamedFrom: oldPath, overwritten: null }
  }

  const clash = (node.parent?.children ?? []).find(
    (child) => child !== node && child.name === name && isVisible(child)
  )
  if (clash) {
    if (!overwrite) {
      throw new HttpError(409, `"${name}" sudah ada di folder yang sama. Pakai ?overwrite=1 untuk menimpanya`)
    }
    if (clash.directory || node.directory) {
      throw new HttpError(409, `"${name}" adalah folder — rename dengan timpa hanya berlaku untuk file`)
    }
    deletedNodes.add(clash)
    try {
      await clash.delete(true)
    } catch (err) {
      deletedNodes.delete(clash)
      throw err
    }
  }

  await node.rename(name)
  return { renamed: meta(node), renamedFrom: oldPath, overwritten: clash?.nodeId ?? null }
}

/** Buka stream download sebagai web ReadableStream, mendukung byte range. */
export function openStream(storage, path, range) {
  const node = findNode(storage, path)
  if (!node) throw new HttpError(404, `File tidak ditemukan: "${path}"`)
  if (node.directory) throw new HttpError(400, `"${path}" adalah folder, bukan file`)

  const options = { maxConnections: 1 }
  if (range) {
    options.start = range.start
    options.end = range.end // inklusif di megajs
  }
  const nodeStream = node.download(options)
  return { node, stream: Readable.toWeb(nodeStream) }
}
