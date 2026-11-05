// Sesi login UI: token acak di memori + cookie HttpOnly, password dicek timing-safe.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const COOKIE = 'md_session'
const TTL_MS = 1000 * 60 * 60 * 12
const MAX_ATTEMPTS = 5
const WINDOW_MS = 1000 * 60 * 15

const sessions = new Map()
const attempts = new Map()

// Secret hanya hidup selama proses; restart server = semua sesi logout.
const SECRET = process.env.S3_UI_SECRET?.trim() || randomBytes(32).toString('hex')

function sign(token) {
  return createHmac('sha256', SECRET).update(token).digest('hex')
}

function equal(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function parseCookies(header) {
  const jar = {}
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    try {
      jar[key] = decodeURIComponent(value)
    } catch {
      jar[key] = value
    }
  }
  return jar
}

/**
 * Cocokkan nama + password ke salah satu identitas.
 * Password disimpan sebagai hash (Bun.password) saat memakai database;
 * identitas tanpa password tidak bisa login ke console.
 */
export async function checkCredentials(identities, name, password) {
  const target = String(name ?? '').trim().toLowerCase()
  const identity = identities.find((item) => item.name === target)
  if (!identity || !identity.passwordHash) return null
  const ok = await Bun.password.verify(String(password ?? ''), identity.passwordHash).catch(() => false)
  return ok ? identity : null
}

export function tooManyAttempts(ip) {
  const record = attempts.get(ip)
  if (!record) return false
  if (Date.now() - record.since > WINDOW_MS) {
    attempts.delete(ip)
    return false
  }
  return record.count >= MAX_ATTEMPTS
}

export function noteFailure(ip) {
  const now = Date.now()
  const record = attempts.get(ip)
  if (!record || now - record.since > WINDOW_MS) {
    attempts.set(ip, { count: 1, since: now })
    return
  }
  record.count += 1
}

export function clearFailures(ip) {
  attempts.delete(ip)
}

export function createSession(identity) {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { identityName: identity.name, expiresAt: Date.now() + TTL_MS })
  return token
}

export function sessionCookie(token) {
  const value = `${token}.${sign(token)}`
  const maxAge = Math.floor(TTL_MS / 1000)
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

/** Ambil identitas dari cookie sesi. Return null kalau tidak valid / kedaluwarsa. */
export function currentIdentity(request, identities) {
  const jar = parseCookies(request.headers.get('cookie'))
  const raw = jar[COOKIE]
  if (!raw) return null

  const index = raw.lastIndexOf('.')
  if (index < 0) return null
  const token = raw.slice(0, index)
  const signature = raw.slice(index + 1)
  if (!equal(sign(token), signature)) return null

  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    sessions.delete(token)
    return null
  }
  return identities.find((item) => item.name === session.identityName) ?? null
}

export function destroySession(request) {
  const jar = parseCookies(request.headers.get('cookie'))
  const raw = jar[COOKIE]
  if (!raw) return
  sessions.delete(raw.slice(0, raw.lastIndexOf('.')))
}

export function sweepSessions() {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token)
  }
  for (const [ip, record] of attempts) {
    if (now - record.since > WINDOW_MS) attempts.delete(ip)
  }
}

export { COOKIE }
