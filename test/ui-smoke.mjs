// Uji web console: login, isolasi per identitas, dan CRUD file.
// Butuh server console jalan dengan s3-identities.test.json.
const BASE = process.env.UI_ENDPOINT ?? 'http://127.0.0.1:3302'
const ALICE = { name: 'alice', password: 'password-alice' }
const BOB = { name: 'bob', password: 'password-bob' }

let pass = 0
let fail = 0

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(path, { method = 'GET', body, cookie, raw = false } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (body && !(body instanceof FormData)) headers['content-type'] = 'application/json'

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  })

  const setCookie = response.headers.get('set-cookie')
  if (raw) return { status: response.status, response }

  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text, setCookie }
}

function cookieOf(setCookie) {
  return setCookie ? setCookie.split(';')[0] : ''
}

async function login(who) {
  const result = await call('/api/login', { method: 'POST', body: who })
  return { status: result.status, cookie: cookieOf(result.setCookie) }
}

async function upload(cookie, bucket, prefix, filename, content) {
  const form = new FormData()
  form.append('bucket', bucket)
  form.append('prefix', prefix)
  form.append('file', new Blob([content]), filename)
  return call('/api/upload', { method: 'POST', body: form, cookie })
}

console.log(`Uji console di ${BASE}\n`)

console.log('Akses tanpa login')
{
  const me = await call('/api/me')
  check('GET /api/me tanpa cookie ditolak', me.status === 401, `HTTP ${me.status}`)

  const browse = await call('/api/browse')
  check('GET /api/browse tanpa cookie ditolak', browse.status === 401, `HTTP ${browse.status}`)

  const page = await call('/', { raw: true })
  check('halaman login bisa diakses tanpa cookie', page.status === 200, `HTTP ${page.status}`)
}

console.log('\nLogin')
{
  const wrong = await login({ name: 'alice', password: 'password-salah' })
  check('password salah ditolak', wrong.status === 401, `HTTP ${wrong.status}`)

  const unknown = await login({ name: 'tidak-ada', password: 'apa-saja' })
  check('identitas tidak dikenal ditolak', unknown.status === 401, `HTTP ${unknown.status}`)

  const ok = await login(ALICE)
  check('login benar diterima', ok.status === 200, `HTTP ${ok.status}`)
  check('cookie sesi diberikan', ok.cookie.startsWith('md_session='), ok.cookie)
}

const alice = cookieOf((await call('/api/login', { method: 'POST', body: ALICE })).setCookie)
const bob = cookieOf((await call('/api/login', { method: 'POST', body: BOB })).setCookie)

console.log('\nConfig yang dikirim ke klien')
{
  const me = await call('/api/me', { cookie: alice })
  check('nama identitas benar', me.json?.name === 'alice', me.json?.name)
  check('access key milik sendiri', me.json?.accessKeyId === 'AKIAALICE000000000001', me.json?.accessKeyId)
  check('root MEGA benar', me.json?.root === 's3/alice', me.json?.root)
  check('endpoint menunjuk ke gateway S3, bukan console', /:3001$|:3201$|:3101$/.test(me.json?.endpoint ?? ''), me.json?.endpoint)
  check('region terisi', Boolean(me.json?.region), me.json?.region)
}

console.log('\nFile browser')
{
  const created = await call('/api/bucket', { method: 'POST', body: { name: 'uji-console' }, cookie: alice })
  check('buat bucket', created.status === 200, `HTTP ${created.status}`)

  const folder = await call('/api/folder', {
    method: 'POST',
    body: { bucket: 'uji-console', prefix: '', name: 'produk' },
    cookie: alice,
  })
  check('buat folder', folder.status === 200, `HTTP ${folder.status}`)

  const uploaded = await upload(alice, 'uji-console', 'produk', 'catatan.txt', 'isi dari console')
  check('upload file', uploaded.status === 200, `HTTP ${uploaded.status}`)
  check('key hasil upload benar', uploaded.json?.key === 'produk/catatan.txt', uploaded.json?.key)

  const listing = await call('/api/browse?bucket=uji-console&prefix=produk', { cookie: alice })
  const names = (listing.json?.objects ?? []).map((item) => item.name)
  check('file muncul di daftar', names.includes('catatan.txt'), names.join(','))
  check('ukuran file tercatat', listing.json?.objects?.[0]?.size === 16, String(listing.json?.objects?.[0]?.size))

  const download = await call('/api/download?bucket=uji-console&key=produk/catatan.txt', {
    cookie: alice,
    raw: true,
  })
  const body = await download.response.text()
  check('download mengembalikan isi yang sama', body === 'isi dari console', body)
  check('download sebagai attachment', (download.response.headers.get('content-disposition') ?? '').includes('attachment'))

  const folderListing = await call('/api/browse?bucket=uji-console', { cookie: alice })
  check('folder terlihat di root bucket', (folderListing.json?.folders ?? []).some((item) => item.name === 'produk'))
}

console.log('\nIsolasi antar identitas')
{
  const bobBuckets = await call('/api/browse', { cookie: bob })
  const names = (bobBuckets.json?.buckets ?? []).map((item) => item.name)
  check('bob tidak melihat bucket alice', !names.includes('uji-console'), names.join(','))

  const bobOpen = await call('/api/browse?bucket=uji-console', { cookie: bob })
  check('bob tidak bisa membuka bucket alice', bobOpen.status === 404, `HTTP ${bobOpen.status}`)

  const bobDownload = await call('/api/download?bucket=uji-console&key=produk/catatan.txt', { cookie: bob })
  check('bob tidak bisa mengunduh file alice', bobDownload.status === 404, `HTTP ${bobDownload.status}`)

  const bobDelete = await call('/api/delete', {
    method: 'POST',
    body: { bucket: 'uji-console', key: 'produk/catatan.txt' },
    cookie: bob,
  })
  check('bob tidak bisa menghapus file alice', bobDelete.status === 404, `HTTP ${bobDelete.status}`)

  const stillThere = await call('/api/browse?bucket=uji-console&prefix=produk', { cookie: alice })
  check('data alice tetap utuh', (stillThere.json?.objects ?? []).length === 1)
}

console.log('\nHapus')
{
  const del = await call('/api/delete', {
    method: 'POST',
    body: { bucket: 'uji-console', key: 'produk/catatan.txt' },
    cookie: alice,
  })
  check('hapus file', del.status === 200, `HTTP ${del.status}`)

  const delFolder = await call('/api/delete', {
    method: 'POST',
    body: { bucket: 'uji-console', key: 'produk', folder: true },
    cookie: alice,
  })
  check('hapus folder', delFolder.status === 200, `HTTP ${delFolder.status}`)

  const delBucket = await call('/api/bucket?name=uji-console', { method: 'DELETE', cookie: alice })
  check('hapus bucket kosong', delBucket.status === 200, `HTTP ${delBucket.status}`)

  const final = await call('/api/browse', { cookie: alice })
  check('tidak ada sisa bucket', (final.json?.buckets ?? []).length === 0)
}

console.log('\nLogout')
{
  const out = await call('/api/logout', { method: 'POST', cookie: alice })
  check('logout diterima', out.status === 200, `HTTP ${out.status}`)

  const me = await call('/api/me', { cookie: alice })
  check('sesi tidak berlaku setelah logout', me.status === 401, `HTTP ${me.status}`)
}

console.log(`\n${pass} lulus, ${fail} gagal`)
process.exit(fail === 0 ? 0 : 1)
