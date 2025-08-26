// src/app/api/plans/[planId]/preview/route.ts
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createWriteStream, createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const exec = promisify(execFile)

export async function GET(
  _req: Request,
  { params }: { params: { planId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const usingMinio = process.env.STORAGE_PROVIDER === 'minio'
  const endpoint = usingMinio
    ? process.env.S3_PUBLIC_BASE_URL?.replace(/\/[^/]+$/, '')
    : undefined

  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    endpoint,
    forcePathStyle: usingMinio || undefined,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! }
      : undefined,
  })

  const tmp = await mkdtemp(join(tmpdir(), 'preview-'))
  const pdfPath = join(tmp, 'in.pdf')
  const outBase = join(tmp, 'page1') // pdftoppm will append .png
  const pngPath = `${outBase}.png`

  try {
    // download the PDF to disk
    const obj = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET!, Key: plan.fileKey
    }))
    const body = obj.Body as any
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(pdfPath)
      body.pipe(ws)
      body.on('error', reject)
      ws.on('finish', resolve)
      ws.on('error', reject)
    })

    // render page 1 @ 150 dpi for a light preview
    await exec('pdftoppm', ['-singlefile', '-r', '150', '-png', pdfPath, outBase])

    // stream the PNG back
    const stream = createReadStream(pngPath)
    return new Response(stream as any, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('preview error:', e)
    return NextResponse.json({ error: 'preview failed' }, { status: 500 })
  } finally {
    // best-effort cleanup
    await rm(tmp, { recursive: true, force: true })
  }
}
