# Database (Opsional)

Kalau `DATABASE_URL` diisi, tiga hal kecil dipindahkan dari file lokal ke PostgreSQL:

| Data | Tanpa database | Dengan database |
| --- | --- | --- |
| Identitas S3 (access key, secret, password) | `s3-identities.local.json` | tabel `identities` |
| Metadata objek (Content-Type, Cache-Control, `x-amz-meta-*`) | `.s3-state/meta/*.json` | tabel `object_meta` |
| State multipart upload | `.s3-state/uploads/*/state.json` | tabel `multipart_uploads` + `multipart_parts` |

**File aslinya tetap di MEGA.** Yang pindah ke database hanya catatan kecil yang MEGA tidak bisa simpan. Potongan file multipart tetap di disk lokal (`.s3-state/uploads/<id>/part-*`) karena ukurannya besar.

Tanpa `DATABASE_URL`, semuanya kembali memakai file lokal seperti sebelumnya. Aplikasi tetap jalan penuh tanpa database.

## 1. Isi DATABASE_URL

Dua format diterima, pilih salah satu:

```bash
# gaya native
DATABASE_URL=postgres://user:rahasia@127.0.0.1:5432/s3_mega_drive

# gaya JDBC (kredensial di query string)
DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/s3_mega_drive?user=user&password=rahasia
```

Format JDBC dikonversi otomatis ke format native saat start, jadi kamu bisa menempel apa adanya dari konfigurasi Java/Spring.

Kalau password mengandung karakter khusus (`@`, `:`, `/`, `#`), pakai format JDBC supaya tidak perlu di-encode manual.

## 2. Tabel dibuat otomatis

Saat server start, `initSchema()` menjalankan `create table if not exists` untuk:

- `identities` — `name` (PK), `access_key_id` (unik), `secret_access_key`, `password` (hash argon2id), `root`
- `object_meta` — PK `(identity, bucket, key)`, plus `content_type`, `cache_control`, `metadata` (jsonb)
- `multipart_uploads` — `upload_id` (PK), scope `(identity, bucket, key)`, plus `initiated`
- `multipart_parts` — PK `(upload_id, part_number)`, `etag`, `size`; ikut terhapus saat upload dihapus (cascade)

Tidak perlu migrasi manual. Aman dijalankan berkali-kali.

## 3. Perpindahan data lama

Saat `identities` masih kosong, isi `s3-identities.local.json` (atau fallback env `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`) **disalin sekali** ke tabel, dengan password di-hash. Setelah itu database jadi sumber kebenaran — mengubah file JSON tidak lagi berpengaruh.

```bash
bun run s3
# [s3] database tersambung, skema siap
# [db] 2 identitas disalin dari file/env ke tabel identities
```

Metadata objek dan state multipart lama di `.s3-state/` **tidak** ikut dipindahkan otomatis. Objek yang sudah ada tetap bisa dibaca; yang hilang hanya metadata tambahan (Content-Type jatuh ke deteksi dari ekstensi). Upload multipart yang sedang berjalan saat migrasi sebaiknya diselesaikan atau dibatalkan dulu.

## 4. Password sekarang hash

Dengan database, password console disimpan sebagai hash argon2id (`Bun.password`), bukan teks biasa:

- Login memakai `Bun.password.verify()` — tidak ada perbandingan string.
- Hash tidak bisa dibalik jadi password.
- `secret_access_key` **tetap** tersimpan apa adanya, karena SigV4 butuh nilai aslinya untuk menghitung tanda tangan. Ini batasan protokol S3, bukan pilihan desain.

Mode file (tanpa database) juga memakai hash di memori, jadi perilaku login sama di kedua mode.

## 5. Melihat isi database

```bash
bun -e "
import { SQL } from 'bun'
import { toNativeUrl } from './src/db.js'
const sql = new SQL(toNativeUrl(process.env.DATABASE_URL))
console.log(await sql.unsafe('select name, root from identities order by name'))
console.log(await sql.unsafe('select count(*) from object_meta'))
await sql.close()
"
```

Atau lewat klien Postgres biasa (`psql`, TablePlus, DBeaver) memakai connection string yang sama.

## 6. Catatan

- Koneksi memakai satu klien Bun SQL yang dipakai bersama; ditutup rapi saat server menerima `SIGINT`/`SIGTERM`.
- Kalau database mati, gateway gagal start — tidak ada fallback diam-diam ke file, supaya tidak ada data yang terpisah tanpa disadari.
- Menghapus bucket lewat S3 juga menghapus baris `object_meta` bucket itu, jadi tidak ada metadata yatim.
- Isolasi antar identitas tetap berlaku: setiap query metadata dan multipart selalu menyertakan nama identitas.
- Tabel tidak menyimpan isi file. Kalau database hilang, file di MEGA tetap utuh — yang hilang hanya metadata dan daftar identitas.

## 7. Kode sumber

| File | Isi |
| --- | --- |
| `src/db.js` | Konversi URL JDBC, klien SQL, skema, `initSchema()`, `closeDb()`, `parseJson()` |
| `src/s3/identities.js` | Baca/tulis identitas, hash password, seed dari file |
| `src/s3/object-meta.js` | Metadata objek (DB atau sidecar) |
| `src/s3/multipart.js` | State multipart (DB) + potongan file (disk) |
