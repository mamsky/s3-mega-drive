import sharp from 'sharp'

const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function isCompressibleImage(mime) {
  return COMPRESSIBLE.has(mime)
}

/** Return { buffer, originalSize, compressedSize } atau null kalau tidak menguntungkan / tidak didukung. */
export async function compressImage(buffer, quality = 85) {
  const meta = await sharp(buffer).metadata()
  if ((meta.pages ?? 1) > 1) return null

  let pipeline = sharp(buffer).rotate()
  if (meta.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true })
  } else if (meta.format === 'png') {
    pipeline = pipeline.png({ quality, compressionLevel: 9, palette: true })
  } else if (meta.format === 'webp') {
    pipeline = pipeline.webp({ quality })
  } else {
    return null
  }

  const out = await pipeline.toBuffer()
  if (out.length >= buffer.length) return null
  return { buffer: out, originalSize: buffer.length, compressedSize: out.length }
}
