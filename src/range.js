// Parser header Range yang dipakai bersama oleh REST API dan S3 gateway.
import { HttpError } from './mega.js'

/**
 * Parse header Range terhadap ukuran file. Return null kalau tidak ada Range.
 * @returns {{start:number,end:number}|null}
 */
export function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) throw new HttpError(416, 'Hanya Range sederhana ("bytes=start-end") yang didukung')
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') throw new HttpError(416, 'Header Range kosong')
  if (size <= 0) throw new HttpError(416, 'File kosong tidak punya isi untuk di-range')

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isInteger(suffix) || suffix <= 0) throw new HttpError(416, 'Range suffix tidak valid')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }

  if (!Number.isInteger(start) || start < 0 || start > end) {
    throw new HttpError(416, 'Range di luar ukuran file')
  }
  return { start, end }
}
