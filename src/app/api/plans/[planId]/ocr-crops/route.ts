import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import sharp from 'sharp'

const exec = promisify(execFile)

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

export async function GET(_req: Request, { params }: { params: { planId: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  const project = await prisma.project.findUnique({
    where: { id: plan.projectId },
    select: { ocrDpi: true, ocrNumberRegion: true, ocrTitleRegion: true },
  })
  const numberRegion = project?.ocrNumberRegion as Region | null
  const titleRegion  = project?.ocrTitleRegion  as Region | null
  if (!numberRegion && !titleRegion) {
    return NextResponse.json({ error: 'No OCR regions set on project' }, { status: 400 })
  }

  // S3/minio client (same as elsewhere)
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

  const tmp = await mkdtemp(join(tmpdir(), 'ocrdbg-'))
  const pdfPath = join(tmp, 'in.pdf')
  const outBase = join(tmp, 'page1')
  const pngPath = `${outBase}.png`

  try {
    // download
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

    // rasterize at project dpi (default 300) so this matches OCR route exactly
    const dpi = project?.ocrDpi ?? 300
    await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])

    const base = sharp(pngPath)
    const meta = await base.metadata()
    const W = meta.width || 0
    const H = meta.height || 0

    async function cropToB64(region: Region) {
      const left = Math.max(0, Math.floor(region.xPct * W))
      const top  = Math.max(0, Math.floor(region.yPct * H))
      const w    = Math.min(W - left, Math.floor(region.wPct * W))
      const h    = Math.min(H - top,  Math.floor(region.hPct * H))
      const buf = await sharp(pngPath).extract({ left, top, width: w, height: h }).toBuffer()
      return 'data:image/png;base64,' + buf.toString('base64')
    }

    const previewBuf = await readFile(pngPath)
    const json = {
      dpi,
      previewPng: 'data:image/png;base64,' + previewBuf.toString('base64'),
      numberCrop: numberRegion ? await cropToB64(numberRegion) : null,
      titleCrop:  titleRegion  ? await cropToB64(titleRegion)  : null,
    }
    return NextResponse.json(json, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('ocr-crops error:', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
