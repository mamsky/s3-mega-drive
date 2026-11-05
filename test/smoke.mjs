#!/usr/bin/env bun
// Smoke test mega-drive-api.
// Server di-import langsung (in-process) supaya test bisa memanggil server.stop() sendiri.
// 1) Unit test mime. 2) Uji routing & error handling. 3) E2E penuh bila kredensial MEGA tersedia.
const root = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.SMOKE_PORT ?? 4599)
process.env.PORT = String(PORT)
const base = `http://localhost:${PORT}`

const { contentTypeFor, isViewable } = await import(new URL('../src/mime.js', import.meta.url))
const { server } = await import(new URL('../src/server.js', import.meta.url))
const { closeStorage } = await import(new URL('../src/mega.js', import.meta.url))
const sharp = (await import('sharp')).default

const encoder = new TextEncoder()

let pass = 0
let fail = 0

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`)
  }
}

async function finish(code) {
  try {
    await closeStorage()
  } catch {
    // belum pernah login, tidak ada yang ditutup
  }
  server.stop(true)
  console.log(`\n===== ${pass} PASS, ${fail} FAIL =====`)
  process.exit(code)
}

console.log('[unit] mime')
check('jpg (huruf besar) -> image/jpeg', contentTypeFor('foto.JPG') === 'image/jpeg')
check('mp4 -> video/mp4', contentTypeFor('video/klip.mp4') === 'video/mp4')
check('pdf -> application/pdf', contentTypeFor('laporan.pdf') === 'application/pdf')
check('ekstensi tak dikenal -> octet-stream', contentTypeFor('data.zzz') === 'application/octet-stream')
check('tanpa ekstensi -> octet-stream', contentTypeFor('README') === 'application/octet-stream')
check('isViewable(pdf)', isViewable('a.pdf'))
check('isViewable(txt) = false', !isViewable('catatan.txt'))

console.log(`\n[server] terikat di port ${server.port} (root: ${root.trim()})`)
check('server siap menerima request', server.port === PORT)

try {
  console.log('\n[api] routing dasar')
  let res = await fetch(`${base}/`)
  check('GET / -> 200', res.status === 200)
  const rootJson = await res.json()
  check('GET / memuat daftar endpoint', Boolean(rootJson.endpoints))

  res = await fetch(`${base}/tidak-ada`)
  check('route tak dikenal -> 404 JSON', res.status === 404)

  res = await fetch(`${base}/health`)
  const health = await res.json().catch(() => ({}))
  const hasCreds = res.status === 200

  if (!hasCreds) {
    check(
      'tanpa kredensial valid -> 500 + pesan error jelas',
      res.status === 500 && typeof health.error === 'string',
      JSON.stringify(health),
    )
    if (/kredensial/i.test(health.error ?? '')) {
      console.log('\n  INFO  Kredensial MEGA belum diisi, uji E2E dilewati.')
      console.log('        Isi config.local.json (atau env MEGA_EMAIL/MEGA_PASSWORD) lalu jalankan lagi.')
    } else {
      console.log('\n  INFO  Kredensial terisi tapi login gagal: ' + health.error)
    }
  } else {
    check('kredensial valid, status storage ready', health.status === 'ready', JSON.stringify(health))

    const dir = `smoke-test-${Date.now()}`
    console.log(`\n[e2e] folder uji: ${dir}`)

    try {
      res = await fetch(`${base}/folders/${dir}`, { method: 'POST' })
      const folderJson = await res.json().catch(() => ({}))
      check('POST /folders -> 201', res.status === 201, `status ${res.status}: ${JSON.stringify(folderJson)}`)
      check(
        'respons folder memuat urls.list',
        folderJson.urls?.list === `${base}/list/${dir}`,
        String(folderJson.urls?.list),
      )

      const content1 = `halo dunia ${Date.now()}`
      const bytes1 = encoder.encode(content1)
      const form1 = new FormData()
      form1.set('file', new File([bytes1], 'halo.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/halo.txt`, { method: 'POST', body: form1 })
      const uploaded = await res.json().catch(() => ({}))
      check('upload multipart -> 201', res.status === 201, `status ${res.status}: ${JSON.stringify(uploaded)}`)
      const urls = uploaded.urls ?? {}
      check(
        'respons upload memuat urls view/download/info',
        typeof urls.view === 'string' && typeof urls.download === 'string' && typeof urls.info === 'string',
        JSON.stringify(uploaded),
      )
      check(
        'urls.view memakai host request + path ter-encode',
        urls.view === `${base}/view/${dir}/halo.txt`,
        String(urls.view),
      )

      res = await fetch(urls.view)
      check('urls.view dari respons upload bisa langsung dibuka', (await res.text()) === content1)

      const photoW = 800
      const photoH = 600
      const photoRaw = Buffer.alloc(photoW * photoH * 3)
      for (let y = 0; y < photoH; y += 1) {
        for (let x = 0; x < photoW; x += 1) {
          const i = (y * photoW + x) * 3
          photoRaw[i] = Math.round((x * 255) / photoW)
          photoRaw[i + 1] = Math.round((y * 255) / photoH)
          photoRaw[i + 2] = ((x + y) % 2) * 255
        }
      }
      const photo = await sharp(photoRaw, { raw: { width: photoW, height: photoH, channels: 3 } })
        .jpeg({ quality: 100 })
        .toBuffer()
      const formPhoto = new FormData()
      formPhoto.set('file', new File([photo], 'foto-uji.jpg', { type: 'image/jpeg' }))
      res = await fetch(`${base}/files/${dir}/foto-uji.jpg`, { method: 'POST', body: formPhoto })
      const photoJson = await res.json().catch(() => ({}))
      check('upload gambar -> 201', res.status === 201, `status ${res.status}: ${JSON.stringify(photoJson)}`)
      check(
        'kompresi default 85 aktif',
        photoJson.compression?.quality === 85 && photoJson.compression.compressedBytes < photoJson.compression.originalBytes,
        JSON.stringify(photoJson.compression),
      )
      check(
        'ukuran tersimpan = ukuran hasil kompresi',
        photoJson.file?.size === photoJson.compression?.compressedBytes,
        `file.size=${photoJson.file?.size} compressed=${photoJson.compression?.compressedBytes}`,
      )

      res = await fetch(`${base}/view/${dir}/foto-uji.jpg`)
      const storedPhoto = Buffer.from(await res.arrayBuffer())
      check('gambar tersimpan lebih kecil dari asli', storedPhoto.length < photo.length, `${storedPhoto.length} < ${photo.length}`)
      const storedMeta = await sharp(storedPhoto).metadata()
      check('gambar hasil kompresi tetap JPEG valid', storedMeta.format === 'jpeg', String(storedMeta.format))

      const formNoCompress = new FormData()
      formNoCompress.set('file', new File([photo], 'foto-asli.jpg', { type: 'image/jpeg' }))
      res = await fetch(`${base}/files/${dir}/foto-asli.jpg?q=0`, { method: 'POST', body: formNoCompress })
      const noCompressJson = await res.json().catch(() => ({}))
      check(
        'q=0 menyimpan gambar tanpa kompresi',
        res.status === 201 && noCompressJson.compression === null && noCompressJson.file?.size === photo.length,
        JSON.stringify(noCompressJson),
      )

      const formBadQuality = new FormData()
      formBadQuality.set('file', new File([photo], 'foto-q.jpg', { type: 'image/jpeg' }))
      res = await fetch(`${base}/files/${dir}/foto-q.jpg?q=999`, { method: 'POST', body: formBadQuality })
      check('kualitas di luar 1-100 -> 400', res.status === 400, `status ${res.status}`)

      res = await fetch(`${base}/list/${dir}`)
      const entriesAfterPhoto = (await res.json()).entries ?? []
      check(
        'file yang gagal validasi kualitas tidak terupload',
        entriesAfterPhoto.length === 3 && !entriesAfterPhoto.some((e) => e.name === 'foto-q.jpg'),
        JSON.stringify(entriesAfterPhoto.map((e) => e.name)),
      )

      const formDup = new FormData()
      formDup.set('file', new File(['duplikat'], 'halo.txt'))
      res = await fetch(`${base}/files/${dir}/halo.txt`, { method: 'POST', body: formDup })
      check('upload nama sama tanpa overwrite -> 409', res.status === 409, `status ${res.status}`)

      res = await fetch(`${base}/list/${dir}`)
      const listing = await res.json()
      check(
        'GET /list/<folder> memuat halo.txt',
        (listing.entries ?? []).some((e) => e.name === 'halo.txt' && !e.directory),
      )

      res = await fetch(`${base}/files/${dir}/halo.txt`)
      const fileMeta = await res.json()
      check(
        'GET /files/<path> metadata benar',
        fileMeta.size === bytes1.length && fileMeta.mime === 'text/plain; charset=utf-8',
        JSON.stringify(fileMeta),
      )

      res = await fetch(`${base}/view/${dir}/halo.txt`)
      const viewed = await res.text()
      check('GET /view isi utuh', viewed === content1)
      check('GET /view Content-Type text/plain', (res.headers.get('content-type') ?? '').startsWith('text/plain'))
      check('GET /view Accept-Ranges: bytes', res.headers.get('accept-ranges') === 'bytes')

      res = await fetch(`${base}/view/${dir}/halo.txt`, { headers: { Range: 'bytes=0-3' } })
      const ranged = await res.text()
      check('Range -> 206 Partial Content', res.status === 206, `status ${res.status}`)
      check('Range isi 4 byte pertama', ranged === content1.slice(0, 4), JSON.stringify(ranged))
      check(
        'Range Content-Range benar',
        res.headers.get('content-range') === `bytes 0-3/${bytes1.length}`,
        String(res.headers.get('content-range')),
      )

      res = await fetch(`${base}/view/${dir}/halo.txt`, { headers: { Range: `bytes=${bytes1.length + 10}-` } })
      check('Range di luar ukuran -> 416', res.status === 416, `status ${res.status}`)

      const content2 = `isi baru ${Date.now()}`
      const bytes2 = encoder.encode(content2)
      const form2 = new FormData()
      form2.set('file', new File([bytes2], 'halo.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/halo.txt`, { method: 'PUT', body: form2 })
      const updated = await res.json()
      check(
        'PUT replace -> 200 + replaced terisi',
        res.status === 200 && Boolean(updated.replaced),
        JSON.stringify(updated),
      )
      check(
        'respons PUT memuat urls.view yang sama',
        updated.urls?.view === `${base}/view/${dir}/halo.txt`,
        String(updated.urls?.view),
      )

      res = await fetch(`${base}/view/${dir}/halo.txt`)
      check('isi setelah update = isi baru', (await res.text()) === content2)

      // --- rename saat upload (create) ---
      const formNamed = new FormData()
      formNamed.set('file', new File([encoder.encode('nama custom')], 'asli.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/asli.txt?name=nama-custom.txt`, { method: 'POST', body: formNamed })
      const namedJson = await res.json().catch(() => ({}))
      check('POST ?name= menyimpan dengan nama baru', res.status === 201 && namedJson.file?.name === 'nama-custom.txt', JSON.stringify(namedJson.file))
      res = await fetch(`${base}/view/${dir}/nama-custom.txt`)
      check('file hasil rename saat upload bisa dibuka', (await res.text()) === 'nama custom')

      // --- rename saat update (PUT) ---
      const formRenamedPut = new FormData()
      formRenamedPut.set('file', new File([encoder.encode('isi v2')], 'nama-custom.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/nama-custom.txt?name=hasil-put.txt`, { method: 'PUT', body: formRenamedPut })
      const putRenamed = await res.json().catch(() => ({}))
      check('PUT ?name= mengganti nama + isi', res.status === 200 && putRenamed.file?.name === 'hasil-put.txt', JSON.stringify(putRenamed.file))
      check('PUT ?name= melaporkan renamedFrom', putRenamed.renamedFrom === `${dir}/nama-custom.txt`, String(putRenamed.renamedFrom))
      check('PUT ?name= urls.view menunjuk nama baru', putRenamed.urls?.view === `${base}/view/${dir}/hasil-put.txt`, String(putRenamed.urls?.view))
      res = await fetch(`${base}/view/${dir}/hasil-put.txt`)
      check('isi hasil PUT ?name= benar', (await res.text()) === 'isi v2')
      res = await fetch(`${base}/files/${dir}/nama-custom.txt`)
      check('nama lama sudah tidak ada setelah PUT ?name=', res.status === 404, `status ${res.status}`)

      // --- PATCH rename murni ---
      res = await fetch(`${base}/files/${dir}/hasil-put.txt?name=renamed-patch.txt`, { method: 'PATCH' })
      const patched = await res.json().catch(() => ({}))
      check('PATCH ?name= -> 200', res.status === 200, `status ${res.status}: ${JSON.stringify(patched)}`)
      check('PATCH hasil name + path baru', patched.renamed?.name === 'renamed-patch.txt' && patched.renamed?.path === `${dir}/renamed-patch.txt`, JSON.stringify(patched.renamed))
      check('PATCH urls.view menunjuk nama baru', patched.urls?.view === `${base}/view/${dir}/renamed-patch.txt`, String(patched.urls?.view))
      res = await fetch(`${base}/view/${dir}/renamed-patch.txt`)
      check('isi tetap utuh setelah PATCH rename', (await res.text()) === 'isi v2')

      res = await fetch(`${base}/files/${dir}/renamed-patch.txt?name=halo.txt`, { method: 'PATCH' })
      check('PATCH nama bentrok tanpa overwrite -> 409', res.status === 409, `status ${res.status}`)

      res = await fetch(`${base}/files/${dir}/renamed-patch.txt?name=halo.txt&overwrite=1`, { method: 'PATCH' })
      const patchedOver = await res.json().catch(() => ({}))
      check('PATCH ?overwrite=1 menimpa file bentrok', res.status === 200 && patchedOver.overwritten !== null, JSON.stringify(patchedOver))
      res = await fetch(`${base}/view/${dir}/halo.txt`)
      check('file setelah timpa berisi isi file yang di-rename', (await res.text()) === 'isi v2')

      res = await fetch(`${base}/files/${dir}/halo.txt`, { method: 'PATCH' })
      check('PATCH tanpa ?name= -> 400', res.status === 400, `status ${res.status}`)

      res = await fetch(`${base}/files/${dir}/tidak-ada.txt?name=x.txt`, { method: 'PATCH' })
      check('PATCH path tidak ada -> 404', res.status === 404, `status ${res.status}`)

      // --- PATCH rename folder ---
      res = await fetch(`${base}/folders/${dir}/sub`, { method: 'POST' })
      check('POST /folders/<dir>/sub -> 201', res.status === 201, `status ${res.status}`)
      res = await fetch(`${base}/files/${dir}/sub?name=sub-baru`, { method: 'PATCH' })
      const folderRenamed = await res.json().catch(() => ({}))
      check(
        'PATCH folder -> urls.list menunjuk nama baru',
        res.status === 200 && folderRenamed.renamed?.directory === true && folderRenamed.urls?.list === `${base}/list/${dir}/sub-baru`,
        JSON.stringify(folderRenamed),
      )
      res = await fetch(`${base}/list/${dir}/sub-baru`)
      check('folder hasil rename bisa dibuka', res.status === 200, `status ${res.status}`)

      // --- nama otomatis (autoname) ---
      const autoPattern = /^AR-\d{8}-\d{6}(-\d+)?\.txt$/
      const formAutoDefault = new FormData()
      formAutoDefault.set('file', new File([encoder.encode('default otomatis')], 'catatan.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files?folder=${dir}`, { method: 'POST', body: formAutoDefault })
      const autoDefault = await res.json().catch(() => ({}))
      check(
        'POST /files tanpa nama -> nama otomatis default',
        res.status === 201 && autoPattern.test(autoDefault.file?.name ?? '') && autoDefault.file?.path === `${dir}/${autoDefault.file?.name}`,
        JSON.stringify(autoDefault.file),
      )
      res = await fetch(autoDefault.urls?.view ?? `${base}/tidak-ada`)
      check('file dari POST /files default bisa dibuka + isi benar', (await res.text()) === 'default otomatis')

      const formAuto = new FormData()
      formAuto.set('file', new File([encoder.encode('isi otomatis')], 'catatan.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}?autoname=1`, { method: 'POST', body: formAuto })
      const autoJson = await res.json().catch(() => ({}))
      check(
        'POST ?autoname=1 -> nama dibuat server + masuk folder tujuan',
        res.status === 201 && autoPattern.test(autoJson.file?.name ?? '') && autoJson.file?.path === `${dir}/${autoJson.file?.name}`,
        JSON.stringify(autoJson.file),
      )
      res = await fetch(autoJson.urls?.view ?? `${base}/tidak-ada`)
      check('file autoname bisa dibuka + isi benar', (await res.text()) === 'isi otomatis')

      const formAutoPut = new FormData()
      formAutoPut.set('file', new File([encoder.encode('isi v3')], 'catatan.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/${autoJson.file?.name}?autoname=1`, { method: 'PUT', body: formAutoPut })
      const autoPut = await res.json().catch(() => ({}))
      check(
        'PUT ?autoname=1 -> nama baru + renamedFrom',
        res.status === 200 && autoPattern.test(autoPut.file?.name ?? '') && autoPut.renamedFrom === `${dir}/${autoJson.file?.name}`,
        JSON.stringify(autoPut),
      )
      check('nama autoname PUT berbeda dari sebelumnya', autoPut.file?.name !== autoJson.file?.name, `${autoPut.file?.name} vs ${autoJson.file?.name}`)
      res = await fetch(`${base}/files/${dir}/${autoJson.file?.name}`)
      check('nama lama hilang setelah PUT autoname', res.status === 404, `status ${res.status}`)
      res = await fetch(autoPut.urls?.view ?? `${base}/tidak-ada`)
      check('isi setelah PUT autoname benar', (await res.text()) === 'isi v3')

      const formAutoOff = new FormData()
      formAutoOff.set('file', new File([encoder.encode('tetap')], 'tetap.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/tetap.txt?autoname=0`, { method: 'POST', body: formAutoOff })
      const autoOff = await res.json().catch(() => ({}))
      check('?autoname=0 memakai nama asli', res.status === 201 && autoOff.file?.name === 'tetap.txt', JSON.stringify(autoOff.file))

      const formAutoBad = new FormData()
      formAutoBad.set('file', new File([encoder.encode('x')], 'x.txt', { type: 'text/plain' }))
      res = await fetch(`${base}/files/${dir}/x.txt?autoname=mungkin`, { method: 'POST', body: formAutoBad })
      check('?autoname nilai tidak valid -> 400', res.status === 400, `status ${res.status}`)

      res = await fetch(`${base}/files/${dir}/halo.txt?permanent=1`, { method: 'DELETE' })
      check('DELETE file -> 200', res.status === 200, `status ${res.status}`)

      res = await fetch(`${base}/list/${dir}`)
      const afterDelete = await res.json()
      check('file hilang dari list', !(afterDelete.entries ?? []).some((e) => e.name === 'halo.txt'))
    } finally {
      // Bersihkan folder uji apa pun yang tersisa (best-effort).
      const cleanup = await fetch(`${base}/files/${dir}?permanent=1`, { method: 'DELETE' }).catch(() => null)
      if (cleanup?.ok) console.log(`  INFO  folder uji ${dir} dibersihkan`)
    }
  }
} catch (err) {
  fail += 1
  console.log(`\n  FAIL  error tak terduga: ${err?.stack ?? err}`)
}

await finish(fail > 0 ? 1 : 0)
