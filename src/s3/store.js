// Pemetaan konsep S3 (bucket + key) ke struktur folder MEGA, dibatasi ke root satu identitas.
import { HttpError, ensureFolder, findNode, listFolder, visibleChildren } from '../mega.js'
import { S3Error } from './errors.js'

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/** Bucket = folder di dalam root identitas. Nama divalidasi seperti aturan S3. */
export function validateBucketName(bucket) {
  const name = String(bucket ?? '')
  if (!BUCKET_RE.test(name)) {
    throw new S3Error(
      'InvalidBucketName',
      `Nama bucket tidak valid: "${name}". Pakai 3-63 karakter huruf kecil, angka, titik, atau tanda hubung.`
    )
  }
  if (name.includes('..') || name.includes('.-') || name.includes('-.')) {
    throw new S3Error('InvalidBucketName', `Nama bucket tidak boleh mengandung "..", ".-", atau "-."`)
  }
  return name
}

/** Pecah key jadi segmen tanpa memangkas spasi, dan tolak path traversal. */
export function keySegments(key) {
  const raw = String(key ?? '')
  if (raw.length > 1024) throw new S3Error('KeyTooLongError', 'Key melebihi 1024 byte')
  const parts = raw.split('/').filter((part) => part.length > 0)
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new S3Error('InvalidArgument', `Segmen key tidak diizinkan: "${part}"`)
    }
  }
  return parts
}

/** Path MEGA untuk sebuah bucket di dalam ruang satu identitas: "<root>/<bucket>". */
export function bucketPath(identity, bucket) {
  return [identity.root, validateBucketName(bucket)].join('/')
}

/** Path MEGA untuk sebuah objek: "<root>/<bucket>/<key>". */
export function objectPath(identity, bucket, key) {
  return [identity.root, validateBucketName(bucket), ...keySegments(key)].join('/')
}

export function getBucketNode(storage, identity, bucket) {
  const node = findNode(storage, bucketPath(identity, bucket))
  if (!node || !node.directory) return null
  return node
}

export async function ensureBucketNode(storage, identity, bucket) {
  return ensureFolder(storage, bucketPath(identity, bucket))
}

export function bucketExists(storage, identity, bucket) {
  return getBucketNode(storage, identity, bucket) !== null
}

// MEGA menyisakan folder kosong dari key "a/b.txt"; S3 menganggapnya tetap kosong.
export function bucketIsEmpty(storage, identity, bucket) {
  if (!getBucketNode(storage, identity, bucket)) return true
  return walkKeys(storage, identity, bucket).length === 0
}

/**
 * Kumpulkan semua objek di bawah prefix. Folder ditelusuri rekursif.
 * Key yang dikembalikan relatif terhadap bucket (bukan terhadap root identitas).
 * @returns {Array<{key:string, size:number, lastModified:string|null, etag:string|null}>}
 */
export function walkKeys(storage, identity, bucket, prefix = '') {
  const base = bucketPath(identity, bucket)
  const startKey = prefix.endsWith('/')
    ? prefix.slice(0, -1)
    : prefix.includes('/')
      ? prefix.slice(0, prefix.lastIndexOf('/'))
      : ''

  const results = []
  const stack = [[base, startKey].filter(Boolean).join('/')]

  while (stack.length > 0) {
    const path = stack.pop()
    let listing
    try {
      listing = listFolder(storage, path)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) continue
      throw err
    }
    for (const entry of listing.entries) {
      const key = entry.path.startsWith(`${base}/`) ? entry.path.slice(base.length + 1) : entry.path
      if (entry.directory) {
        stack.push(entry.path)
      } else if (key.startsWith(prefix)) {
        results.push({ key, size: entry.size ?? 0, lastModified: entry.createdAt, etag: entry.nodeId })
      }
    }
  }

  results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return results
}

/** Daftar bucket milik satu identitas (isi folder root-nya). */
export function listBuckets(storage, identity) {
  const node = findNode(storage, identity.root)
  if (!node || !node.directory) return []
  return visibleChildren(node)
    .filter((child) => child.directory && !child.name.startsWith('.'))
    .map((child) => ({ name: child.name, createdAt: child.createdAt }))
}
