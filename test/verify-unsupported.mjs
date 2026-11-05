// Verifikasi klaim dokumentasi: operasi yang ditandai "tidak didukung" harus balas 501.
import { createHash, createHmac } from 'node:crypto'

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:3001'
const REGION = process.env.S3_REGION ?? 'us-east-1'
const AK = process.env.S3_ACCESS_KEY_ID ?? ''
const SK = process.env.S3_SECRET_ACCESS_KEY ?? ''

const sha = (b) => createHash('sha256').update(b).digest('hex')
const hm = (k, d) => createHmac('sha256', k).update(d).digest()
const enc = (v) => {
  let o = ''
  for (const c of String(v)) {
    if (/[A-Za-z0-9\-._~]/.test(c)) o += c
    else if (c === '/') o += c
    else for (const b of Buffer.from(c)) o += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return o
}

async function req(method, path, q = '') {
  const url = new URL(path + (q ? `?${q}` : ''), ENDPOINT)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const ds = stamp.slice(0, 8)
  const scope = `${ds}/${REGION}/s3/aws4_request`
  const ph = sha(Buffer.alloc(0))
  const h = { host: url.host, 'x-amz-content-sha256': ph, 'x-amz-date': stamp }
  const names = Object.keys(h).sort()
  const sh = names.join(';')
  const ch = `${names.map((n) => `${n}:${h[n]}`).join('\n')}\n`
  const cq = [...new URLSearchParams(url.search)]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const cr = [method, url.pathname, cq, ch, sh, ph].join('\n')
  const sts = ['AWS4-HMAC-SHA256', stamp, scope, sha(cr)].join('\n')
  const sk = hm(hm(hm(hm(`AWS4${SK}`, ds), REGION), 's3'), 'aws4_request')
  h.authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${sh}, Signature=${createHmac('sha256', sk).update(sts).digest('hex')}`
  return fetch(url, { method, headers: h })
}

const B = `verif-${Date.now().toString(36)}`
console.log('CreateBucket:', (await req('PUT', `/${B}`)).status)

const cases = [
  ['PUT ?tagging', 'PUT', `/${B}`, 'tagging='],
  ['GET ?policy', 'GET', `/${B}`, 'policy='],
  ['PUT ?lifecycle', 'PUT', `/${B}`, 'lifecycle='],
  ['GET ?encryption', 'GET', `/${B}`, 'encryption='],
  ['GET ?logging', 'GET', `/${B}`, 'logging='],
  ['GET ?notification', 'GET', `/${B}`, 'notification='],
  ['GET ?website', 'GET', `/${B}`, 'website='],
  ['POST ?select', 'POST', `/${B}/k.txt`, 'select=&select-type=2'],
]

for (const [name, method, path, query] of cases) {
  const res = await req(method, path, query)
  console.log(`${name.padEnd(22)} -> ${res.status}`)
}

console.log('DeleteBucket:', (await req('DELETE', `/${B}`)).status)
