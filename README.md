# MEGA Drive API

Backend REST API untuk akun MEGA (mega.nz) kamu sendiri. Fitur: **create/upload**, **update/replace**,
**list**, **streaming view** gambar/PDF/video (mendukung seek via HTTP Range), dan **delete**.

Selain REST, tersedia **S3 gateway** supaya akun MEGA bisa dipakai lewat protokol S3 (AWS SDK,
boto3, rclone, Laravel Flysystem, `aws s3 cp`). Lihat **[S3.md](S3.md)**. Tersedia juga
**console web** untuk melihat config S3 dan mengelola file lewat browser. Lihat **[UI.md](UI.md)**.
Kalau perlu menyimpan identitas dan metadata di PostgreSQL, isi `DATABASE_URL` — lihat
**[DATABASE.md](DATABASE.md)**. Tanpa database pun aplikasi tetap jalan seperti biasa.

Untuk menjalankan di server sendiri (Docker, CI/CD GitHub Actions, HTTPS lewat
Caddy), lihat **[DEPLOY.md](DEPLOY.md)**.

Stack: [Bun](https://bun.sh) + [Hono](https://hono.dev) + [megajs](https://github.com/qgustavor/mega).

## 1. Isi kredensial

Tiga cara, pilih salah satu:

**Cara A — file `env.local`** (paling praktis):

```powershell
Copy-Item env.example env.local
# lalu edit env.local dan isi MEGA_EMAIL / MEGA_PASSWORD
```

**Cara B — environment variable** (PowerShell):

```powershell
$env:MEGA_EMAIL = "email-kamu@contoh.com"
$env:MEGA_PASSWORD = "password-kamu"
$env:MEGA_2FA = "123456"   # opsional, hanya kalau akun pakai 2FA
```

**Cara C — file `config.local.json`** (sudah dibuat di proyek ini, tinggal isi nilainya):

```json
{
  "email": "email-kamu@contoh.com",
  "password": "password-kamu",
  "secondFactorCode": ""
}
```

Urutan prioritas: environment variable > `env.local` > `config.local.json`.
Kedua file kredensial sudah masuk `.gitignore`. Nilai contoh (`ISI_EMAIL_MEGA_KAMU`, dsb.)
otomatis dianggap belum diisi, jadi tidak akan salah login.

## 2. Jalankan

```powershell
bun run start     # produksi
bun run dev       # auto-reload saat file diubah
```

Server jalan di `http://localhost:3000` (ubah dengan `$env:PORT`).

Butuh protokol S3? Jalankan gateway-nya di port terpisah:

```powershell
bun run s3        # http://localhost:3001, dokumentasi lengkap di S3.md
```

Gateway S3 punya **identitas/kredensial sendiri** (access key + secret key), terpisah dari
kredensial MEGA. Isi `s3-identities.local.json` (contoh: `s3-identities.example.json`).
Tiap identitas mendapat ruang MEGA terpisah (`s3/<nama>/`) dan **tidak bisa saling melihat
atau menyentuh data**. REST API di port 3000 tetap tanpa auth dan bisa melihat semuanya —
pakai S3 gateway kalau butuh pemisahan akses.

Butuh melihat config dan mengelola file lewat browser? Jalankan console web:

```powershell
bun run ui        # http://127.0.0.1:3002, dokumentasi di UI.md
```

Console memakai login (nama identitas + password) dan hanya menampilkan config milik identitas
yang login. Tambahkan field `password` ke tiap entri di `s3-identities.local.json` supaya bisa
masuk. Console tidak menggantikan gateway — aplikasi tetap memakai port 3001.

## 3. Uji cepat

```powershell
bun run smoke
```

Smoke test memeriksa tipe MIME, routing, penanganan error, dan — kalau kredensial sudah diisi —
uji end-to-end penuh: buat folder, upload, tolak duplikat, list, metadata, view, Range `206`/`416`,
update (`PUT`), dan delete. Semua sumber daya uji dibersihkan otomatis di akhir.

Untuk S3 gateway ada tiga uji tambahan (jalankan `bun run s3` di terminal lain dulu):

```powershell
bun run s3:smoke      # 42 pemeriksaan protokol S3
bun run s3:sdk        # 9 pemeriksaan via AWS SDK resmi
bun run s3:identity   # 20 pemeriksaan isolasi antar identitas
```

Untuk console web (jalankan `bun run ui` di terminal lain dulu):

```powershell
bun run ui:smoke      # 32 pemeriksaan login, config, dan file browser
```

## 4. Endpoint

Semua path file/folder memakai path relatif dari **Cloud Drive** akun kamu,
misalnya `foto/liburan/pantai.jpg`. Spasi boleh (otomatis di-encode).

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/` | Daftar endpoint |
| `GET` | `/health` | Status koneksi + kuota akun |
| `GET` | `/list` | Daftar isi root |
| `GET` | `/list/<folder>` | Daftar isi folder |
| `GET` | `/files/<path>` | Metadata satu file/folder |
| `POST` | `/folders/<path>` | Buat folder (parent otomatis dibuat) |
| `POST` | `/files` | Upload; **nama otomatis** `AR-YYYYMMDD-HHMMSS.ext`. Opsional `?folder=foto`, `?name=`, `?autoname=0` |
| `POST` | `/files/<path>` | Upload ke path lengkap. Opsional `?overwrite=1&name=nama-baru.ext&autoname=1` |
| `PUT` | `/files/<path>` | **Update/replace** isi file. Opsional `?name=nama-baru.ext` atau `?autoname=1` |
| `PATCH` | `/files/<path>` | **Ganti nama saja** tanpa upload. Wajib `?name=nama-baru.ext` |
| `DELETE` | `/files/<path>` | Hapus (ke Rubbish Bin). Tambah `?permanent=1` untuk permanen |
| `GET` | `/view/<path>` | **Stream inline** (gambar/pdf/video/audio), mendukung Range |
| `GET` | `/download/<path>` | Unduh sebagai attachment, mendukung Range |

### Upload — dua cara

**Multipart** (praktis, untuk file kecil–sedang):

```powershell
# paling simpel: nama otomatis AR-YYYYMMDD-HHMMSS.ext
curl.exe -X POST "http://localhost:3030/files" -F "file=@D:\foto\pantai.jpg"

# langsung ke folder tertentu (nama tetap otomatis)
curl.exe -X POST "http://localhost:3030/files?folder=foto/liburan" -F "file=@D:\foto\pantai.jpg"

# pakai nama asli file
curl.exe -X POST "http://localhost:3030/files?autoname=0" -F "file=@D:\foto\pantai.jpg"
```

**Raw body** (paling efisien — tidak di-buffer di memori, cocok file besar):

```powershell
curl.exe -X POST "http://localhost:3000/files/video/besar.mp4" `
  -H "Content-Type: application/octet-stream" `
  --data-binary "@D:\video\besar.mp4"
```

Body mentah wajib punya `Content-Length`; kalau tidak, server balas `411`.

### Kompresi gambar otomatis

Upload gambar (`jpg`, `png`, `webp`) otomatis dikompres dengan kualitas **85** sebelum dikirim ke MEGA:

```powershell
# default: kompresi 85
curl.exe -X POST "http://localhost:3000/files/foto/pantai.jpg" -F "file=@D:\foto\pantai.jpg"

# kualitas khusus (1-100)
curl.exe -X POST "http://localhost:3000/files/foto/pantai.jpg?q=70" -F "file=@D:\foto\pantai.jpg"

# matikan kompresi (simpan apa adanya)
curl.exe -X POST "http://localhost:3000/files/foto/pantai.jpg?q=0" -F "file=@D:\foto\pantai.jpg"
```

Respons menyertakan detail kompresi:

```jsonc
{
  "uploadedBytes": 248193,
  "compression": {
    "quality": 85,
    "originalBytes": 1450000,
    "compressedBytes": 248193,
    "savedPercent": 82.9
  }
}
```

Catatan: kompresi hanya dipakai kalau hasilnya **lebih kecil** dari asli — kalau tidak, file asli tetap dipakai.
Gambar >25 MB dilewati (biar upload besar tetap cepat). GIF animasi & SVG tidak disentuh.
Kalau `compression` berisi `skipped`, artinya file disimpan apa adanya.

Setiap respons upload/replace/folder otomatis menyertakan `urls` siap pakai
(host mengikuti host request), jadi tidak perlu menyusun URL manual:

```jsonc
{
  "ok": true,
  "mode": "create",
  "file": { "name": "pantai.jpg", "path": "foto/pantai.jpg", "size": 248193, "...": "..." },
  "urls": {
    "view": "http://localhost:3000/view/foto/pantai.jpg",
    "download": "http://localhost:3000/download/foto/pantai.jpg",
    "info": "http://localhost:3000/files/foto/pantai.jpg"
  }
}
```

```powershell
# contoh: buka langsung URL view dari respons upload
$res = curl.exe -s -X POST "http://localhost:3000/files/foto/pantai.jpg" -F "file=@D:\foto\pantai.jpg" | ConvertFrom-Json
start $res.urls.view
```

### Update / replace

`PUT` mengganti isi file di path yang sama. Urutannya **upload dulu, baru hapus node lama**,
jadi kalau upload gagal file lama tetap aman.

```powershell
curl.exe -X PUT "http://localhost:3000/files/foto/pantai.jpg" `
  -F "file=@D:\foto\pantai-baru.jpg"

# kalau ada file lama yang gagal dihapus, response berisi "warning"
```

### Ganti nama

Tiga cara, pilih sesuai kebutuhan:

```powershell
# 1. Saat upload (POST): simpan file dengan nama berbeda
curl.exe -X POST "http://localhost:3000/files/foto/pantai.jpg?name=pantai-2025.jpg" `
  -F "file=@D:\foto\pantai.jpg"

# 2. Saat update (PUT): ganti isi sekaligus ganti nama
curl.exe -X PUT "http://localhost:3000/files/foto/pantai.jpg?name=pantai-baru.jpg" `
  -F "file=@D:\foto\pantai-revisi.jpg"

# 3. Tanpa upload (PATCH): ganti nama saja, isi tetap utuh
curl.exe -X PATCH "http://localhost:3000/files/foto/pantai.jpg?name=pantai-2025.jpg"
```

Respons `PATCH` berisi nama lama, nama baru, dan URL baru:

```jsonc
{
  "ok": true,
  "renamed": { "name": "pantai-2025.jpg", "path": "foto/pantai-2025.jpg", "...": "..." },
  "renamedFrom": "foto/pantai.jpg",
  "overwritten": null,
  "urls": { "view": "http://localhost:3000/view/foto/pantai-2025.jpg", "...": "..." }
}
```

Kalau nama tujuan sudah ada di folder yang sama, server balas `409`.
Tambah `?overwrite=1` untuk menimpa file yang bentrok (berlaku untuk file, bukan folder).
`PATCH` juga bisa dipakai untuk folder — `urls` akan berisi `list` alih-alih `view`.

### Nama otomatis

`POST /files` **sudah otomatis** memberi nama `AR-YYYYMMDD-HHMMSS.ext` (tanggal + jam, ekstensi asli dipertahankan) — cukup kirim body file:

```powershell
curl.exe -X POST "http://localhost:3030/files" -F "file=@D:\foto\IMG_1234.jpg"
# hasil: AR-20260215-204512.jpg (di root Cloud Drive)

# opsional: tentukan folder tujuan
curl.exe -X POST "http://localhost:3030/files?folder=foto/liburan" -F "file=@D:\foto\IMG_1234.jpg"
# hasil: foto/liburan/AR-20260215-204512.jpg
```

Pakai nama asli file: `?autoname=0`. Pakai nama pilihan sendiri: `?name=foto-pantai.jpg`.
Untuk `PUT` (update), tambahkan `?autoname=1` untuk mengganti nama sekaligus:

```powershell
curl.exe -X PUT "http://localhost:3030/files/foto/liburan/AR-20260215-204512.jpg?autoname=1" `
  -F "file=@D:\foto\IMG_5678.jpg"
```

Catatan: pada `POST /files/<path>` dengan `?autoname=1`, path yang dikirim dianggap **folder tujuan** (bukan nama file).
Kalau dalam detik yang sama sudah ada nama yang sama, server menambah `-2`, `-3`, dan seterusnya.
Respons `urls` otomatis berisi nama baru.

### View / streaming

```powershell
# gambar / PDF -> bisa dibuka langsung di browser
start http://localhost:3000/view/foto/pantai.jpg

# video -> bisa di-seek (server balas 206 Partial Content)
start http://localhost:3000/view/video/besar.mp4
```

Server menerjemahkan header `Range` (`bytes=0-1023`, `bytes=1024-`, `bytes=-1024`)
menjadi permintaan byte-range ke MEGA, jadi video bisa di-skip tanpa mengunduh seluruh file.
Kalau `Range` di luar ukuran file, server balas `416` beserta `Content-Range: bytes */<size>`.

### Delete

```powershell
curl.exe -X DELETE "http://localhost:3000/files/foto/pantai.jpg"              # ke Rubbish Bin
curl.exe -X DELETE "http://localhost:3000/files/foto/pantai.jpg?permanent=1"  # permanen
```

## Contoh respons

```jsonc
// GET /list/foto
{
  "path": "foto",
  "entries": [
    { "name": "liburan", "path": "foto/liburan", "nodeId": "abc123", "directory": true, "size": 0, "mime": null, "createdAt": "2025-01-05T10:00:00.000Z" },
    { "name": "pantai.jpg", "path": "foto/pantai.jpg", "nodeId": "def456", "directory": false, "size": 248193, "mime": "image/jpeg", "createdAt": "2025-01-05T10:02:11.000Z" }
  ]
}
```

## Catatan

- **Kuota transfer MEGA**: unduhan lewat API dihitung sebagai transfer. Kalau limit habis,
  MEGA balas HTTP 509 dan server meneruskannya sebagai error `Bandwidth limit reached: ... seconds`.
- **Update = replace**: MEGA belum mendukung versi file di library ini, jadi `PUT` membuat node
  baru lalu menghapus node lama. `nodeId` file akan berubah setelah update.
- Nama file duplikat di folder yang sama akan ditolak (`409`) kecuali pakai `?overwrite=1`.
- Folder kosong tidak ditampilkan sebagai file; `directory: true` menandainya.
