# Console Web

Halaman web untuk mengambil konfigurasi S3 (endpoint, region, access key, secret key) dan mengelola file — dengan login per identitas. Setiap identitas hanya melihat ruangnya sendiri.

```
Browser  ──login──▶  Console (port 3002)
                        │
                        ├─ /api/me      -> config S3 milik identitas yang login
                        ├─ /api/browse  -> daftar bucket & file
                        ├─ /api/upload  -> unggah file
                        └─ /api/download-> unduh file
                        │
                        ▼
                     MEGA  s3/<identitas>/<bucket>/<key>
```

Console dan S3 gateway adalah dua server terpisah. Console **tidak** melayani protokol S3 — aplikasi kamu tetap memakai gateway di port 3001.

## 1. Tambahkan password ke identitas

Password hanya dipakai untuk login ke console. Tanpa password, identitas tetap bisa dipakai lewat protokol S3, tapi tidak bisa login ke console.

```json
{
  "identities": [
    {
      "name": "aplikasi",
      "accessKeyId": "MEGADRIVEAPLIKASI0001",
      "secretAccessKey": "rahasia-panjang-acak-untuk-aplikasi",
      "password": "password-login-console"
    }
  ]
}
```

Simpan sebagai `s3-identities.local.json` (sudah masuk `.gitignore`). Contoh lengkap ada di `s3-identities.example.json`.

Kalau memakai fallback environment (tanpa file identitas), password diambil dari `S3_UI_PASSWORD`:

```bash
S3_ACCESS_KEY_ID=testkey
S3_SECRET_ACCESS_KEY=testsecret
S3_UI_PASSWORD=password-console
```

## 2. Jalankan

```bash
bun run ui          # http://127.0.0.1:3002
bun run ui:dev      # mode watch
```

Jalankan juga gateway S3, karena console hanya menampilkan konfigurasi — datanya tetap ditulis lewat gateway:

```bash
bun run s3          # http://0.0.0.0:3001
```

Console sengaja hanya mendengarkan `127.0.0.1` (localhost). Kalau perlu diakses dari mesin lain, set `S3_UI_HOSTNAME=0.0.0.0` — tapi baca dulu bagian Keamanan.

## 3. Variabel environment

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `S3_UI_PORT` | `3002` | Port console |
| `S3_UI_HOSTNAME` | `127.0.0.1` | Alamat dengar console |
| `S3_UI_SECRET` | acak saat start | Kunci tanda tangan cookie sesi. Set agar sesi tidak hilang saat restart |
| `S3_UI_MAX_BODY_BYTES` | `5 GB` | Batas ukuran upload lewat console |
| `S3_PUBLIC_ENDPOINT` | otomatis | Endpoint S3 yang ditampilkan ke pengguna, misal `https://s3.domainkamu.com` |
| `S3_IDENTITIES_FILE` | `s3-identities.local.json` | File identitas yang dipakai console dan gateway |

Endpoint yang ditampilkan dihitung dari `S3_PUBLIC_ENDPOINT`, atau otomatis `http://<host>:<S3_PORT>`. Set `S3_PUBLIC_ENDPOINT` kalau gateway diakses lewat domain atau reverse proxy.

## 4. Isi halaman

**Konfigurasi** — endpoint, region, bucket aktif, access key ID, secret key (tersembunyi, ada tombol Lihat/Salin), path style, folder MEGA milik identitas, dan kuota MEGA.

**Cara pakai** — contoh kode siap salin dengan kredensial sudah terisi otomatis: AWS SDK v3 (JS), Python boto3, Laravel, rclone, AWS CLI, dan `.env`.

**File** — daftar bucket, navigasi folder, buat bucket/folder, upload (bisa banyak file), unduh, dan hapus permanen. Semua dibatasi ke `s3/<identitas>/`.

## 5. Keamanan

- Login memakai nama identitas + password. Password dibandingkan timing-safe.
- Sesi disimpan di memori server; cookie `HttpOnly`, `SameSite=Strict`, berlaku 12 jam. Restart server = semua sesi logout.
- Setelah 5 percobaan gagal dari IP yang sama, login diblokir 15 menit.
- Isolasi identitas ditegakkan di setiap endpoint: membuka bucket milik identitas lain menghasilkan `404`, bukan `403` — supaya keberadaan data tidak bisa ditebak.
- Console **hanya** mendengarkan localhost secara default. Kalau diekspos ke jaringan, pasang HTTPS (reverse proxy) karena password dan secret key dikirim lewat HTTP biasa.
- Console tidak punya fitur kelola identitas: menambah atau menghapus identitas dilakukan dengan mengedit `s3-identities.local.json` lalu restart.

## 6. Batasan

- Satu password per identitas, tanpa peran atau izin granular. Siapa pun yang bisa login ke console memegang kendali penuh atas ruang identitas itu.
- Tidak ada fitur ganti password dari UI.
- Upload lewat console dibaca penuh ke memori sebelum diteruskan ke MEGA, jadi tidak cocok untuk file sangat besar. Untuk file besar pakai S3 gateway (multipart).
- Menghapus file dan folder bersifat permanen (tidak lewat Rubbish Bin).
- Console tidak bisa dipakai untuk melihat isi bucket identitas lain, termasuk oleh pemilik akun MEGA. Untuk melihat semua data, pakai REST API di port 3000.

## 7. Uji

```bash
# terminal 1 — console dengan identitas uji
S3_UI_PORT=3302 S3_IDENTITIES_FILE=s3-identities.test.json bun run ui

# terminal 2
UI_ENDPOINT=http://127.0.0.1:3302 bun run ui:smoke
```

32 pemeriksaan: akses tanpa login, login salah/benar, isi config, CRUD file, isolasi antar identitas, dan logout.

## 8. Kode sumber

| File | Isi |
| --- | --- |
| `src/ui/server.js` | Route HTTP, sesi, penyajian halaman |
| `src/ui/auth.js` | Login, cookie sesi, rate limit |
| `src/ui/browse.js` | Operasi bucket/folder/file yang dibatasi per identitas |
| `src/ui/page.html` | Seluruh HTML, CSS, dan JS halaman console |
| `test/ui-smoke.mjs` | Uji otomatis console |
