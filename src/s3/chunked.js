// Decoder body "aws-chunked" (STREAMING-AWS4-HMAC-SHA256-PAYLOAD).
// AWS SDK memakai framing chunk ini saat upload tanpa Content-Length (mis. lib-storage).

/**
 * Decode payload aws-chunked menjadi Buffer biasa.
 * Format tiap chunk: "<hex-size>;chunk-signature=<64 hex>\r\n<data>\r\n"
 * Diakhiri chunk berukuran 0.
 */
export function decodeAwsChunked(buffer) {
  const chunks = []
  let offset = 0

  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf('\r\n', offset)
    if (headerEnd === -1) break

    const header = buffer.subarray(offset, headerEnd).toString('latin1')
    const [sizeText] = header.split(';')
    const size = Number.parseInt(sizeText, 16)
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`Header chunk tidak valid: "${header}"`)
    }

    const dataStart = headerEnd + 2
    if (size === 0) break

    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) {
      throw new Error('Body aws-chunked terpotong: data chunk lebih pendek dari yang dideklarasikan')
    }
    chunks.push(buffer.subarray(dataStart, dataEnd))
    offset = dataEnd + 2 // lewati \r\n setelah data
  }

  return Buffer.concat(chunks)
}

/** Deteksi apakah body memakai framing aws-chunked. */
export function looksAwsChunked(buffer) {
  if (!buffer || buffer.length < 32) return false
  const head = buffer.subarray(0, 200).toString('latin1')
  return /^[0-9a-fA-F]+;chunk-signature=[0-9a-fA-F]{64}\r\n/.test(head)
}
