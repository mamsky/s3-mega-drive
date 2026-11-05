// REST API untuk MEGA: upload (create), replace (update), list, view (streaming + Range), delete.
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import {
  HttpError,
  closeStorage,
  deleteAtPath,
  ensureFolder,
  findNode,
  getStorage,
  listFolder,
  meta,
  openStream,
  putFile,
  renameAtPath,
  splitPath,
  validateName,
} from './mega.js'
import { contentTypeFor, isViewable } from './mime.js'
import { compressImage, isCompressibleImage } from './image.js'
import { parseRange } from './range.js'

const app = new Hono()
app.use('*', logger())

const MAX_COMPRESS_BYTES = 25 * 1024 * 1024
const DEFAULT_QUALITY = 85

function parseQuality(raw) {
  if (raw === undefined) return DEFAULT_QUALITY
  const value = String(raw).trim().toLowerCase()
  if (['0', 'off', 'false', 'no'].includes(value)) return null
  if (['', '1', 'on', 'true', 'yes'].includes(value)) return DEFAULT_QUALITY
  const quality = Number(value)
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new HttpError(400, 'Kualitas kompresi harus angka 1-100, atau 0 untuk mematikan')
  }
  return quality
}

function isAutoName(raw, fallback = false) {
  if (raw === undefined) return fallback
  const value = String(raw).trim().toLowerCase()
  if (value === '' || ['1', 'true', 'on', 'yes'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  throw new HttpError(400, 'Nilai ?autoname harus 1 (aktif) atau 0 (nonaktif)')
}

function autoNameParts(original) {
  const ext = /(\.[A-Za-z0-9]{1,8})$/.exec(String(original ?? '').trim())?.[1] ?? ''
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return { stem: `AR-${stamp}`, ext }
}

function autoNameIn(storage, folderPath, original) {
  const { stem, ext } = autoNameParts(original)
  for (let counter = 1; ; counter += 1) {
    const name = counter === 1 ? `${stem}${ext}` : `${stem}-${counter}${ext}`
    if (!findNode(storage, [folderPath, name].filter(Boolean).join('/'))) return name
  }
}

async function maybeCompress(upload, quality) {
  if (!quality) return upload
  if (!isCompressibleImage(contentTypeFor(upload.filename))) return upload
  if (upload.size > MAX_COMPRESS_BYTES) {
    return { ...upload, compression: { skipped: 'file lebih besar dari 25 MB' } }
  }

  const chunks = []
  for await (const chunk of upload.stream) chunks.push(chunk)
  const original = Buffer.concat(chunks)

  const result = await compressImage(original, quality)
  if (!result) {
    return { ...upload, stream: original, compression: { skipped: 'hasil kompresi tidak lebih kecil' } }
  }
  return {
    ...upload,
    stream: result.buffer,
    size: result.compressedSize,
    compression: {
      quality,
      originalBytes: result.originalSize,
      compressedBytes: result.compressedSize,
      savedPercent: Math.round((1 - result.compressedSize / result.originalSize) * 1000) / 10,
    },
  }
}

/** Ambil path dari URL setelah prefix, decode per-segmen (aman untuk spasi & tanda khusus). */
function pathFromRequest(c, prefix) {
  const raw = new URL(c.req.url).pathname
  if (!raw.startsWith(prefix)) return ''
  const rest = raw.slice(prefix.length).replace(/^\/+/, '')
  if (!rest) return ''
  return rest
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

function requirePath(path, hint) {
  if (!path) throw new HttpError(400, hint)
  return path
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function fileUrls(c, path) {
  const origin = new URL(c.req.url).origin
  const encoded = encodePath(path)
  return {
    view: `${origin}/view/${encoded}`,
    download: `${origin}/download/${encoded}`,
    info: `${origin}/files/${encoded}`,
  }
}

function folderUrls(c, path) {
  const origin = new URL(c.req.url).origin
  return { list: `${origin}/list/${encodePath(path)}` }
}

/** Baca file dari request: multipart (field "file") atau body mentah + X-Filename. */
async function readUpload(c) {
  const contentType = c.req.header('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    let form
    try {
      form = await c.req.formData()
    } catch (err) {
      throw new HttpError(400, `Body multipart tidak valid: ${err.message}`)
    }
    const file = form.get('file')
    const looksLikeFile =
      file && typeof file === 'object' && typeof file.stream === 'function' && typeof file.size === 'number'
    if (!looksLikeFile) throw new HttpError(400, 'Field "file" wajib berisi file (multipart/form-data)')
    if (file.size === 0) throw new HttpError(400, 'File kosong tidak bisa diupload')
    return { stream: Readable.fromWeb(file.stream()), size: file.size, filename: file.name || 'untitled' }
  }

  const filename = c.req.header('x-filename') ?? c.req.query('name')
  if (!filename) {
    throw new HttpError(
      400,
      'Kirim multipart/form-data dengan field "file", atau body mentah + header X-Filename (dan Content-Length)'
    )
  }
  const length = Number(c.req.header('content-length'))
  if (!Number.isInteger(length) || length <= 0) {
    throw new HttpError(411, 'Upload body mentah wajib menyertakan header Content-Length')
  }
  const body = c.req.raw.body
  if (!body) throw new HttpError(400, 'Body request kosong')
  return { stream: Readable.fromWeb(body), size: length, filename }
}

// ---------- info ----------

app.get('/', (c) =>
  c.json({
    service: 'mega-drive-api',
    endpoints: {
      'GET /health': 'status koneksi MEGA',
      'GET /list': 'daftar isi root',
      'GET /list/*': 'daftar isi folder',
      'GET /files/*': 'metadata satu file/folder',
      'POST /files': 'upload (nama otomatis AR-YYYYMMDD-HHMMSS.ext; opsional ?folder=foto, ?name=, ?autoname=0)',
      'POST /files/*': 'upload ke path lengkap (*=path termasuk nama file; dengan ?autoname=1, * dianggap folder tujuan)',
      'PUT /files/*': 'update/replace isi file (*=path lengkap; ?name=nama-baru.ext atau ?autoname=1)',
      'PATCH /files/*': 'ganti nama saja tanpa upload (*=path; wajib ?name=nama-baru.ext)',
      'DELETE /files/*': 'hapus (*=path lengkap; ?permanent=1 untuk hapus permanen)',
      'GET /view/*': 'stream inline gambar/pdf/video/audio (mendukung Range)',
      'GET /download/*': 'unduh sebagai attachment (mendukung Range)',
      'POST /folders/*': 'buat folder (otomatis buat parent)',
    },
    uploadOptions: {
      '?q=<1-100>': 'kualitas kompresi gambar (default 85)',
      '?q=0': 'matikan kompresi gambar',
      '?overwrite=1': 'timpa file yang sudah ada',
      '?name=nama-baru.ext': 'simpan dengan nama berbeda (POST/PUT) atau ganti nama (PATCH)',
      '?autoname=1': 'nama otomatis (POST /files sudah default; dengan path, path dianggap folder tujuan)',
      '?autoname=0': 'pakai nama asli file',
    },
  })
)

app.get('/health', async (c) => {
  const storage = await getStorage()
  const info = await storage.getAccountInfo().catch(() => null)
  return c.json({
    status: storage.status,
    email: storage.options?.email ?? null,
    spaceUsed: info?.spaceUsed ?? null,
    spaceTotal: info?.spaceTotal ?? null,
  })
})

// ---------- list & metadata ----------

app.get('/list', async (c) => {
  const storage = await getStorage()
  return c.json(listFolder(storage, c.req.query('path') ?? ''))
})

app.get('/list/*', async (c) => {
  const storage = await getStorage()
  return c.json(listFolder(storage, pathFromRequest(c, '/list')))
})

app.get('/files', async (c) => {
  const storage = await getStorage()
  return c.json(listFolder(storage, c.req.query('path') ?? ''))
})

app.get('/files/*', async (c) => {
  const storage = await getStorage()
  const path = requirePath(pathFromRequest(c, '/files'), 'Path file wajib diisi')
  const node = findNode(storage, path)
  if (!node) throw new HttpError(404, `Tidak ditemukan: "${path}"`)
  return c.json(meta(node))
})

// ---------- create / update ----------

async function handleUpload(c, destPath, mode) {
  const storage = await getStorage()
  const quality = parseQuality(c.req.query('q') ?? c.req.query('quality'))
  const auto = isAutoName(c.req.query('autoname'))
  const upload = await maybeCompress(await readUpload(c), quality)

  const requestedPath = destPath ?? upload.filename
  const parts = splitPath(requestedPath)
  if (parts.length === 0) throw new HttpError(400, 'Path tujuan tidak valid')

  const rawName = (c.req.query('rename') ?? c.req.query('name') ?? '').trim()

  let path
  if (auto) {
    const targetFolder = c.req.method === 'PUT' ? parts.slice(0, -1) : parts
    path = [...targetFolder, autoNameIn(storage, targetFolder.join('/'), upload.filename)].join('/')
  } else if (rawName) {
    path = [...parts.slice(0, -1), validateName(rawName, 'Nama baru')].join('/')
  } else {
    path = requestedPath
  }

  const lookupPrevious = path !== requestedPath && (!auto || c.req.method === 'PUT')
  const previous = lookupPrevious ? findNode(storage, requestedPath) : null
  if (previous?.directory) throw new HttpError(409, `"${requestedPath}" adalah folder, bukan file`)

  const result = await putFile(storage, path, { stream: upload.stream, size: upload.size, mode })

  let renamedFrom = null
  let warning = result.warning
  if (c.req.method === 'PUT' && previous) {
    try {
      await deleteAtPath(storage, requestedPath, true)
      renamedFrom = requestedPath
    } catch (err) {
      warning = `Upload berhasil tapi file lama gagal dihapus: ${err.message}`
    }
  }

  const status = result.replaced || renamedFrom ? 200 : 201
  return c.json(
    {
      ok: true,
      mode,
      uploadedBytes: upload.size,
      compression: upload.compression ?? null,
      ...result,
      renamedFrom,
      warning,
      urls: fileUrls(c, path),
    },
    status
  )
}

app.post('/files', async (c) => {
  const folder = c.req.query('folder') ?? ''
  const name = (c.req.query('name') ?? '').trim() || null
  const autoParam = c.req.query('autoname')
  const auto = autoParam === undefined ? !name : isAutoName(autoParam)
  const quality = parseQuality(c.req.query('q') ?? c.req.query('quality'))
  const storage = await getStorage()
  const upload = await maybeCompress(await readUpload(c), quality)
  const path = [folder, auto ? autoNameIn(storage, folder, upload.filename) : (name ?? upload.filename)].filter((part) => part).join('/')
  const mode = c.req.query('overwrite') ? 'replace' : 'create'
  const result = await putFile(storage, path, { stream: upload.stream, size: upload.size, mode })
  return c.json(
    { ok: true, mode, uploadedBytes: upload.size, compression: upload.compression ?? null, ...result, urls: fileUrls(c, path) },
    result.replaced ? 200 : 201
  )
})

app.post('/files/*', async (c) => {
  const destPath = pathFromRequest(c, '/files')
  const mode = c.req.query('overwrite') ? 'replace' : 'create'
  return handleUpload(c, requirePath(destPath, 'Path tujuan wajib diisi'), mode)
})

app.put('/files/*', async (c) => {
  const destPath = pathFromRequest(c, '/files')
  return handleUpload(c, requirePath(destPath, 'Path file yang akan di-update wajib diisi'), 'replace')
})

app.put('/files', async (c) => {
  const folder = c.req.query('folder') ?? ''
  const name = c.req.query('name') ?? null
  if (!name) throw new HttpError(400, 'Update via PUT /files butuh ?name=nama-file.ext')
  return handleUpload(c, [folder, name].filter((part) => part).join('/'), 'replace')
})

app.patch('/files/*', async (c) => {
  const storage = await getStorage()
  const path = requirePath(pathFromRequest(c, '/files'), 'Path yang akan diganti nama wajib diisi')
  const newName = c.req.query('name') ?? c.req.header('x-new-name')
  const overwrite = c.req.query('overwrite') === '1' || c.req.query('overwrite') === 'true'
  const result = await renameAtPath(storage, path, newName, overwrite)
  const urls = result.renamed.directory ? folderUrls(c, result.renamed.path) : fileUrls(c, result.renamed.path)
  return c.json({ ok: true, ...result, urls })
})

app.post('/folders/*', async (c) => {
  const storage = await getStorage()
  const path = requirePath(pathFromRequest(c, '/folders'), 'Path folder wajib diisi')
  const folder = await ensureFolder(storage, path)
  return c.json({ ok: true, folder: meta(folder), urls: folderUrls(c, path) }, 201)
})

// ---------- delete ----------

app.delete('/files/*', async (c) => {
  const storage = await getStorage()
  const path = requirePath(pathFromRequest(c, '/files'), 'Path yang akan dihapus wajib diisi')
  const permanent = c.req.query('permanent') === '1' || c.req.query('permanent') === 'true'
  return c.json({ ok: true, deleted: await deleteAtPath(storage, path, permanent) })
})

// ---------- view / download (streaming) ----------

async function streamFile(c, { attachment }) {
  const storage = await getStorage()
  const path = requirePath(pathFromRequest(c, attachment ? '/download' : '/view'), 'Path file wajib diisi')
  const node = findNode(storage, path)
  if (!node) throw new HttpError(404, `File tidak ditemukan: "${path}"`)
  if (node.directory) throw new HttpError(400, `"${path}" adalah folder`)

  const size = node.size ?? 0
  let range = null
  try {
    range = parseRange(c.req.header('range'), size)
  } catch (err) {
    if (err instanceof HttpError && err.status === 416) {
      return c.body(null, 416, { 'Content-Range': `bytes */${size}` })
    }
    throw err
  }

  const { stream } = openStream(storage, path, range)
  const type = contentTypeFor(node.name)
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    'X-Node-Id': node.nodeId ?? '',
  }

  if (attachment) {
    const ascii = node.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
    headers['Content-Disposition'] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(node.name)}`
  } else {
    headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(node.name)}`
    if (!isViewable(node.name)) {
      headers['X-Viewable'] = 'false'
    }
  }

  if (range) {
    const length = range.end - range.start + 1
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(length),
      },
    })
  }

  return new Response(stream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}

app.on(['GET', 'HEAD'], '/view/*', (c) => streamFile(c, { attachment: false }))
app.on(['GET', 'HEAD'], '/download/*', (c) => streamFile(c, { attachment: true }))

// ---------- error handling ----------

app.notFound((c) => c.json({ ok: false, error: `Route tidak dikenal: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404))

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500
  if (status >= 500) console.error('[error]', err)
  return c.json({ ok: false, error: err.message ?? 'Terjadi kesalahan' }, status)
})

const port = Number(process.env.PORT ?? 3000)

const server = Bun.serve({
  port,
  idleTimeout: 120,
  fetch: app.fetch,
})

console.log(`mega-drive-api jalan di ${server.url}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[mega] menerima ${signal}, menutup...`)
    await closeStorage()
    process.exit(0)
  })
}

// Named export (BUKAN default) supaya Bun tidak auto-serve dua kali:
// Bun otomatis memanggil Bun.serve() bila entry punya `export default` yang memiliki .fetch.
export { server }
