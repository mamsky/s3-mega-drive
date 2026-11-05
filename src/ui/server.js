// Web console: login per identitas, lihat config S3, dan file browser.
import { Hono } from 'hono'
import { HttpError, closeStorage, deleteAtPath, getStorage } from '../mega.js'
import { closeDb, dbEnabled, initSchema } from '../db.js'
import { config } from '../s3/config.js'
import { loadIdentities } from '../s3/identities.js'
import { bucketPath, validateBucketName } from '../s3/store.js'
import {
  checkCredentials,
  clearCookie,
  clearFailures,
  createSession,
  currentIdentity,
  destroySession,
  noteFailure,
  sessionCookie,
  sweepSessions,
  tooManyAttempts,
} from './auth.js'
import {
  browse,
  createBucket,
  deleteBucket,
  deleteObject,
  downloadObject,
  makeFolder,
  uploadObject,
} from './browse.js'
const PAGE = await Bun.file(new URL('./page.html', import.meta.url)).text()

const app = new Hono()

function clientIp(c) {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'local'
}

function identityOrThrow(c) {
  const identity = currentIdentity(c.req.raw, config.identities)
  if (!identity) throw new HttpError(401, 'Sesi berakhir, silakan login lagi')
  return identity
}

// Endpoint yang ditampilkan adalah alamat S3 gateway, bukan alamat console ini.
// S3_PUBLIC_ENDPOINT dipakai kalau gateway diakses lewat domain / reverse proxy.
function endpointFor(c) {
  const override = process.env.S3_PUBLIC_ENDPOINT?.trim()
  if (override) return override.replace(/\/+$/, '')

  const host = c.req.header('host') ?? `127.0.0.1:${config.port}`
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return `http://${hostname}:${config.port}`
}

app.get('/', (c) => c.html(PAGE))

app.post('/api/login', async (c) => {
  const ip = clientIp(c)
  if (tooManyAttempts(ip)) {
    throw new HttpError(429, 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.')
  }

  const body = await c.req.json().catch(() => ({}))
  const identity = await checkCredentials(config.identities, body.name, body.password)
  if (!identity) {
    noteFailure(ip)
    throw new HttpError(401, 'Nama identitas atau password salah')
  }

  clearFailures(ip)
  const token = createSession(identity)
  c.header('set-cookie', sessionCookie(token))
  return c.json({ name: identity.name })
})

app.post('/api/logout', (c) => {
  destroySession(c.req.raw)
  c.header('set-cookie', clearCookie())
  return c.json({ ok: true })
})

app.get('/api/me', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  const info = await storage.getAccountInfo().catch(() => null)

  const quota = info?.spaceTotal
    ? {
        used: info.spaceUsed ?? 0,
        total: info.spaceTotal,
        percent: Math.round(((info.spaceUsed ?? 0) / info.spaceTotal) * 1000) / 10,
      }
    : null

  return c.json({
    name: identity.name,
    root: identity.root,
    endpoint: endpointFor(c),
    region: config.region,
    accessKeyId: identity.accessKeyId,
    secretAccessKey: identity.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    quota,
  })
})

app.get('/api/browse', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  return c.json(
    browse(storage, identity, {
      bucket: c.req.query('bucket') ?? '',
      prefix: c.req.query('prefix') ?? '',
    })
  )
})

app.post('/api/bucket', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  const body = await c.req.json().catch(() => ({}))
  const bucket = await createBucket(storage, identity, body.name)
  return c.json({ bucket })
})

app.delete('/api/bucket', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  const bucket = validateBucketName(c.req.query('name') ?? '')
  await deleteBucket(storage, identity, bucket)
  return c.json({ deleted: bucket })
})

app.post('/api/folder', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  const body = await c.req.json().catch(() => ({}))
  const key = await makeFolder(storage, identity, body.bucket, body.prefix ?? '', body.name)
  return c.json({ key })
})

app.post('/api/upload', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()

  let form
  try {
    form = await c.req.formData()
  } catch (err) {
    throw new HttpError(400, `Body multipart tidak valid: ${err.message}`)
  }

  const bucket = String(form.get('bucket') ?? '')
  const prefix = String(form.get('prefix') ?? '')
  const file = form.get('file')

  const isFile = file && typeof file === 'object' && typeof file.stream === 'function' && typeof file.size === 'number'
  if (!isFile) throw new HttpError(400, 'Field "file" wajib berisi file')

  const result = await uploadObject(storage, identity, bucket, prefix, file.name, file.stream(), file.size)
  return c.json({ key: result.key, size: result.file.size, nodeId: result.file.nodeId })
})

app.post('/api/delete', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  const body = await c.req.json().catch(() => ({}))
  const bucket = validateBucketName(body.bucket ?? '')

  if (body.folder) {
    const path = [bucketPath(identity, bucket), ...String(body.key ?? '').split('/').filter(Boolean)].join('/')
    await deleteAtPath(storage, path, true)
    return c.json({ deleted: body.key })
  }

  await deleteObject(storage, identity, bucket, body.key)
  return c.json({ deleted: body.key })
})

app.get('/api/download', async (c) => {
  const identity = identityOrThrow(c)
  const storage = await getStorage()
  const bucket = validateBucketName(c.req.query('bucket') ?? '')
  const key = c.req.query('key') ?? ''
  const { node, stream } = downloadObject(storage, identity, bucket, key)

  const filename = node.name.replace(/["\\]/g, '_')
  return new Response(stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(node.size ?? 0),
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
})

app.notFound((c) => c.json({ error: 'Tidak ditemukan' }, 404))

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500
  if (status >= 500) console.error('[ui]', err)
  return c.json({ error: err.message ?? 'Terjadi kesalahan' }, status)
})

setInterval(sweepSessions, 1000 * 60 * 10).unref?.()

if (dbEnabled) {
  await initSchema()
  console.log('[ui] database tersambung, skema siap')
}

await loadIdentities()

const port = Number(process.env.S3_UI_PORT ?? 3002)
const hostname = process.env.S3_UI_HOSTNAME ?? '127.0.0.1'

if (config.identities.length === 0) {
  console.warn('[ui] Belum ada identitas S3 — isi tabel "identities" atau s3-identities.local.json dulu.')
} else {
  const withoutPassword = config.identities.filter((item) => !item.passwordHash)
  if (withoutPassword.length > 0) {
    console.warn(
      `[ui] Identitas tanpa password (tidak bisa login UI): ${withoutPassword.map((item) => item.name).join(', ')}`
    )
  }
}

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 255,
  maxRequestBodySize: Number(process.env.S3_UI_MAX_BODY_BYTES ?? 5 * 1024 * 1024 * 1024),
  fetch: app.fetch,
})

console.log(`mega-drive console jalan di http://${hostname}:${port}`)
console.log(`  - ${config.identities.filter((item) => item.passwordHash).length} identitas bisa login`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.stop()
    await closeStorage()
    await closeDb()
    process.exit(0)
  })
}

export { server }
