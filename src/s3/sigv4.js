// Verifikasi AWS Signature Version 4 (header Authorization maupun presigned URL).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { S3Error } from './errors.js'

const ALGORITHM = 'AWS4-HMAC-SHA256'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/** URI-encode sesuai aturan SigV4: hanya A-Z a-z 0-9 - . _ ~ yang dibiarkan. */
export function uriEncode(value, encodeSlash = true) {
  let out = ''
  for (const ch of String(value ?? '')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch
    } else if (ch === '/' && !encodeSlash) {
      out += ch
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
    }
  }
  return out
}

/**
 * Canonical URI: tiap segmen path di-decode lalu di-encode ulang supaya bentuknya
 * konsisten, tanpa meng-encode "/" (khusus S3, path tidak di-double-encode).
 */
export function canonicalUri(pathname) {
  const raw = pathname && pathname.startsWith('/') ? pathname : `/${pathname ?? ''}`
  const encoded = raw
    .split('/')
    .map((segment) => {
      let decoded = segment
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        // biarkan apa adanya kalau bukan percent-encoding valid
      }
      return uriEncode(decoded, false)
    })
    .join('/')
  return encoded === '' ? '/' : encoded
}

/** Canonical query string: diurutkan berdasarkan nama lalu nilai. */
export function canonicalQuery(search, exclude = []) {
  const params = []
  for (const [key, value] of new URLSearchParams(search ?? '')) {
    if (exclude.includes(key)) continue
    params.push([uriEncode(key, true), uriEncode(value, true)])
  }
  params.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
    if (a[1] === b[1]) return 0
    return a[1] < b[1] ? -1 : 1
  })
  return params.map(([key, value]) => `${key}=${value}`).join('&')
}

function normalizeHeaderValue(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

export function canonicalHeaders(headers, signedHeaders) {
  const names = String(signedHeaders ?? '')
    .split(';')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .sort()
  return `${names.map((name) => `${name}:${normalizeHeaderValue(headers[name])}`).join('\n')}\n`
}

/** "20250101T120000Z" -> epoch ms */
function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value ?? '').trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
}

function parseCredentialScope(credential) {
  const parts = String(credential ?? '').split('/')
  if (parts.length !== 5) return null
  const [accessKeyId, dateStamp, region, service, terminator] = parts
  return { accessKeyId, dateStamp, region, service, terminator }
}

function splitAuthorization(header) {
  const match = /^AWS4-HMAC-SHA256\s+(.+)$/i.exec(String(header ?? '').trim())
  if (!match) return null
  const fields = {}
  for (const piece of match[1].split(',')) {
    const index = piece.indexOf('=')
    if (index === -1) continue
    fields[piece.slice(0, index).trim()] = piece.slice(index + 1).trim()
  }
  return fields
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Verifikasi signature sebuah request.
 * @param {Request} request
 * @param {{maxClockSkew:number, identities:Array<{name:string, accessKeyId:string, secretAccessKey:string, root:string}>}} config
 * @returns {{presigned:boolean, signedHeaders:string, payloadHash:string, streaming:boolean, identity:object}}
 */
export function authenticate(request, config, now = Date.now()) {
  if (!config.identities || config.identities.length === 0) {
    throw new S3Error(
      'InvalidAccessKeyId',
      'Belum ada identitas S3. Isi tabel "identities" di database, atau s3-identities.local.json, atau S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY di env.local.'
    )
  }

  const url = new URL(request.url)
  const headers = {}
  for (const [key, value] of request.headers) headers[key.toLowerCase()] = value
  if (!headers.host) headers.host = url.host

  const authorization = headers.authorization
  const presigned = url.searchParams.has('X-Amz-Signature')

  let credential
  let signedHeaders
  let signature
  let amzDate

  if (authorization) {
    const fields = splitAuthorization(authorization)
    if (!fields) {
      throw new S3Error('AuthorizationHeaderMalformed', 'Header Authorization bukan AWS4-HMAC-SHA256')
    }
    credential = fields.Credential
    signedHeaders = fields.SignedHeaders
    signature = fields.Signature
    amzDate = headers['x-amz-date'] ?? headers.date
  } else if (presigned) {
    credential = url.searchParams.get('X-Amz-Credential')
    signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')
    signature = url.searchParams.get('X-Amz-Signature')
    amzDate = url.searchParams.get('X-Amz-Date')

    const algorithm = url.searchParams.get('X-Amz-Algorithm')
    if (algorithm && algorithm !== ALGORITHM) {
      throw new S3Error('AuthorizationHeaderMalformed', `Algoritma tidak didukung: ${algorithm}`)
    }
  } else {
    throw new S3Error(
      'AccessDenied',
      'Permintaan tanpa signature AWS SigV4. Isi S3_ACCESS_KEY_ID dan S3_SECRET_ACCESS_KEY di sisi klien.'
    )
  }

  const scope = parseCredentialScope(credential)
  if (!scope) {
    throw new S3Error('AuthorizationHeaderMalformed', 'Credential harus berbentuk AKID/YYYYMMDD/region/s3/aws4_request')
  }
  if (scope.terminator !== 'aws4_request' || scope.service !== 's3') {
    throw new S3Error('AuthorizationHeaderMalformed', 'Scope credential harus diakhiri "/s3/aws4_request"')
  }
  const identity = config.identities.find((item) => safeEqual(scope.accessKeyId, item.accessKeyId))
  if (!identity) {
    throw new S3Error('InvalidAccessKeyId', `Access key tidak dikenal: ${scope.accessKeyId}`)
  }
  if (!signedHeaders || !signature || !amzDate) {
    throw new S3Error('AuthorizationHeaderMalformed', 'SignedHeaders, Signature, dan x-amz-date wajib ada')
  }

  const signedAt = parseAmzDate(amzDate)
  if (signedAt === null) {
    throw new S3Error('AuthorizationHeaderMalformed', 'Format x-amz-date harus YYYYMMDDTHHMMSSZ')
  }
  const skewMs = Math.abs(now - signedAt)
  if (config.maxClockSkew > 0 && skewMs > config.maxClockSkew * 1000) {
    throw new S3Error(
      'RequestTimeTooSkewed',
      `Selisih waktu request ${Math.round(skewMs / 1000)}s melebihi batas ${config.maxClockSkew}s`
    )
  }

  if (presigned) {
    const expires = Number(url.searchParams.get('X-Amz-Expires') ?? '0')
    if (!Number.isFinite(expires) || expires <= 0 || expires > 604800) {
      throw new S3Error('AuthorizationHeaderMalformed', 'X-Amz-Expires harus 1-604800 detik')
    }
    if (now > signedAt + expires * 1000) {
      throw new S3Error('AccessDenied', 'Presigned URL sudah kedaluwarsa')
    }
  }

  const payloadHash = headers['x-amz-content-sha256'] ?? (presigned ? 'UNSIGNED-PAYLOAD' : EMPTY_SHA256)
  const streaming = String(payloadHash).startsWith('STREAMING-')

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.search, presigned ? ['X-Amz-Signature'] : []),
    canonicalHeaders(headers, signedHeaders),
    String(signedHeaders).split(';').map((n) => n.trim().toLowerCase()).filter(Boolean).sort().join(';'),
    payloadHash,
  ].join('\n')

  const credentialScope = `${scope.dateStamp}/${scope.region}/${scope.service}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${identity.secretAccessKey}`, scope.dateStamp), scope.region), scope.service),
    'aws4_request'
  )
  const expected = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  if (!safeEqual(expected, signature)) {
    throw new S3Error(
      'SignatureDoesNotMatch',
      `Signature tidak cocok untuk identitas "${identity.name}". Periksa secretAccessKey, S3_REGION, dan jam sistem.`
    )
  }

  return { presigned, signedHeaders, payloadHash, streaming, identity }
}
