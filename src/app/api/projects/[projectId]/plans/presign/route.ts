import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const s3 = new S3Client({ region: process.env.AWS_REGION })

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { filename, contentType } = await req.json()
  if (!filename || !contentType) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  const key = `projects/${params.projectId}/plans/${Date.now()}-${filename}`
  const command = new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, ContentType: contentType })
  const url = await getSignedUrl(s3, command, { expiresIn: 60 })
  const publicUrl = `${process.env.S3_PUBLIC_BASE_URL}/${key}`
  return NextResponse.json({ uploadUrl: url, key, publicUrl })
}
