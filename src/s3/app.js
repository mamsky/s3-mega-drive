// S3 gateway: protokol S3 (SigV4) di depan penyimpanan MEGA.
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { HttpError, deleteAtPath, findNode, getStorage, openStream, putFile } from '../mega.js'
import { contentTypeFor } from '../mime.js'
import { parseRange } from '../range.js'
import { config, isConfigured } from './config.js'
import { S3Error, toS3Error } from './errors.js'
import { authenticate } from './sigv4.js'
import { decodeAwsChunked, looksAwsChunked } from './chunked.js'
import { deleteBucketMeta, deleteObjectMeta, readObjectMeta, writeObjectMeta } from './object-meta.js'
import {
  bucketExists,
  bucketIsEmpty,
  bucketPath,
  ensureBucketNode,
  listBuckets,
  objectPath,
  validateBucketName,
  walkKeys,
} from './store.js'
import { assembleParts, createUpload, listParts, listUploads, removeUpload, requireUpload, savePart } from './multipart.js'
import * as xml from './xml.js'

const OWNER = { id: 'mega-drive-api', name: 'mega-drive-api' }
const MAX_VERIFY_BYTES = Number(process.env.S3_VERIFY_MAX_BYTES ?? 16 * 1024 * 1024)
const AUTO_CREATE_BUCKET = String(process.env.S3_AUTO_CREATE_BUCKET ?? 'true').toLowerCase() !== 'false'

// strict:false membuat "/bucket" dan "/bucket/" sama-sama cocok (SDK mengirim trailing slash).
const app = new Hono({ strict: false })
app.use('*', logger())

// ---------- helper ----------

function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()
}

function baseHeaders() {
  const id = newId()
  return {
    'x-amz-request-id': id,
    'x-amz-id-2': id,
    Server: 'mega-drive-s3',
    Date: new Date().toUTCString(),
  }
}

function xmlResponse(c, body, status = 200, extra = {}) {
  return c.body(body, status, { ...baseHeaders(), 'Content-Type': 'application/xml', ...extra })
}

function emptyResponse(c, status = 200, extra = {}) {
  return c.body(null, status, { ...baseHeaders(), ...extra })
}

const INTENTIONAL_ERROR_CODES = new Set(['NotImplemented', 'SlowDown'])

function fail(c, err) {
  const resource = new URL(c.req.url).pathname
  const s3 = toS3Error(err, resource)
  if (s3.status >= 500 && !INTENTIONAL_ERROR_CODES.has(s3.code)) console.error('[s3]', err)
  return xmlResponse(
    c,
    xml.errorXml({ code: s3.code, message: s3.message, resource, requestId: newId() }),
    s3.status
  )
}

/** URL path (+ Host untuk virtual-host style) -> { bucket, key }. */
function parseTarget(url, hostHeader) {
  let raw = url.pathname.replace(/^\/+/, '')

  // Virtual-host style: bucket.localhost:3001/key
  if (!config.forcePathStyle && hostHeader) {
    const host = String(hostHeader).split(':')[0]
    const labels = host.split('.')
    if (labels.length > 1 && labels[0] && labels[0] !== 'localhost') {
      const bucket = labels[0]
      return { bucket, key: raw.split('/').map(safeDecode).join('/') }
    }
  }

  if (!raw) return { bucket: '', key: '' }
  const slash = raw.indexOf('/')
  const bucketRaw = slash === -1 ? raw : raw.slice(0, slash)
  const keyRaw = slash === -1 ? '' : raw.slice(slash + 1)
  return { bucket: safeDecode(bucketRaw), key: keyRaw.split('/').map(safeDecode).join('/') }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function hdr(c, name) {
  return c.req.header(name) ?? null
}

function who(c) {
  return c.get('identity')
}

function originOf(c) {
  const proto = hdr(c, 'x-forwarded-proto') ?? 'http'
  const host = hdr(c, 'host') ?? `localhost:${config.port}`
  return `${proto}://${host}`
}

function readUserMetadata(c) {
  const metadata = {}
  for (const [name, value] of Object.entries(c.req.header())) {
    if (name.toLowerCase().startsWith('x-amz-meta-')) {
      metadata[name.slice('x-amz-meta-'.length).toLowerCase()] = value
    }
  }
  return metadata
}

function objectHeaders({ key, size, lastModified, etag, stored }) {
  const headers = {
    'Content-Type': stored?.contentType || contentTypeFor(key),
    'Content-Length': String(size ?? 0),
    'Last-Modified': new Date(lastModified ?? Date.now()).toUTCString(),
    ETag: `"${etag}"`,
    'Accept-Ranges': 'bytes',
  }
  if (stored?.cacheControl) headers['Cache-Control'] = stored.cacheControl
  if (stored?.contentDisposition) headers['Content-Disposition'] = stored.contentDisposition
  for (const [name, value] of Object.entries(stored?.metadata ?? {})) {
    headers[`x-amz-meta-${name}`] = String(value)
  }
  return headers
}

function etagOf(key, node, stored) {
  return stored?.etag || node?.nodeId || createHash('md5').update(String(key)).digest('hex')
}

/**
 * Baca body request. Streaming dipakai bila klien mengirim Content-Length dan
 * tidak memakai framing aws-chunked; selebihnya di-buffer (lalu di-decode).
 */
async function readBody(c, { alwaysBuffer = false } = {}) {
  const encoding = (hdr(c, 'content-encoding') ?? '').toLowerCase()
  const declared = Number(hdr(c, 'x-amz-decoded-content-length') ?? hdr(c, 'content-length') ?? '0')
  const chunked = encoding.includes('aws-chunked')

  if (!alwaysBuffer && !chunked && Number.isInteger(declared) && declared > 0 && c.req.raw.body) {
    return { buffer: null, size: declared, stream: Readable.fromWeb(c.req.raw.body) }
  }

  const raw = Buffer.from(await c.req.arrayBuffer())
  const buffer = chunked || looksAwsChunked(raw) ? decodeAwsChunked(raw) : raw
  return { buffer, size: buffer.length, stream: null }
}

function verifyPayloadHash(c, buffer) {
  const expected = hdr(c, 'x-amz-content-sha256')
  if (!expected || !buffer) return
  const value = String(expected).toLowerCase()
  if (value === 'unsigned-payload' || value.startsWith('streaming-')) return
  if (!/^[0-9a-f]{64}$/.test(value)) return
  if (buffer.length > MAX_VERIFY_BYTES) return
  const actual = createHash('sha256').update(buffer).digest('hex')
  if (actual !== value) {
    throw new S3Error('XAmzContentSHA256Mismatch', 'Isi body tidak cocok dengan x-amz-content-sha256')
  }
}

// Sub-resource S3 yang tidak punya padanan di MEGA. Tanpa ini, klien yang meminta
// bucket policy akan menerima daftar objek (HTTP 200) dan menganggapnya berhasil.
const UNSUPPORTED_SUBRESOURCES = [
  'accelerate',
  'analytics',
  'encryption',
  'intelligent-tiering',
  'inventory',
  'legal-hold',
  'lifecycle',
  'logging',
  'metrics',
  'notification',
  'object-lock',
  'ownershipControls',
  'policy',
  'publicAccessBlock',
  'replication',
  'requestPayment',
  'restore',
  'retention',
  'tagging',
  'torrent',
  'versions',
  'website',
]

function rejectUnsupportedSubresource(url, hasKey) {
  for (const name of UNSUPPORTED_SUBRESOURCES) {
    if (url.searchParams.has(name)) {
      throw new S3Error('NotImplemented', `Sub-resource "${name}" belum didukung gateway ini`)
    }
  }
  if (hasKey && url.searchParams.has('acl')) {
    throw new S3Error('NotImplemented', 'ACL per objek belum didukung gateway ini')
  }
}

async function requireBucket(c, identity, bucket, storage) {
  if (bucketExists(storage, identity, bucket)) return
  if (!AUTO_CREATE_BUCKET) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)
  await ensureBucketNode(storage, identity, bucket)
}

// ---------- CORS + auth ----------

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next()

  try {
    const auth = authenticate(c.req.raw, config)
    c.set('identity', auth.identity)
  } catch (err) {
    return fail(c, err)
  }

  await next()

  const origin = hdr(c, 'origin')
  if (origin) {
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set('Access-Control-Expose-Headers', 'ETag, x-amz-request-id, Content-Length, Content-Range')
    c.res.headers.append('Vary', 'Origin')
  }
})

app.options('*', (c) => {
  const origin = hdr(c, 'origin') ?? '*'
  return emptyResponse(c, 204, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': hdr(c, 'access-control-request-headers') ?? '*',
    'Access-Control-Expose-Headers': 'ETag, x-amz-request-id, Content-Length, Content-Range',
    'Access-Control-Max-Age': '3600',
  })
})

// ---------- service ----------

app.get('/', async (c) => {
  const storage = await getStorage()
  return xmlResponse(c, xml.listBucketsXml(listBuckets(storage, who(c)), OWNER))
})

// ---------- bucket ----------

app.put('/:bucket', async (c) => {
  const url = new URL(c.req.url)
  const { bucket } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  rejectUnsupportedSubresource(url, false)

  // Sub-resource tanpa state: balas sukses supaya klien tidak gagal.
  if (url.searchParams.has('cors') || url.searchParams.has('acl') || url.searchParams.has('versioning')) {
    return emptyResponse(c, 200)
  }

  const storage = await getStorage()
  await ensureBucketNode(storage, who(c), bucket)
  return emptyResponse(c, 200, { Location: `/${bucket}` })
})

app.delete('/:bucket', async (c) => {
  const { bucket } = parseTarget(new URL(c.req.url), hdr(c, 'host'))
  validateBucketName(bucket)
  const identity = who(c)
  const storage = await getStorage()
  if (!bucketExists(storage, identity, bucket)) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)
  if (!bucketIsEmpty(storage, identity, bucket)) throw new S3Error('BucketNotEmpty', `Bucket masih berisi: ${bucket}`)
  await deleteAtPath(storage, bucketPath(identity, bucket), true)
  await deleteBucketMeta(identity, bucket)
  return emptyResponse(c, 204)
})

app.on(['GET', 'HEAD'], '/:bucket', async (c) => {
  const url = new URL(c.req.url)
  const { bucket } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  rejectUnsupportedSubresource(url, false)
  const identity = who(c)
  const storage = await getStorage()

  if (c.req.method === 'HEAD') {
    if (!bucketExists(storage, identity, bucket)) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)
    return emptyResponse(c, 200, { 'x-amz-bucket-region': config.region })
  }

  if (url.searchParams.has('location')) return xmlResponse(c, xml.locationXml(config.region))
  if (url.searchParams.has('versioning')) return xmlResponse(c, xml.versioningXml())
  if (url.searchParams.has('acl')) return xmlResponse(c, xml.aclXml(OWNER))
  if (url.searchParams.has('cors')) return xmlResponse(c, xml.corsXml([]))
  if (url.searchParams.has('uploads')) {
    const uploads = await listUploads(identity, bucket, url.searchParams.get('prefix') ?? '')
    return xmlResponse(c, xml.listMultipartUploadsXml({ bucket, uploads }))
  }

  if (!bucketExists(storage, identity, bucket)) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)

  const prefix = url.searchParams.get('prefix') ?? ''
  const delimiter = url.searchParams.get('delimiter') ?? ''
  const encodingType = url.searchParams.get('encoding-type')
  const maxKeys = Math.min(
    Math.max(Number(url.searchParams.get('max-keys') ?? config.maxKeys) || config.maxKeys, 1),
    config.maxKeys
  )
  const startAfter = url.searchParams.get('start-after') ?? ''
  const token = url.searchParams.get('continuation-token') ?? url.searchParams.get('marker') ?? ''
  const from = token ? Buffer.from(token, 'base64url').toString('utf8') : startAfter

  // Bentuk daftar gabungan (objek + common prefix), unik, terurut.
  const combined = new Map()
  for (const item of walkKeys(storage, identity, bucket, prefix)) {
    const rest = item.key.slice(prefix.length)
    const index = delimiter ? rest.indexOf(delimiter) : -1
    if (index === -1) {
      combined.set(item.key, { type: 'object', value: item.key, item })
    } else {
      const common = prefix + rest.slice(0, index + delimiter.length)
      if (!combined.has(common)) combined.set(common, { type: 'prefix', value: common })
    }
  }

  const ordered = [...combined.values()].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  const remaining = from ? ordered.filter((entry) => entry.value > from) : ordered
  const page = remaining.slice(0, maxKeys)
  const truncated = remaining.length > page.length

  const objectEntries = page.filter((entry) => entry.type === 'object')
  const contents = await Promise.all(
    objectEntries.map(async (entry) => ({
      key: entry.item.key,
      size: entry.item.size,
      lastModified: entry.item.lastModified,
      etag: etagOf(entry.item.key, { nodeId: entry.item.etag }, await readObjectMeta(identity, bucket, entry.item.key)),
    }))
  )
  const commonPrefixes = page.filter((entry) => entry.type === 'prefix').map((entry) => entry.value)
  const lastValue = page.length > 0 ? page[page.length - 1].value : ''

  return xmlResponse(
    c,
    xml.listObjectsXml({
      bucket,
      prefix,
      delimiter,
      maxKeys,
      isTruncated: truncated,
      contents,
      commonPrefixes,
      continuationToken: token || null,
      nextToken: truncated && lastValue ? Buffer.from(lastValue, 'utf8').toString('base64url') : null,
      startAfter: startAfter || null,
      encodingType,
    })
  )
})

app.post('/:bucket', async (c) => {
  const url = new URL(c.req.url)
  const { bucket } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  const identity = who(c)
  const storage = await getStorage()
  if (!bucketExists(storage, identity, bucket)) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)
  if (!url.searchParams.has('delete')) {
    throw new S3Error('NotImplemented', 'Operasi POST bucket ini belum didukung')
  }

  const body = Buffer.from(await c.req.arrayBuffer()).toString('utf8')
  const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => xml.unescapeXml(match[1]))
  const deleted = []
  const errors = []

  for (const key of keys) {
    try {
      const node = findNode(storage, objectPath(identity, bucket, key))
      if (node && !node.directory) await deleteAtPath(storage, objectPath(identity, bucket, key), true)
      await deleteObjectMeta(identity, bucket, key)
      deleted.push(key)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        await deleteObjectMeta(identity, bucket, key)
        deleted.push(key)
        continue
      }
      errors.push({ key, code: 'InternalError', message: err.message })
    }
  }
  return xmlResponse(c, xml.deleteResultXml({ deleted, errors }))
})

// ---------- object: write ----------

app.put('/:bucket/:key{.+}', async (c) => {
  const url = new URL(c.req.url)
  const { bucket, key } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  if (!key) throw new S3Error('InvalidArgument', 'Key objek wajib diisi')
  rejectUnsupportedSubresource(url, true)

  const identity = who(c)
  const storage = await getStorage()
  await requireBucket(c, identity, bucket, storage)

  const uploadId = url.searchParams.get('uploadId')
  if (uploadId) {
    const partNumber = Number(url.searchParams.get('partNumber'))
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new S3Error('InvalidArgument', 'PartNumber wajib 1-10000')
    }
    const state = await requireUpload(uploadId, identity)
    if (state.bucket !== bucket || state.key !== key) {
      throw new S3Error('NoSuchUpload', 'UploadId bukan milik objek ini')
    }
    const body = await readBody(c, { alwaysBuffer: true })
    const part = await savePart(uploadId, partNumber, body.buffer)
    return emptyResponse(c, 200, { ETag: `"${part.etag}"` })
  }

  const copySource = hdr(c, 'x-amz-copy-source')
  if (copySource) return copyObject(c, { identity, bucket, key, copySource, storage })

  const body = await readBody(c)
  verifyPayloadHash(c, body.buffer)

  const result = await putFile(storage, objectPath(identity, bucket, key), {
    stream: body.stream ?? Readable.from(body.buffer),
    size: body.size,
    mode: 'replace',
  })

  await writeObjectMeta(identity, bucket, key, {
    contentType: hdr(c, 'content-type') ?? null,
    cacheControl: hdr(c, 'cache-control') ?? null,
    contentDisposition: hdr(c, 'content-disposition') ?? null,
    metadata: readUserMetadata(c),
    etag: result.file.nodeId,
  })

  return emptyResponse(c, 200, { ETag: `"${result.file.nodeId}"` })
})

async function copyObject(c, { identity, bucket, key, copySource, storage }) {
  const source = safeDecode(String(copySource).replace(/^\//, '').split('?')[0])
  const slash = source.indexOf('/')
  if (slash === -1) throw new S3Error('InvalidArgument', 'x-amz-copy-source harus /bucket/key')

  const sourceBucket = source.slice(0, slash)
  const sourceKey = source.slice(slash + 1)
  const node = findNode(storage, objectPath(identity, sourceBucket, sourceKey))
  if (!node || node.directory) throw new S3Error('NoSuchKey', `Sumber tidak ada: ${source}`)

  const { stream } = openStream(storage, objectPath(identity, sourceBucket, sourceKey), null)
  const result = await putFile(storage, objectPath(identity, bucket, key), {
    stream: Readable.fromWeb(stream),
    size: node.size ?? 0,
    mode: 'replace',
  })

  const previous = await readObjectMeta(identity, sourceBucket, sourceKey)
  await writeObjectMeta(identity, bucket, key, {
    contentType: previous?.contentType ?? null,
    cacheControl: previous?.cacheControl ?? null,
    contentDisposition: previous?.contentDisposition ?? null,
    metadata: previous?.metadata ?? {},
    etag: result.file.nodeId,
  })

  return xmlResponse(c, xml.copyObjectXml({ etag: result.file.nodeId, lastModified: new Date() }))
}

// ---------- object: read ----------

app.on(['GET', 'HEAD'], '/:bucket/:key{.+}', async (c) => {
  const url = new URL(c.req.url)
  const { bucket, key } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  rejectUnsupportedSubresource(url, true)
  const identity = who(c)
  const storage = await getStorage()
  if (!bucketExists(storage, identity, bucket)) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)

  const uploadId = url.searchParams.get('uploadId')
  if (uploadId) {
    await requireUpload(uploadId, identity)
    return xmlResponse(c, xml.listPartsXml({ bucket, key, uploadId, parts: await listParts(uploadId) }))
  }

  const node = findNode(storage, objectPath(identity, bucket, key))
  if (!node || node.directory) throw new S3Error('NoSuchKey', `Objek tidak ada: ${key}`)

  const stored = await readObjectMeta(identity, bucket, key)
  const size = node.size ?? 0
  const headers = objectHeaders({
    key,
    size,
    lastModified: node.createdAt,
    etag: etagOf(key, node, stored),
    stored,
  })

  if (c.req.method === 'HEAD') return emptyResponse(c, 200, headers)

  let range = null
  try {
    range = parseRange(hdr(c, 'range'), size)
  } catch (err) {
    if (err instanceof HttpError && err.status === 416) {
      return xmlResponse(
        c,
        xml.errorXml({
          code: 'InvalidRange',
          message: `Range tidak valid untuk objek berukuran ${size} byte`,
          resource: `/${bucket}/${key}`,
          requestId: newId(),
        }),
        416,
        { 'Content-Range': `bytes */${size}` }
      )
    }
    throw err
  }

  const { stream } = openStream(storage, objectPath(identity, bucket, key), range)
  if (range) {
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders(),
        ...headers,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      },
    })
  }
  return new Response(stream, { status: 200, headers: { ...baseHeaders(), ...headers } })
})

// ---------- object: delete ----------

app.delete('/:bucket/:key{.+}', async (c) => {
  const url = new URL(c.req.url)
  const { bucket, key } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  const identity = who(c)
  const storage = await getStorage()
  if (!bucketExists(storage, identity, bucket)) throw new S3Error('NoSuchBucket', `Bucket tidak ada: ${bucket}`)

  const uploadId = url.searchParams.get('uploadId')
  if (uploadId) {
    await requireUpload(uploadId, identity)
    await removeUpload(uploadId)
    return emptyResponse(c, 204)
  }

  // S3 tidak punya folder: key yang menunjuk folder dianggap tidak ada.
  const node = findNode(storage, objectPath(identity, bucket, key))
  if (node && !node.directory) await deleteAtPath(storage, objectPath(identity, bucket, key), true)
  await deleteObjectMeta(identity, bucket, key)
  return emptyResponse(c, 204)
})

// ---------- multipart ----------

app.post('/:bucket/:key{.+}', async (c) => {
  const url = new URL(c.req.url)
  const { bucket, key } = parseTarget(url, hdr(c, 'host'))
  validateBucketName(bucket)
  if (!key) throw new S3Error('InvalidArgument', 'Key objek wajib diisi')

  const identity = who(c)
  const storage = await getStorage()
  await requireBucket(c, identity, bucket, storage)

  const uploadId = url.searchParams.get('uploadId')
  if (!uploadId) {
    if (!url.searchParams.has('uploads')) {
      throw new S3Error('NotImplemented', 'Hanya POST ?uploads dan POST ?uploadId yang didukung')
    }
    const state = await createUpload({
      identity,
      bucket,
      key,
      contentType: hdr(c, 'content-type'),
      cacheControl: hdr(c, 'cache-control'),
      metadata: readUserMetadata(c),
    })
    return xmlResponse(c, xml.initiateMultipartXml(bucket, key, state.uploadId))
  }

  const body = Buffer.from(await c.req.arrayBuffer()).toString('utf8')
  const requested = [...body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((match) => ({
    partNumber: Number(/<PartNumber>([\s\S]*?)<\/PartNumber>/.exec(match[1])?.[1] ?? 0),
    etag: /<ETag>([\s\S]*?)<\/ETag>/.exec(match[1])?.[1] ?? null,
  }))

  await requireUpload(uploadId, identity)
  const { state, buffer } = await assembleParts(uploadId, requested)
  const result = await putFile(storage, objectPath(identity, bucket, key), {
    stream: Readable.from(buffer),
    size: buffer.length,
    mode: 'replace',
  })

  await writeObjectMeta(identity, bucket, key, {
    contentType: state.contentType,
    cacheControl: state.cacheControl,
    metadata: state.metadata,
    etag: result.file.nodeId,
  })
  await removeUpload(uploadId)

  return xmlResponse(
    c,
    xml.completeMultipartXml({
      location: `${originOf(c)}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
      bucket,
      key,
      etag: result.file.nodeId,
    })
  )
})

// ---------- error handling ----------

app.notFound((c) =>
  fail(c, new S3Error('NotImplemented', `Route tidak dikenal: ${c.req.method} ${new URL(c.req.url).pathname}`))
)

app.onError((err, c) => fail(c, err))

export { app, config, isConfigured }
