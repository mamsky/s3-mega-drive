// Smoke test S3 gateway: menandatangani request sendiri dengan SigV4,
// lalu menguji CRUD objek, list, range, copy, multipart, dan presigned URL.
//
// Jalankan: bun run s3:smoke
// Butuh server S3 hidup di S3_ENDPOINT (default http://127.0.0.1:3001) dan
// kredensial MEGA yang valid di env.local.
import { createHash, createHmac, randomUUID } from 'node:crypto'
import '../src/env.js'

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:3001'
const REGION = process.env.S3_REGION ?? 'us-east-1'
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID ?? ''
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY ?? ''
const BUCKET = process.env.S3_TEST_BUCKET ?? `smoke-${Date.now().toString(36)}`
const ALGORITHM = 'AWS4-HMAC-SHA256'

let passed = 0
let failed = 0

function ok(name, detail = '') {
  passed += 1
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}

function bad(name, detail = '') {
  failed += 1
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

function check(name, condition, detail = '') {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

function amzDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function uriEncode(value, encodeSlash = true) {
  let out = ''
  for (const ch of String(value ?? '')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch
    else if (ch === '/' && !encodeSlash) out += ch
    else for (const byte of Buffer.from(ch, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

function canonicalUri(pathname) {
  return (
    pathname
      .split('/')
      .map((segment) => uriEncode(decodeURIComponent(segment), false))
      .join('/') || '/'
  )
}

function canonicalQuery(search) {
  const params = [...new URLSearchParams(search ?? '')].map(([k, v]) => [uriEncode(k), uriEncode(v)])
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  return params.map(([k, v]) => `${k}=${v}`).join('&')
}

/** Kirim request bertanda tangan SigV4. */
async function signedFetch(method, path, { body = null, headers = {}, query = '' } = {}) {
  const url = new URL(path, ENDPOINT)
  if (query) url.search = query.startsWith('?') ? query : `?${query}`

  const payload = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body)
  const payloadHash = sha256Hex(payload)
  const stamp = amzDate()
  const dateStamp = stamp.slice(0, 8)
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`

  const allHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
  }
  if (payload.length > 0 && !allHeaders['content-length']) {
    allHeaders['content-length'] = String(payload.length)
  }

  const signedHeaderNames = Object.keys(allHeaders).sort()
  const signedHeaders = signedHeaderNames.join(';')
  const canonicalHeaders = `${signedHeaderNames.map((n) => `${n}:${String(allHeaders[n]).trim().replace(/\s+/g, ' ')}`).join('\n')}\n`

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), REGION), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  allHeaders.authorization =
    `${ALGORITHM} Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(url, {
    method,
    headers: allHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
  })
  return response
}

async function expectStatus(name, response, status) {
  if (response.status === status) {
    ok(name, `HTTP ${status}`)
    return true
  }
  const text = await response.text().catch(() => '')
  bad(name, `HTTP ${response.status} (diharapkan ${status}) ${text.slice(0, 200)}`)
  return false
}

/**
 * Buat presigned URL seperti yang dilakukan SDK di sisi klien.
 * Server hanya memverifikasi; tidak ada endpoint untuk membuatnya.
 */
function presignGet(path, expires = 300, date = new Date()) {
  const url = new URL(path, ENDPOINT)
  const stamp = amzDate(date)
  const dateStamp = stamp.slice(0, 8)
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`

  const params = new URLSearchParams({
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${ACCESS_KEY}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  })
  url.search = params.toString()

  const canonicalRequest = [
    'GET',
    canonicalUri(url.pathname),
    canonicalQuery(url.search),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), REGION), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  url.searchParams.set('X-Amz-Signature', signature)
  return url.toString()
}

function xmlValue(text, tag) {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? null
}

async function main() {
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY belum diisi (env.local). Test dibatalkan.')
    process.exit(1)
  }

  console.log(`\nS3 gateway smoke test — ${ENDPOINT}, bucket "${BUCKET}"\n`)

  // --- tanpa signature harus ditolak ---
  const unsigned = await fetch(`${ENDPOINT}/${BUCKET}/x.txt`)
  check('request tanpa signature ditolak', unsigned.status === 403, `HTTP ${unsigned.status}`)

  // --- signature salah harus ditolak ---
  const badSig = await fetch(`${ENDPOINT}/`, {
    headers: { authorization: 'AWS4-HMAC-SHA256 Credential=x/20250101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=deadbeef' },
  })
  check('signature salah ditolak', badSig.status === 403, `HTTP ${badSig.status}`)

  // --- ListBuckets ---
  const listBuckets = await signedFetch('GET', '/')
  if (await expectStatus('GET / (ListBuckets)', listBuckets, 200)) {
    const text = await listBuckets.text()
    check('respons ListBuckets berupa XML', text.includes('<ListAllMyBucketsResult'), text.slice(0, 60))
  }

  // --- buat bucket ---
  await expectStatus('PUT /bucket (CreateBucket)', await signedFetch('PUT', `/${BUCKET}`), 200)
  await expectStatus('HEAD /bucket (HeadBucket)', await signedFetch('HEAD', `/${BUCKET}`), 200)

  // --- PutObject ---
  const key = 'folder/gambar.txt'
  const content = Buffer.from(`halo dari smoke test ${randomUUID()}`)
  const put = await signedFetch('PUT', `/${BUCKET}/${key}`, {
    body: content,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
  const putOk = await expectStatus('PUT objek (PutObject)', put, 200)
  const putEtag = put.headers.get('etag')
  check('PutObject mengembalikan ETag', Boolean(putEtag), putEtag ?? 'tidak ada')

  // --- HeadObject ---
  const head = await signedFetch('HEAD', `/${BUCKET}/${key}`)
  if (await expectStatus('HEAD objek (HeadObject)', head, 200)) {
    check('HeadObject: Content-Length benar', head.headers.get('content-length') === String(content.length), head.headers.get('content-length'))
    check('HeadObject: Content-Type tersimpan', (head.headers.get('content-type') ?? '').includes('text/plain'), head.headers.get('content-type') ?? '')
    check('HeadObject: Accept-Ranges', head.headers.get('accept-ranges') === 'bytes')
  }

  // --- GetObject ---
  const get = await signedFetch('GET', `/${BUCKET}/${key}`)
  if (await expectStatus('GET objek (GetObject)', get, 200)) {
    const body = Buffer.from(await get.arrayBuffer())
    check('isi objek sama dengan yang diupload', body.equals(content), `${body.length} byte`)
  }

  // --- Range ---
  const ranged = await signedFetch('GET', `/${BUCKET}/${key}`, { headers: { range: 'bytes=0-4' } })
  if (await expectStatus('GET dengan Range', ranged, 206)) {
    const body = Buffer.from(await ranged.arrayBuffer())
    check('isi Range sesuai', body.toString() === content.subarray(0, 5).toString(), JSON.stringify(body.toString()))
    check('Content-Range benar', ranged.headers.get('content-range') === `bytes 0-4/${content.length}`, ranged.headers.get('content-range') ?? '')
  }

  const badRange = await signedFetch('GET', `/${BUCKET}/${key}`, { headers: { range: 'bytes=99999-' } })
  check('Range di luar ukuran -> 416', badRange.status === 416, `HTTP ${badRange.status}`)

  // --- metadata pengguna ---
  const keyMeta = 'folder/meta.txt'
  await signedFetch('PUT', `/${BUCKET}/${keyMeta}`, {
    body: Buffer.from('meta'),
    headers: { 'content-type': 'text/plain', 'x-amz-meta-nama': 'budi', 'cache-control': 'max-age=60' },
  })
  const headMeta = await signedFetch('HEAD', `/${BUCKET}/${keyMeta}`)
  check('custom metadata tersimpan', headMeta.headers.get('x-amz-meta-nama') === 'budi', headMeta.headers.get('x-amz-meta-nama') ?? '')
  check('Cache-Control tersimpan', headMeta.headers.get('cache-control') === 'max-age=60', headMeta.headers.get('cache-control') ?? '')

  // --- ListObjectsV2 ---
  const list = await signedFetch('GET', `/${BUCKET}`, { query: 'list-type=2&prefix=folder/' })
  if (await expectStatus('GET bucket (ListObjectsV2)', list, 200)) {
    const text = await list.text()
    const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1])
    check('ListObjectsV2 memuat objek yang diupload', keys.includes(key), keys.join(', '))
    check('ListObjectsV2 punya KeyCount', text.includes('<KeyCount>'))
  }

  // --- delimiter ---
  const delim = await signedFetch('GET', `/${BUCKET}`, { query: 'list-type=2&delimiter=/' })
  if (delim.status === 200) {
    const text = await delim.text()
    check('ListObjectsV2 delimiter memberi CommonPrefixes', text.includes('<CommonPrefixes>'), text.includes('folder/') ? 'folder/' : '')
  }

  // --- CopyObject ---
  const copyTarget = 'folder/salinan.txt'
  const copy = await signedFetch('PUT', `/${BUCKET}/${copyTarget}`, {
    headers: { 'x-amz-copy-source': `/${BUCKET}/${key}` },
  })
  if (await expectStatus('PUT dengan x-amz-copy-source (CopyObject)', copy, 200)) {
    const text = await copy.text()
    check('respons CopyObject berisi ETag', text.includes('<ETag>'), text.slice(0, 80))
  }
  const copied = await signedFetch('GET', `/${BUCKET}/${copyTarget}`)
  if (copied.status === 200) {
    const body = Buffer.from(await copied.arrayBuffer())
    check('hasil copy berisi data yang sama', body.equals(content))
  }

  // --- multipart upload ---
  const mpKey = 'folder/multipart.bin'
  const init = await signedFetch('POST', `/${BUCKET}/${mpKey}`, { query: 'uploads=' })
  let uploadId = null
  if (await expectStatus('POST ?uploads (CreateMultipartUpload)', init, 200)) {
    uploadId = xmlValue(await init.text(), 'UploadId')
    check('respons berisi UploadId', Boolean(uploadId), uploadId ?? '')
  }

  if (uploadId) {
    const part1 = Buffer.from('A'.repeat(64))
    const part2 = Buffer.from('B'.repeat(32))
    const p1 = await signedFetch('PUT', `/${BUCKET}/${mpKey}`, { query: `partNumber=1&uploadId=${uploadId}`, body: part1 })
    const p2 = await signedFetch('PUT', `/${BUCKET}/${mpKey}`, { query: `partNumber=2&uploadId=${uploadId}`, body: part2 })
    const e1 = p1.headers.get('etag')
    const e2 = p2.headers.get('etag')
    check('UploadPart 1 sukses', p1.status === 200, `HTTP ${p1.status}`)
    check('UploadPart 2 sukses', p2.status === 200, `HTTP ${p2.status}`)

    const listPartsRes = await signedFetch('GET', `/${BUCKET}/${mpKey}`, { query: `uploadId=${uploadId}` })
    if (listPartsRes.status === 200) {
      const text = await listPartsRes.text()
      check('ListParts menampilkan 2 part', (text.match(/<Part>/g) ?? []).length === 2, `${(text.match(/<Part>/g) ?? []).length} part`)
    }

    const completeBody =
      `<CompleteMultipartUpload>` +
      `<Part><PartNumber>1</PartNumber><ETag>${e1}</ETag></Part>` +
      `<Part><PartNumber>2</PartNumber><ETag>${e2}</ETag></Part>` +
      `</CompleteMultipartUpload>`

    const complete = await signedFetch('POST', `/${BUCKET}/${mpKey}`, {
      query: `uploadId=${uploadId}`,
      body: Buffer.from(completeBody),
    })
    if (await expectStatus('POST ?uploadId (CompleteMultipartUpload)', complete, 200)) {
      const text = await complete.text()
      check('respons Complete berisi Location', text.includes('<Location>'), text.slice(0, 80))
    }

    const merged = await signedFetch('GET', `/${BUCKET}/${mpKey}`)
    if (merged.status === 200) {
      const body = Buffer.from(await merged.arrayBuffer())
      check('hasil multipart = gabungan part', body.equals(Buffer.concat([part1, part2])), `${body.length} byte`)
    }
  }

  // --- presigned URL (dibuat di sisi klien, seperti SDK) ---
  const presigned = presignGet(`/${BUCKET}/${key}`, 300)
  const presignedGet = await fetch(presigned)
  if (presignedGet.status === 200) {
    const body = Buffer.from(await presignedGet.arrayBuffer())
    check('presigned GET berfungsi tanpa header', body.equals(content), `${body.length} byte`)
  } else {
    bad('presigned GET berfungsi tanpa header', `HTTP ${presignedGet.status} ${await presignedGet.text().catch(() => '')}`.slice(0, 200))
  }

  const expired = presignGet(`/${BUCKET}/${key}`, 1, new Date(Date.now() - 60_000))
  const expiredRes = await fetch(expired)
  check('presigned URL kedaluwarsa ditolak', expiredRes.status === 403, `HTTP ${expiredRes.status}`)

  // --- DeleteObjects batch ---
  const deleteBody =
    `<Delete><Object><Key>${key}</Key></Object><Object><Key>${copyTarget}</Key></Object><Object><Key>tidak-ada.txt</Key></Object></Delete>`
  const bulk = await signedFetch('POST', `/${BUCKET}`, { query: 'delete=', body: Buffer.from(deleteBody) })
  if (await expectStatus('POST ?delete (DeleteObjects)', bulk, 200)) {
    const text = await bulk.text()
    check('DeleteObjects melaporkan 3 key terhapus', (text.match(/<Deleted>/g) ?? []).length === 3, `${(text.match(/<Deleted>/g) ?? []).length} deleted`)
  }

  const afterDelete = await signedFetch('HEAD', `/${BUCKET}/${key}`)
  check('objek yang dihapus -> 404', afterDelete.status === 404, `HTTP ${afterDelete.status}`)

  // --- DELETE objek yang tidak ada tetap 204 ---
  const deleteMissing = await signedFetch('DELETE', `/${BUCKET}/tidak-ada.txt`)
  check('DELETE key tidak ada tetap 204', deleteMissing.status === 204, `HTTP ${deleteMissing.status}`)

  // --- hapus isi bucket lalu bucket ---
  const remaining = await signedFetch('GET', `/${BUCKET}`, { query: 'list-type=2' })
  const remainingText = await remaining.text()
  const remainingKeys = [...remainingText.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1])
  if (remainingKeys.length > 0) {
    const body = `<Delete>${remainingKeys.map((k) => `<Object><Key>${k}</Key></Object>`).join('')}</Delete>`
    await signedFetch('POST', `/${BUCKET}`, { query: 'delete=', body: Buffer.from(body) })
  }
  await expectStatus('DELETE bucket kosong', await signedFetch('DELETE', `/${BUCKET}`), 204)

  console.log(`\n${passed} lulus, ${failed} gagal\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nSmoke test error:', err)
  process.exit(1)
})
