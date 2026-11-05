// Entry point S3 gateway. Jalankan: bun run s3
import { app, config } from './app.js'
import { closeStorage } from '../mega.js'
import { closeDb, dbEnabled, initSchema } from '../db.js'
import { identities, isConfigured, loadIdentities } from './identities.js'
import { sweepStaleUploads } from './multipart.js'

// Database disiapkan dulu supaya identitas & metadata sudah siap sebelum
// request pertama masuk. Tanpa DATABASE_URL semua ini jatuh ke mode file.
if (dbEnabled) {
  await initSchema()
  console.log('[s3] database tersambung, skema siap')
}

await loadIdentities()

const removed = await sweepStaleUploads()
if (removed > 0) console.log(`[s3] ${removed} multipart upload basi dibersihkan`)

if (!isConfigured) {
  console.warn(
    '[s3] PERINGATAN: belum ada identitas S3.\n' +
      '      Isi tabel "identities" di database, atau s3-identities.local.json,\n' +
      '      atau S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY di env.local.\n' +
      '      Semua request akan ditolak dengan InvalidAccessKeyId sampai salah satunya diisi.'
  )
}

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  idleTimeout: 255,
  maxRequestBodySize: Number(process.env.S3_MAX_BODY_BYTES ?? 5 * 1024 * 1024 * 1024),
  fetch: app.fetch,
})

console.log(`mega-drive S3 gateway jalan di http://${config.hostname}:${config.port} (region ${config.region})`)
for (const identity of identities) {
  console.log(`  - identitas "${identity.name}" -> folder MEGA ${identity.root}/`)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[s3] menerima ${signal}, menutup...`)
    await closeStorage()
    await closeDb()
    process.exit(0)
  })
}

export { server }
