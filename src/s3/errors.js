// Error bergaya S3: kode, status HTTP, dan pembentukan respons XML.
const STATUS = {
  AccessDenied: 403,
  AuthorizationHeaderMalformed: 400,
  BadDigest: 400,
  BucketAlreadyExists: 409,
  BucketAlreadyOwnedByYou: 409,
  BucketNotEmpty: 409,
  EntityTooLarge: 400,
  EntityTooSmall: 400,
  IncompleteBody: 400,
  InternalError: 500,
  InvalidAccessKeyId: 403,
  InvalidArgument: 400,
  InvalidBucketName: 400,
  InvalidPart: 400,
  InvalidPartOrder: 400,
  InvalidRange: 416,
  InvalidRequest: 400,
  KeyTooLongError: 400,
  MalformedXML: 400,
  MethodNotAllowed: 405,
  NoSuchBucket: 404,
  NoSuchKey: 404,
  NoSuchUpload: 404,
  NotImplemented: 501,
  PreconditionFailed: 412,
  RequestTimeTooSkewed: 403,
  SignatureDoesNotMatch: 403,
  SlowDown: 503,
  XAmzContentSHA256Mismatch: 400,
}

export class S3Error extends Error {
  constructor(code, message, { status, resource } = {}) {
    super(message ?? code)
    this.name = 'S3Error'
    this.code = code
    this.status = status ?? STATUS[code] ?? 500
    this.resource = resource ?? null
  }
}

/** Ubah error apa pun (termasuk HttpError dari mega.js) menjadi S3Error. */
export function toS3Error(err, resource) {
  if (err instanceof S3Error) return err
  const status = err?.status
  if (status === 404) return new S3Error('NoSuchKey', err.message, { resource })
  if (status === 409) return new S3Error('InvalidRequest', err.message, { resource })
  if (status === 411) return new S3Error('IncompleteBody', err.message, { resource })
  if (status === 416) return new S3Error('InvalidRange', err.message, { resource })
  if (status === 509 || /bandwidth limit/i.test(err?.message ?? '')) {
    return new S3Error('SlowDown', err.message, { resource })
  }
  return new S3Error('InternalError', err?.message ?? 'Terjadi kesalahan', { resource })
}
