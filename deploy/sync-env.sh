#!/usr/bin/env bash
# Salin .env lokal ke VPS dengan penyaringan yang diperlukan Docker.
#
# Yang diubah:
#   - DATABASE_URL dikosongkan. Nilai di .env lokal biasanya menunjuk
#     127.0.0.1 (Postgres di mesin sendiri). Di VPS alamat itu tidak ada,
#     dan gateway akan crash saat start. Kosong = mode file, tetap jalan penuh.
#   - S3_HOSTNAME / S3_UI_HOSTNAME dipaksa 0.0.0.0 karena di dalam container
#     127.0.0.1 hanya loopback container itu sendiri.
#   - Baris IMAGE= dibuang; CI yang mengisinya setiap deploy.
#   - S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY dibuat kalau belum ada, karena
#     identitas di database lokal tidak ikut pindah saat DATABASE_URL dikosongkan.
#
# Pemakaian:
#   ./deploy/sync-env.sh user@host [/opt/s3-mega-drive]
set -euo pipefail

TARGET="${1:-}"
REMOTE_DIR="${2:-/opt/s3-mega-drive}"
LOCAL_ENV="${LOCAL_ENV:-.env}"

if [ -z "$TARGET" ]; then
  echo "Pemakaian: $0 user@host [/opt/s3-mega-drive]" >&2
  exit 1
fi

if [ ! -f "$LOCAL_ENV" ]; then
  echo "File $LOCAL_ENV tidak ditemukan. Jalankan dari akar project." >&2
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Nilai yang mengandung karakter khusus tetap ditulis apa adanya; .env dibaca
# Docker Compose sebagai teks mentah, bukan shell.
#
# Tiga kunci di bawah sengaja dibuang dari aliran utama lalu ditulis ulang di
# bagian akhir. Kalau dibiarkan, kunci yang di-generate akan muncul dua kali
# (nilai lama + nilai baru) dan hasil akhirnya bergantung pada urutan parsing.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*)
      printf '%s\n' "$line"
      ;;
    DATABASE_URL=*)
      printf '# DATABASE_URL dikosongkan oleh sync-env.sh (mode file).\n'
      ;;
    S3_HOSTNAME=*|S3_UI_HOSTNAME=*)
      ;;
    S3_ACCESS_KEY_ID=*|S3_SECRET_ACCESS_KEY=*|S3_UI_PASSWORD=*)
      ;;
    IMAGE=*)
      ;;
    *)
      printf '%s\n' "$line"
      ;;
  esac
done < "$LOCAL_ENV" > "$TMP"

read_key() {
  grep -E "^$1=" "$LOCAL_ENV" | tail -1 | cut -d= -f2- || true
}

AK=$(read_key S3_ACCESS_KEY_ID)
SK=$(read_key S3_SECRET_ACCESS_KEY)
UI_PW=$(read_key S3_UI_PASSWORD)

printf '\nS3_HOSTNAME=0.0.0.0\nS3_UI_HOSTNAME=0.0.0.0\n' >> "$TMP"

if [ -z "$AK" ] || [ -z "$SK" ]; then
  AK=$(openssl rand -hex 20)
  SK=$(openssl rand -hex 32)
  echo "Kredensial S3 dibuat baru:"
  echo "  S3_ACCESS_KEY_ID=$AK"
  echo "  S3_SECRET_ACCESS_KEY=$SK"
  echo "  Simpan — dipakai klien S3 (aws s3 cp, rclone, SDK)."
fi

if [ -z "$UI_PW" ]; then
  UI_PW=$(openssl rand -hex 12)
  echo "S3_UI_PASSWORD dibuat baru: $UI_PW"
  echo "  Dipakai login console web sebagai identitas \"default\"."
fi

printf 'S3_ACCESS_KEY_ID=%s\nS3_SECRET_ACCESS_KEY=%s\nS3_UI_PASSWORD=%s\n' \
  "$AK" "$SK" "$UI_PW" >> "$TMP"

KEYS=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$TMP" || true)
echo "Mengirim $KEYS variabel ke $TARGET:$REMOTE_DIR/.env"

ssh "$TARGET" "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
scp -q "$TMP" "$TARGET:$REMOTE_DIR/.env"
ssh "$TARGET" "chmod 600 '$REMOTE_DIR/.env'"

echo "Selesai. DATABASE_URL dikosongkan, hostname dipaksa 0.0.0.0."
echo "Periksa di VPS: ssh $TARGET \"grep -cE '^[A-Za-z_]+=' $REMOTE_DIR/.env\""
