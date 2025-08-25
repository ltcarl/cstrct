// src/app/api/projects/[projectId]/plans/presign/route.ts
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'crypto'

/**
 * Env required:
 *  - STORAGE_PROVIDER = "minio" | "aws"
 *  - AWS_ACCESS_KEY_ID
 *  - AWS_SECRET_ACCESS_KEY
 *  - AWS_REGION
 *  - S3_BUCKET
 *  - S3_PUBLIC_BASE_URL  (e.g. http://<server>:9000/<bucket> for MinIO, or your CDN/S3 URL)
 */

export async function POST(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  // 1) Auth guard
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2) Validate body
  let body: { filename?: string; contentType?: string } = {}
  try {
    body = await req.json()
  } catch {
    /* no-op */
  }
  const filename = (body.filename || '').toString()
  const contentType = (body.contentType || 'application/pdf').toString()

  if (!filename) {
    return NextResponse.json({ error: 'filename required' }, { status: 400 })
  }
  if (!process.env.S3_BUCKET || !process.env.AWS_REGION) {
    return NextResponse.json({ error: 'storage not configured' }, { status: 500 })
  }

  // 3) Build an object key (unique + readable)
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `projects/${params.projectId}/plans/${Date.now()}-${crypto
    .randomUUID()
    .slice(0, 8)}-${safeName}`

  // 4) Configure S3 client (MinIO vs AWS via env)
  const usingMinio = process.env.STORAGE_PROVIDER === 'minio'
  const endpoint = usingMinio
    ? process.env.S3_PUBLIC_BASE_URL?.replace(/\/[^/]+$/, '') // strip "/<bucket>"
    : undefined

  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    endpoint,                 // e.g. http://<server>:9000 for MinIO
    forcePathStyle: usingMinio || undefined, // MinIO needs path-style
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        }
      : undefined,
  })

  // 5) Create presigned PUT (set ContentType + cache headers)
  const putCmd = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    ContentType: contentType,
    // Optional headers you may want:
    CacheControl: 'public, max-age=31536000, immutable',
  })

  try {
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 60 * 5 }) // 5 minutes
    const publicBase = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '')
    const publicUrl = `${publicBase}/${key}`

    return NextResponse.json({ uploadUrl, key, publicUrl })
  } catch (err: any) {
    console.error('presign error:', err)
    return NextResponse.json({ error: 'presign failed' }, { status: 500 })
  }
}
