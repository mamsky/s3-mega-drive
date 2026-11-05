// Pembentuk respons XML sesuai format S3 (S3 API 2006-03-01).
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>'
export const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/'

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function unescapeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function isoDate(value) {
  const date = value ? new Date(value) : new Date()
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

/** EncodingType=url: key di-encode, tetapi "/" dibiarkan. */
function encodeKey(key, encodingType) {
  if (encodingType !== 'url') return escapeXml(key)
  return escapeXml(encodeURIComponent(key).replace(/%2F/g, '/'))
}

export function errorXml({ code, message, resource, requestId }) {
  return (
    `${XML_DECL}<Error>` +
    `<Code>${escapeXml(code)}</Code>` +
    `<Message>${escapeXml(message)}</Message>` +
    (resource ? `<Resource>${escapeXml(resource)}</Resource>` : '') +
    `<RequestId>${escapeXml(requestId)}</RequestId>` +
    `</Error>`
  )
}

export function ownerXml(owner) {
  return `<Owner><ID>${escapeXml(owner.id)}</ID><DisplayName>${escapeXml(owner.name)}</DisplayName></Owner>`
}

export function listBucketsXml(buckets, owner) {
  const items = buckets
    .map(
      (bucket) =>
        `<Bucket><Name>${escapeXml(bucket.name)}</Name><CreationDate>${isoDate(bucket.createdAt)}</CreationDate></Bucket>`
    )
    .join('')
  return (
    `${XML_DECL}<ListAllMyBucketsResult xmlns="${S3_NS}">` +
    ownerXml(owner) +
    `<Buckets>${items}</Buckets>` +
    `</ListAllMyBucketsResult>`
  )
}

export function listObjectsXml({
  bucket,
  prefix = '',
  delimiter = '',
  maxKeys = 1000,
  isTruncated = false,
  contents = [],
  commonPrefixes = [],
  continuationToken = null,
  nextToken = null,
  startAfter = null,
  encodingType = null,
}) {
  const objects = contents
    .map(
      (item) =>
        `<Contents>` +
        `<Key>${encodeKey(item.key, encodingType)}</Key>` +
        `<LastModified>${isoDate(item.lastModified)}</LastModified>` +
        `<ETag>&quot;${escapeXml(item.etag)}&quot;</ETag>` +
        `<Size>${Number(item.size ?? 0)}</Size>` +
        `<StorageClass>STANDARD</StorageClass>` +
        `</Contents>`
    )
    .join('')

  const prefixes = commonPrefixes
    .map((item) => `<CommonPrefixes><Prefix>${encodeKey(item, encodingType)}</Prefix></CommonPrefixes>`)
    .join('')

  return (
    `${XML_DECL}<ListBucketResult xmlns="${S3_NS}">` +
    `<Name>${escapeXml(bucket)}</Name>` +
    `<Prefix>${encodeKey(prefix, encodingType)}</Prefix>` +
    (delimiter ? `<Delimiter>${encodeKey(delimiter, encodingType)}</Delimiter>` : '') +
    `<MaxKeys>${maxKeys}</MaxKeys>` +
    `<KeyCount>${contents.length + commonPrefixes.length}</KeyCount>` +
    `<IsTruncated>${isTruncated ? 'true' : 'false'}</IsTruncated>` +
    (continuationToken ? `<ContinuationToken>${escapeXml(continuationToken)}</ContinuationToken>` : '') +
    (nextToken ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>` : '') +
    (startAfter ? `<StartAfter>${encodeKey(startAfter, encodingType)}</StartAfter>` : '') +
    (encodingType ? `<EncodingType>${escapeXml(encodingType)}</EncodingType>` : '') +
    objects +
    prefixes +
    `</ListBucketResult>`
  )
}

export function initiateMultipartXml(bucket, key, uploadId) {
  return (
    `${XML_DECL}<InitiateMultipartUploadResult xmlns="${S3_NS}">` +
    `<Bucket>${escapeXml(bucket)}</Bucket>` +
    `<Key>${escapeXml(key)}</Key>` +
    `<UploadId>${escapeXml(uploadId)}</UploadId>` +
    `</InitiateMultipartUploadResult>`
  )
}

export function completeMultipartXml({ location, bucket, key, etag }) {
  return (
    `${XML_DECL}<CompleteMultipartUploadResult xmlns="${S3_NS}">` +
    `<Location>${escapeXml(location)}</Location>` +
    `<Bucket>${escapeXml(bucket)}</Bucket>` +
    `<Key>${escapeXml(key)}</Key>` +
    `<ETag>&quot;${escapeXml(etag)}&quot;</ETag>` +
    `</CompleteMultipartUploadResult>`
  )
}

export function listPartsXml({ bucket, key, uploadId, parts, maxParts = 1000, isTruncated = false }) {
  const items = parts
    .map(
      (part) =>
        `<Part>` +
        `<PartNumber>${part.partNumber}</PartNumber>` +
        `<LastModified>${isoDate(part.lastModified)}</LastModified>` +
        `<ETag>&quot;${escapeXml(part.etag)}&quot;</ETag>` +
        `<Size>${Number(part.size ?? 0)}</Size>` +
        `</Part>`
    )
    .join('')
  return (
    `${XML_DECL}<ListPartsResult xmlns="${S3_NS}">` +
    `<Bucket>${escapeXml(bucket)}</Bucket>` +
    `<Key>${escapeXml(key)}</Key>` +
    `<UploadId>${escapeXml(uploadId)}</UploadId>` +
    `<MaxParts>${maxParts}</MaxParts>` +
    `<IsTruncated>${isTruncated ? 'true' : 'false'}</IsTruncated>` +
    items +
    `</ListPartsResult>`
  )
}

export function listMultipartUploadsXml({ bucket, uploads, prefix = '', maxUploads = 1000 }) {
  const items = uploads
    .map(
      (upload) =>
        `<Upload>` +
        `<Key>${escapeXml(upload.key)}</Key>` +
        `<UploadId>${escapeXml(upload.uploadId)}</UploadId>` +
        `<Initiated>${isoDate(upload.initiated)}</Initiated>` +
        `<StorageClass>STANDARD</StorageClass>` +
        `</Upload>`
    )
    .join('')
  return (
    `${XML_DECL}<ListMultipartUploadsResult xmlns="${S3_NS}">` +
    `<Bucket>${escapeXml(bucket)}</Bucket>` +
    `<Prefix>${escapeXml(prefix)}</Prefix>` +
    `<MaxUploads>${maxUploads}</MaxUploads>` +
    `<IsTruncated>false</IsTruncated>` +
    items +
    `</ListMultipartUploadsResult>`
  )
}

export function deleteResultXml({ deleted = [], errors = [] }) {
  const ok = deleted.map((item) => `<Deleted><Key>${escapeXml(item)}</Key></Deleted>`).join('')
  const failed = errors
    .map(
      (item) =>
        `<Error><Key>${escapeXml(item.key)}</Key><Code>${escapeXml(item.code)}</Code>` +
        `<Message>${escapeXml(item.message)}</Message></Error>`
    )
    .join('')
  return `${XML_DECL}<DeleteResult xmlns="${S3_NS}">${ok}${failed}</DeleteResult>`
}

export function copyObjectXml({ etag, lastModified }) {
  return (
    `${XML_DECL}<CopyObjectResult xmlns="${S3_NS}">` +
    `<ETag>&quot;${escapeXml(etag)}&quot;</ETag>` +
    `<LastModified>${isoDate(lastModified)}</LastModified>` +
    `</CopyObjectResult>`
  )
}

export function locationXml(region) {
  return `${XML_DECL}<LocationConstraint xmlns="${S3_NS}">${escapeXml(region)}</LocationConstraint>`
}

export function versioningXml() {
  return `${XML_DECL}<VersioningConfiguration xmlns="${S3_NS}"></VersioningConfiguration>`
}

export function aclXml(owner) {
  return (
    `${XML_DECL}<AccessControlPolicy xmlns="${S3_NS}">` +
    ownerXml(owner) +
    `<AccessControlList>` +
    `<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">` +
    `<ID>${escapeXml(owner.id)}</ID><DisplayName>${escapeXml(owner.name)}</DisplayName></Grantee>` +
    `<Permission>FULL_CONTROL</Permission></Grant>` +
    `</AccessControlList>` +
    `</AccessControlPolicy>`
  )
}

export function corsXml(rules) {
  const items = rules
    .map((rule) => {
      const origins = (rule.allowedOrigins ?? []).map((v) => `<AllowedOrigin>${escapeXml(v)}</AllowedOrigin>`).join('')
      const methods = (rule.allowedMethods ?? []).map((v) => `<AllowedMethod>${escapeXml(v)}</AllowedMethod>`).join('')
      const headers = (rule.allowedHeaders ?? []).map((v) => `<AllowedHeader>${escapeXml(v)}</AllowedHeader>`).join('')
      const expose = (rule.exposeHeaders ?? []).map((v) => `<ExposeHeader>${escapeXml(v)}</ExposeHeader>`).join('')
      return (
        `<CORSRule>` +
        origins +
        methods +
        headers +
        expose +
        (rule.maxAgeSeconds ? `<MaxAgeSeconds>${Number(rule.maxAgeSeconds)}</MaxAgeSeconds>` : '') +
        `</CORSRule>`
      )
    })
    .join('')
  return `${XML_DECL}<CORSConfiguration xmlns="${S3_NS}">${items}</CORSConfiguration>`
}
