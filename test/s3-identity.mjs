// Uji isolasi identitas S3: dua access key tidak boleh saling melihat/menyentuh data.
//
// Jalankan:
//   S3_PORT=3101 S3_IDENTITIES_FILE=s3-identities.test.json bun run src/s3/server.js
//   S3_ENDPOINT=http://127.0.0.1:3101 S3_IDENTITIES_FILE=s3-identities.test.json bun run test/s3-identity.mjs
import { createHash, createHmac, randomUUID } from 'node:crypto'

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:3101'
const REGION = process.env.S3_REGION ?? 'us-east-1'
const ALGORITHM = 'AWS4-HMAC-SHA256'

// Harus sama dengan isi s3-identities.test.json yang dipakai server.
const ALICE = { name: 'alice', accessKeyId: 'AKIAALICE000000000001', secretAccessKey: 'rahasia-alice-yang-panjang' }
const BOB = { name: 'bob', accessKeyId: 'AKIABOB000000000000002', secretAccessKey: 'rahasia-bob-yang-panjang' }
const BUCKET = `isolasi-${Date.now().toString(36)}`

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

async function signedFetch(identity, method, path, { body = null, headers = {}, query = '' } = {}) {
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
  if (payload.length > 0 && !allHeaders['content-length']) allHeaders['content-length'] = String(payload.length)

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
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${identity.secretAccessKey}`, dateStamp), REGION), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  allHeaders.authorization =
    `${ALGORITHM} Credential=${identity.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return fetch(url, {
    method,
    headers: allHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
  })
}

function xmlValue(text, tag) {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? null
}

async function main() {
  console.log(`\nUji isolasi identitas — ${ENDPOINT}, bucket "${BUCKET}"\n`)

  const key = 'rahasia/alice.txt'
  const aliceContent = Buffer.from(`data milik alice ${randomUUID()}`)

  // --- alice menulis ---
  await signedFetch(ALICE, 'PUT', `/${BUCKET}`)
  const put = await signedFetch(ALICE, 'PUT', `/${BUCKET}/${key}`, { body: aliceContent })
  check('alice bisa upload', put.status === 200, `HTTP ${put.status}`)

  // --- alice melihat bucketnya ---
  const aliceBuckets = await signedFetch(ALICE, 'GET', '/')
  const aliceBucketsText = await aliceBuckets.text()
  check('alice melihat bucket-nya sendiri', aliceBucketsText.includes(`<Name>${BUCKET}</Name>`), BUCKET)

  // --- bob TIDAK melihat bucket alice ---
  const bobBuckets = await signedFetch(BOB, 'GET', '/')
  const bobBucketsText = await bobBuckets.text()
  check(
    'bob tidak melihat bucket alice di ListBuckets',
    !bobBucketsText.includes(`<Name>${BUCKET}</Name>`),
    bobBucketsText.includes(`<Name>${BUCKET}</Name>`) ? 'BOCOR' : 'aman'
  )

  // --- bob TIDAK bisa baca objek alice ---
  const bobGet = await signedFetch(BOB, 'GET', `/${BUCKET}/${key}`)
  check('bob tidak bisa GET objek alice', bobGet.status === 404, `HTTP ${bobGet.status}`)

  // --- bob TIDAK bisa HEAD objek alice ---
  const bobHead = await signedFetch(BOB, 'HEAD', `/${BUCKET}/${key}`)
  check('bob tidak bisa HEAD objek alice', bobHead.status === 404, `HTTP ${bobHead.status}`)

  // --- bob tidak bisa list isi bucket alice (bucket dianggap tidak ada) ---
  const bobList = await signedFetch(BOB, 'GET', `/${BUCKET}`, { query: 'list-type=2' })
  check('bob tidak bisa list bucket alice', bobList.status === 404, `HTTP ${bobList.status}`)

  // --- bob tidak bisa hapus objek alice ---
  const bobDelete = await signedFetch(BOB, 'DELETE', `/${BUCKET}/${key}`)
  check('bob tidak bisa DELETE objek alice', bobDelete.status === 404, `HTTP ${bobDelete.status}`)

  // --- objek alice masih utuh ---
  const aliceGet = await signedFetch(ALICE, 'GET', `/${BUCKET}/${key}`)
  if (aliceGet.status === 200) {
    const body = Buffer.from(await aliceGet.arrayBuffer())
    check('objek alice tetap utuh setelah percobaan bob', body.equals(aliceContent), `${body.length} byte`)
  } else {
    bad('objek alice tetap utuh setelah percobaan bob', `HTTP ${aliceGet.status}`)
  }

  // --- bucket sama, key sama, isi berbeda: tidak boleh saling menimpa ---
  const bobContent = Buffer.from(`data milik bob ${randomUUID()}`)
  const bobPut = await signedFetch(BOB, 'PUT', `/${BUCKET}/${key}`, { body: bobContent })
  check('bob bisa memakai nama bucket+key yang sama', bobPut.status === 200, `HTTP ${bobPut.status}`)

  const aliceAgain = await signedFetch(ALICE, 'GET', `/${BUCKET}/${key}`)
  if (aliceAgain.status === 200) {
    const body = Buffer.from(await aliceAgain.arrayBuffer())
    check('isi alice tidak tertimpa bob', body.equals(aliceContent), `${body.length} byte`)
  } else {
    bad('isi alice tidak tertimpa bob', `HTTP ${aliceAgain.status}`)
  }

  const bobGet2 = await signedFetch(BOB, 'GET', `/${BUCKET}/${key}`)
  if (bobGet2.status === 200) {
    const body = Buffer.from(await bobGet2.arrayBuffer())
    check('bob membaca datanya sendiri', body.equals(bobContent), `${body.length} byte`)
  } else {
    bad('bob membaca datanya sendiri', `HTTP ${bobGet2.status}`)
  }

  // --- multipart milik alice tidak bisa dipakai bob ---
  const init = await signedFetch(ALICE, 'POST', `/${BUCKET}/mp.bin`, { query: 'uploads=' })
  const uploadId = init.status === 200 ? xmlValue(await init.text(), 'UploadId') : null
  check('alice bisa mulai multipart', Boolean(uploadId), uploadId ?? `HTTP ${init.status}`)

  if (uploadId) {
    const bobPart = await signedFetch(BOB, 'PUT', `/${BUCKET}/mp.bin`, {
      query: `partNumber=1&uploadId=${uploadId}`,
      body: Buffer.from('X'.repeat(16)),
    })
    check('bob tidak bisa UploadPart ke upload alice', bobPart.status === 404, `HTTP ${bobPart.status}`)

    const bobAbort = await signedFetch(BOB, 'DELETE', `/${BUCKET}/mp.bin`, { query: `uploadId=${uploadId}` })
    check('bob tidak bisa AbortMultipartUpload milik alice', bobAbort.status === 404, `HTTP ${bobAbort.status}`)

    const bobListParts = await signedFetch(BOB, 'GET', `/${BUCKET}/mp.bin`, { query: `uploadId=${uploadId}` })
    check('bob tidak bisa ListParts upload alice', bobListParts.status === 404, `HTTP ${bobListParts.status}`)

    const aliceAbort = await signedFetch(ALICE, 'DELETE', `/${BUCKET}/mp.bin`, { query: `uploadId=${uploadId}` })
    check('alice tetap bisa abort upload-nya sendiri', aliceAbort.status === 204, `HTTP ${aliceAbort.status}`)
  }

  // --- bob tidak bisa menghapus bucket bernama sama milik alice ---
  // Bucket bob sudah berisi objeknya sendiri, jadi jawabannya BucketNotEmpty (409),
  // bukan NoSuchBucket. Yang penting: data alice tidak ikut terhapus.
  const bobDeleteBucket = await signedFetch(BOB, 'DELETE', `/${BUCKET}`)
  check('bob tidak bisa menghapus bucket alice', bobDeleteBucket.status === 409, `HTTP ${bobDeleteBucket.status}`)

  const aliceSurvives = await signedFetch(ALICE, 'GET', `/${BUCKET}/${key}`)
  if (aliceSurvives.status === 200) {
    const body = Buffer.from(await aliceSurvives.arrayBuffer())
    check('data alice selamat dari DELETE bucket oleh bob', body.equals(aliceContent), `${body.length} byte`)
  } else {
    bad('data alice selamat dari DELETE bucket oleh bob', `HTTP ${aliceSurvives.status}`)
  }

  // --- bereskan: hapus objek alice + bob, lalu bucketnya ---
  await signedFetch(ALICE, 'DELETE', `/${BUCKET}/${key}`)
  await signedFetch(BOB, 'DELETE', `/${BUCKET}/${key}`)
  const aliceDeleteBucket = await signedFetch(ALICE, 'DELETE', `/${BUCKET}`)
  check('alice bisa hapus bucket kosong miliknya', aliceDeleteBucket.status === 204, `HTTP ${aliceDeleteBucket.status}`)
  const bobDeleteBucket2 = await signedFetch(BOB, 'DELETE', `/${BUCKET}`)
  check('bob bisa hapus bucket kosong miliknya', bobDeleteBucket2.status === 204, `HTTP ${bobDeleteBucket2.status}`)

  console.log(`\n${passed} lulus, ${failed} gagal\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nUji isolasi error:', err)
  process.exit(1)
})
