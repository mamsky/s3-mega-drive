// Uji kompatibilitas dengan AWS SDK resmi (bukan penandatangan manual).
// Membuktikan gateway benar-benar "mirip AWS" dari sisi klien.
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand, CopyObjectCommand, CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:3101'
const BUCKET = process.env.S3_TEST_BUCKET ?? `sdk-${Date.now().toString(36)}`

const client = new S3Client({
  endpoint: ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'testkey',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'testsecret',
  },
  forcePathStyle: true,
})

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function body(res) {
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

console.log(`\nAWS SDK compatibility test — ${ENDPOINT}, bucket "${BUCKET}"\n`)

try {
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  check('CreateBucket via SDK', true)

  const image = Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(200))
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: 'foto/profil.png', Body: image, ContentType: 'image/png' }))
  check('PutObject via SDK', true, `${image.length} byte`)

  const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: 'foto/profil.png' }))
  check('HeadObject via SDK', head.ContentLength === image.length, `${head.ContentLength} byte, ${head.ContentType}`)

  const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'foto/profil.png' }))
  const gotBody = await body(got)
  check('GetObject via SDK', gotBody.equals(image))

  const ranged = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'foto/profil.png', Range: 'bytes=0-7' }))
  const rangedBody = await body(ranged)
  check('Range via SDK', rangedBody.length === 8, `${rangedBody.length} byte, ContentRange=${ranged.ContentRange}`)

  await client.send(new CopyObjectCommand({ Bucket: BUCKET, Key: 'foto/salinan.png', CopySource: `${BUCKET}/foto/profil.png` }))
  const copied = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'foto/salinan.png' }))
  check('CopyObject via SDK', (await body(copied)).equals(image))

  const listed = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'foto/' }))
  check('ListObjectsV2 via SDK', listed.KeyCount === 2, `${listed.KeyCount} key`)

  const presignedUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: 'foto/profil.png' }), { expiresIn: 300 })
  const presignedRes = await fetch(presignedUrl)
  const presignedBody = Buffer.from(await presignedRes.arrayBuffer())
  check('presigned URL dari SDK berfungsi', presignedRes.status === 200 && presignedBody.equals(image), `HTTP ${presignedRes.status}`)

  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'foto/profil.png' }))
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'foto/salinan.png' }))
  await client.send(new DeleteBucketCommand({ Bucket: BUCKET }))
  check('DeleteObject + DeleteBucket via SDK', true)
} catch (err) {
  failed += 1
  console.log(`  FAIL  error tak terduga — ${err.name}: ${err.message}`)
  if (err.$metadata) console.log(`        HTTP ${err.$metadata.httpStatusCode}`)
}

console.log(`\n${passed} lulus, ${failed} gagal\n`)
process.exit(failed === 0 ? 0 : 1)
