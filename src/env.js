// Muat file env.local (format KEY=VALUE) ke process.env. Env yang sudah ada tidak ditimpa.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_PATH = join(import.meta.dir, '..', 'env.local')

if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const separator = text.indexOf('=')
    if (separator < 1) continue
    const key = text.slice(0, separator).trim()
    const value = text
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1')
    if (key && !process.env[key]) process.env[key] = value
  }
}
