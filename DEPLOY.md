# Deploy

Image Docker, CI/CD GitHub Actions, dan deploy ke VPS dengan domain
`s3.pasteprosmana.my.id`.

## Isi folder

| File | Fungsi |
| --- | --- |
| `Dockerfile` | Multi-stage, base `oven/bun:1.4.2-alpine`. Hasil image ~165 MB. |
| `.dockerignore` | Mencegah `.env`, `.s3-state`, `node_modules`, dan test ikut ke build context. |
| `docker-compose.yml` | Service `s3`, `ui`, `api` (profil), dan `caddy` (profil, hanya untuk VPS yang port 80/443-nya bebas). |
| `deploy/Caddyfile` | Reverse proxy ke `s3:3001` untuk mode Caddy. |
| `deploy/nginx-s3.conf` | Reverse proxy untuk VPS yang memakai nginx + Cloudflare Tunnel. |
| `deploy/sync-env.sh` | Menyalin `.env` lokal ke VPS sambil memperbaiki nilai khusus Docker. |
| `.github/workflows/ci-cd.yml` | Test → build & push ke GHCR → deploy ke VPS. |

## Ukuran image

Image awal 193 MB. Setelah `devDependencies` dibuang dan binary sharp yang tidak
dipakai dihapus, jadi **165 MB** — `node_modules` turun dari 44,1 MB ke 23,8 MB.

Yang membuatnya besar sekarang adalah base image `oven/bun:alpine` sendiri
(174 MB). Kalau butuh lebih kecil lagi, opsinya `oven/bun:distroless` atau
memakai base `alpine` + binary Bun saja, dengan konsekuensi tidak ada shell di
dalam container sehingga `docker exec` untuk debugging jadi terbatas.

## Yang perlu disiapkan sekali di VPS

### 1. DNS

Untuk VPS dengan **Cloudflare Tunnel** (seperti VPS ini), tidak perlu record
`A` ke IP VPS dan tidak perlu membuka port 80/443. Cukup:

1. Tambah **Public Hostname** di dashboard Cloudflare Zero Trust:
   `s3.pasteprosmana.my.id` → service `http://127.0.0.1:80`.
2. Pastikan ingress tunnel mengarah ke nginx loopback, lalu tambahkan vhost
   dari `deploy/nginx-s3.conf` ke `/etc/nginx/sites-enabled/`.

Kalau VPS-nya **tanpa** Cloudflare Tunnel dan port 80/443 bebas, pakai mode
Caddy sebagai gantinya: `docker compose --profile caddy up -d`, dan buat record
`A` ke IP VPS (DNS only sampai sertifikat terbit).

### 2. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # lalu logout & login lagi
docker compose version
```

### 3. Firewall

Dengan Cloudflare Tunnel, **tidak ada port yang perlu dibuka** selain SSH:
trafik masuk lewat koneksi keluar `cloudflared` ke Cloudflare.

```bash
sudo ufw allow 22/tcp
sudo ufw enable
```

Port `3001`, `3002`, dan `3000` **tidak** dibuka ke internet. Di
`docker-compose.yml` semuanya di-bind ke `127.0.0.1`, jadi hanya bisa diakses
dari dalam VPS. Di VPS ini gateway memakai **3101** dan UI **3102** karena
3001 sudah dipakai 9Router.

### 4. Folder deploy dan file `.env`

Cara tercepat: pakai skrip yang menyalin `.env` lokal apa adanya sambil
memperbaiki nilai yang tidak cocok untuk Docker.

```bash
sudo mkdir -p /srv/apps/s3-mega-drive
sudo chown -R "$USER":"$USER" /srv/apps/s3-mega-drive

./deploy/sync-env.sh user@ip-vps /srv/apps/s3-mega-drive
```

Skrip itu melakukan penyesuaian berikut dan menampilkan nilainya ke layar:

| Nilai | Perlakuan | Alasan |
| --- | --- | --- |
| `DATABASE_URL` | dikosongkan | Di `.env` lokal biasanya `127.0.0.1`; di container alamat itu tidak ada dan gateway **crash saat start**. Kosong = mode file, semua fitur tetap jalan. |
| `S3_HOSTNAME`, `S3_UI_HOSTNAME` | dipaksa `0.0.0.0` | Di dalam container, `127.0.0.1` hanya loopback container itu sendiri sehingga Caddy tidak bisa connect. |
| `IMAGE` | dibuang | CI yang mengisinya setiap deploy. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | dibuat acak kalau belum ada | Identitas yang tersimpan di Postgres lokal tidak ikut pindah saat `DATABASE_URL` dikosongkan. Tanpa ini semua request ditolak `InvalidAccessKeyId`. |
| `S3_UI_PASSWORD` | dibuat acak kalau belum ada | Tanpa password, identitas `default` tidak bisa login ke console web. |

Kredensial S3 hasil generate dicetak sekali di layar — simpan, karena dipakai
klien S3 (`aws s3 cp`, rclone, SDK).

Kalau lebih suka menulis manual, isi `/srv/apps/s3-mega-drive/.env` seperti ini:

```ini
MEGA_EMAIL=email-kamu@contoh.com
MEGA_PASSWORD=password-kamu
MEGA_2FA=

S3_DOMAIN=s3.pasteprosmana.my.id
S3_ACCESS_KEY_ID=hasil-openssl-rand-hex-20
S3_SECRET_ACCESS_KEY=hasil-openssl-rand-hex-32
S3_UI_PASSWORD=password-login-console

S3_PORT=3001
S3_UI_PORT=3002
S3_HOSTNAME=0.0.0.0
S3_UI_HOSTNAME=0.0.0.0
```

Jangan menulis `DATABASE_URL` kalau tidak ada Postgres yang bisa dijangkau dari
container. Baris `IMAGE=` **tidak perlu** ditulis — CI menambahkannya sendiri
setiap deploy. File ini tidak pernah ditimpa CI; CI hanya mengganti `IMAGE=`.

Membuat kunci acak:

```bash
openssl rand -hex 20   # untuk S3_ACCESS_KEY_ID
openssl rand -hex 32   # untuk S3_SECRET_ACCESS_KEY
```

## Secret dan variable di GitHub

Buka **Settings → Secrets and variables → Actions**.

### Secrets

| Nama | Isi |
| --- | --- |
| `VPS_HOST` | IP atau hostname VPS. Kalau SSH hanya lewat Tailscale, isi IP Tailscale (`100.x.y.z`), bukan IP publik. |
| `VPS_USER` | User SSH, mis. `ubuntu` atau `deploy`. |
| `VPS_SSH_KEY` | Private key SSH **lengkap** (termasuk baris `BEGIN`/`END`). |
| `VPS_PORT` | Opsional, default `22`. |
| `DEPLOY_PATH` | Opsional, default `/srv/apps/s3-mega-drive`. |
| `GHCR_PAT` | Opsional. Personal access token `read:packages` untuk pull image private. |
| `MEGA_EMAIL` | Opsional, agar smoke test menjalankan uji end-to-end. |
| `MEGA_PASSWORD` | Opsional, pasangan `MEGA_EMAIL`. |
| `MEGA_2FA` | Opsional, kalau akun MEGA pakai 2FA. |

### Variables

| Nama | Isi |
| --- | --- |
| `S3_DOMAIN` | `s3.pasteprosmana.my.id` |
| `BUILD_PLATFORMS` | Opsional. Default `linux/amd64`. VPS ARM → `linux/arm64`. |
| `DEPLOY_ENABLED` | Set `true` untuk mengaktifkan job deploy. Selama kosong, job deploy dilewati sehingga push tetap hijau meski secrets belum diisi. |

### Kunci SSH untuk deploy

Di VPS:

```bash
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/gh_deploy -N ""
cat ~/.ssh/gh_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/gh_deploy          # salin seluruh isinya ke secret VPS_SSH_KEY
```

`GHCR_PAT` hanya perlu kalau package di GHCR bersifat private. Kalau package
dibuat public, VPS bisa pull tanpa login. Untuk membuat PAT: **GitHub → Settings
→ Developer settings → Personal access tokens → Tokens (classic)**, scope
`read:packages`.

## Alur CI/CD

```
push ke main
   │
   ├─ test     : bun install → build 3 entry point → smoke test (70 cek)
   ├─ build    : docker buildx → push ghcr.io/mamsky/s3-mega-drive:sha-<commit>
   │             (plus tag latest)
   └─ deploy   : ssh ke VPS → scp compose + Caddyfile → ganti baris IMAGE=
                 → docker compose pull && up -d
                 → health check /__health
                 → gagal? rollback ke image sebelumnya, job exit 1
                 → sukses? prune image lama
                 → cek https://s3.pasteprosmana.my.id/__health dari internet
```

Pull request ke `main` hanya menjalankan `test` dan `build` (tanpa push, tanpa
deploy).

### Arti `/__health`

| Status | Arti |
| --- | --- |
| `200` + `{"ok":true,"identities":true}` | Gateway siap dipakai. |
| `503` + `{"ok":false,"identities":false}` | Proses hidup tapi **belum ada identitas S3**, jadi semua request akan ditolak `InvalidAccessKeyId`. Biasanya karena `.env` belum ada atau `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` kosong. |

CI memperlakukan `503` sebagai kegagalan deploy, jadi VPS tanpa `.env` tidak
akan dilaporkan "sukses". Docker healthcheck juga menandai container
`unhealthy` pada kondisi ini.

## Perintah harian di VPS

```bash
cd /srv/apps/s3-mega-drive

docker compose ps                    # status container
docker compose logs -f s3            # log gateway
docker compose logs -f caddy         # log TLS / proxy (mode Caddy)
docker compose pull && docker compose up -d    # deploy manual
docker compose restart s3            # restart saja
docker compose down                  # stop semua (volume tetap ada)
```

Data persistensi ada di volume `s3-state` dan `s3-tmp`; sertifikat Caddy (kalau
mode Caddy dipakai) di `caddy-data`. `docker compose down -v` akan **menghapus**
semuanya.

### Deploy tanpa GHCR (image dari laptop)

Kalau paket GHCR masih privat atau jaringan VPS lambat, image bisa dikirim
langsung dari mesin lokal:

```bash
docker build -t s3-mega-drive:deploy .
docker save s3-mega-drive:deploy | gzip -1 > s3img.tar.gz
scp s3img.tar.gz user@vps:/tmp/
ssh user@vps 'gunzip -c /tmp/s3img.tar.gz | docker load'
```

Lalu di VPS set `IMAGE=s3-mega-drive:deploy` pada `.env` dan jalankan
`docker compose up -d`. Ini cara yang dipakai saat deploy pertama.

## Catatan operasional

**SigV4 lewat reverse proxy.** Reverse proxy (Caddy maupun nginx) harus
meneruskan header `Host` apa adanya: `Host` ikut ditandatangani klien, jadi
kalau diubah semua request gagal dengan `SignatureDoesNotMatch`. Kompresi
respons juga sengaja tidak diaktifkan karena body S3 tidak boleh diubah
(menyangkut `Content-Length` dan `Content-Range` untuk unduhan bertahap).

**Upload lambat atau menggantung.** Pastikan `proxy_request_buffering off` ada
di vhost nginx. Tanpa itu nginx menampung seluruh body upload ke disk lebih
dulu, sehingga upload besar menghabiskan disk dan terasa macet.

**Uji dengan curl bisa gagal palsu.** `curl --aws-sigv4` versi lama (mis. 7.88)
menandatangani body upload secara berbeda sehingga muncul `SignatureDoesNotMatch`
padahal kredensial benar. Uji dengan AWS SDK resmi (`test/s3-sdk.mjs`) untuk
hasil yang dapat dipercaya.

**Ukuran upload.** Batas 5 GB dipasang di tiga tempat: `request_body` di
Caddyfile, `S3_MAX_BODY_BYTES` di aplikasi, dan `maxRequestBodySize` di
`Bun.serve`. Kalau menaikkan salah satu, naikkan juga yang lain.

**Kuota disk.** Setiap deploy menghasilkan tag `sha-*` baru. Workflow menjalankan
`docker image prune` setelah deploy sukses, dan membuang image tak terpakai yang
lebih tua dari 72 jam. Container yang sedang jalan tidak pernah ikut terhapus.

**Rollback.** Kalau container tidak sehat dalam 60 detik, workflow mengembalikan
baris `IMAGE=` ke nilai sebelumnya dan menjalankan ulang compose, lalu gagal
dengan exit code 1 supaya terlihat merah di GitHub. Log container ikut
dicetak ke output job.

**ARM.** Kalau VPS memakai ARM (mis. Hetzner CAX, Oracle Ampere), set variable
`BUILD_PLATFORMS` ke `linux/arm64`. Tanpa itu container akan gagal start dengan
error `exec format error`.
