// Operasi file browser UI, selalu dibatasi ke root satu identitas.
import { Readable } from 'node:stream'
import {
  HttpError,
  deleteAtPath,
  ensureFolder,
  findNode,
  listFolder,
  openStream,
  putFile,
} from '../mega.js'
import { bucketPath, listBuckets, objectPath, validateBucketName, keySegments, walkKeys } from '../s3/store.js'

function cleanKey(key) {
  return keySegments(key).join('/')
}

/** Daftar bucket + isi satu bucket pada prefix tertentu. */
export function browse(storage, identity, { bucket = '', prefix = '' } = {}) {
  if (!bucket) {
    return {
      bucket: null,
      prefix: '',
      folders: [],
      objects: [],
      buckets: listBuckets(storage, identity),
    }
  }

  const base = bucketPath(identity, bucket)
  const dirPath = [base, cleanKey(prefix)].filter(Boolean).join('/')
  const listing = listFolder(storage, dirPath)

  const folders = []
  const objects = []
  for (const entry of listing.entries) {
    const key = entry.path.startsWith(`${base}/`) ? entry.path.slice(base.length + 1) : entry.name
    if (entry.directory) folders.push({ key, name: entry.name })
    else objects.push({ key, name: entry.name, size: entry.size, lastModified: entry.createdAt })
  }

  return { bucket, prefix: cleanKey(prefix), folders, objects, buckets: null }
}

export async function makeFolder(storage, identity, bucket, prefix, name) {
  const clean = String(name ?? '').trim()
  if (!clean) throw new HttpError(400, 'Nama folder wajib diisi')
  if (clean.includes('/')) throw new HttpError(400, 'Nama folder tidak boleh mengandung "/"')
  if (clean === '.' || clean === '..') throw new HttpError(400, 'Nama folder tidak diizinkan')

  const target = [prefix, clean].filter(Boolean).join('/')
  await ensureFolder(storage, objectPath(identity, bucket, target))
  return target
}

export async function createBucket(storage, identity, name) {
  const bucket = validateBucketName(String(name ?? '').trim().toLowerCase())
  await ensureFolder(storage, bucketPath(identity, bucket))
  return bucket
}

export function deleteBucket(storage, identity, bucket) {
  const node = findNode(storage, bucketPath(identity, bucket))
  if (!node) throw new HttpError(404, `Bucket tidak ditemukan: "${bucket}"`)
  if (walkKeys(storage, identity, bucket).length > 0) {
    throw new HttpError(409, `Bucket "${bucket}" masih berisi data`)
  }
  return deleteAtPath(storage, bucketPath(identity, bucket), true)
}

export function deleteObject(storage, identity, bucket, key) {
  return deleteAtPath(storage, objectPath(identity, bucket, key), true)
}

export async function uploadObject(storage, identity, bucket, prefix, filename, stream, size) {
  const name = String(filename ?? '').trim() || 'untitled'
  if (name.includes('/')) throw new HttpError(400, 'Nama file tidak boleh mengandung "/"')
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'File kosong tidak bisa diupload')

  const key = [prefix, name].filter(Boolean).join('/')
  const result = await putFile(storage, objectPath(identity, bucket, key), {
    stream: Readable.fromWeb(stream),
    size,
    mode: 'replace',
  })
  return { key, ...result }
}

export function downloadObject(storage, identity, bucket, key) {
  const path = objectPath(identity, bucket, key)
  const node = findNode(storage, path)
  if (!node) throw new HttpError(404, `File tidak ditemukan: "${key}"`)
  return openStream(storage, path)
}
