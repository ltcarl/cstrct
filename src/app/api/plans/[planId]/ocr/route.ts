// src/app/api/plans/[planId]/ocr/route.ts
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import sharp from 'sharp'

const exec = promisify(execFile)

// --- simple heuristics for sheet number/title/discipline
function parseSuggestions(text: string) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
  // Sheet number examples: M1.01, P-101, A2.3, E-002, FP101
  const numRegex = /\b([A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?)\b/
  const numberMatch = (lines.join(' ').match(numRegex)?.[0] ?? '').toUpperCase()

  const titleCandidate =
    lines.find(l => l.length > 8 && /^[A-Z0-9 \-_/()]+$/.test(l)) || lines[0] || ''

  // Discipline guess
  const hay = (titleCandidate + ' ' + numberMatch).toLowerCase()
  let disc: any = undefined
  if (/\bhvac\b|(^|[^a-z])m\d/.test(hay)) disc = 'HVAC'
  else if (/\bplumb|\bp[-\d]/.test(hay)) disc = 'PLUMB'
  else if (/\belec|\be[-\d]/.test(hay)) disc = 'ELEC'
  else if (/\barch|\ba[-\d]/.test(hay)) disc = 'ARCH'
  else if (/\bstruct|\bs[-\d]/.test(hay)) disc = 'STRUCT'

  return {
    number: numberMatch || undefined,
    title: titleCandidate.replace(/\s+/g, ' ').trim() || undefined,
    disc,
  }
}

export async function POST(
  _req: Request,
  { params }: { params: { planId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Fetch plan and project (for OCR settings)
  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
  const project = await prisma.project.findUnique({ where: { id: plan.projectId } })

  await prisma.planSheet.update({
    where: { id: plan.id },
    data: { ocrStatus: 'RUNNING' },
  })

  // S3/MinIO client
  const usingMinio = process.env.STORAGE_PROVIDER === 'minio'
  const endpoint = usingMinio
    ? process.env.S3_PUBLIC_BASE_URL?.replace(/\/[^/]+$/, '') // strip "/<bucket>"
    : undefined

  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    endpoint,
    forcePathStyle: usingMinio || undefined,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        }
      : undefined,
  })

  const tmp = await mkdtemp(join(tmpdir(), 'ocr-'))
  const pdfPath = join(tmp, 'in.pdf')
  const pngBase = join(tmp, 'page1')

  try {
    // 1) Download PDF to disk
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: plan.fileKey })
    )
    const body = obj.Body as any
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(pdfPath)
      body.pipe(ws)
      body.on('error', reject)
      ws.on('finish', resolve)
      ws.on('error', reject)
    })

    // 2) Try embedded text first (pdftotext – page 1)
    let text = ''
    try {
      const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
      if (stdout && stdout.trim().length > 40) text = stdout
    } catch {
      /* ignore; will OCR */
    }

    // 3) If embedded text insufficient, rasterize and OCR crop first
    if (!text || text.trim().length < 40) {
      const dpi = project?.ocrDpi ?? 300
      await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, pngBase])
      const pngPath = `${pngBase}.png`

      const img = sharp(pngPath)
      const meta = await img.metadata()
      const width = meta.width || 0
      const height = meta.height || 0
      const isLandscape = width > height

      // default region (percentages) – bottom-right for landscape
      let region: any = project?.ocrRegion || null
      const corner = project?.ocrCorner || 'BOTTOM_RIGHT'
      if (!region) {
        if (isLandscape && corner === 'BOTTOM_RIGHT') {
          region = { xPct: 0.72, yPct: 0.75, wPct: 0.28, hPct: 0.25 }
        } else {
          // fallback: full page
          region = { xPct: 0, yPct: 0, wPct: 1, hPct: 1 }
        }
      }

      // convert to pixel crop
      const crop = {
        left: Math.max(0, Math.floor((region.xPct || 0) * width)),
        top: Math.max(0, Math.floor((region.yPct || 0) * height)),
        width: Math.min(width, Math.floor((region.wPct || 1) * width)),
        height: Math.min(height, Math.floor((region.hPct || 1) * height)),
      }

      const croppedPath = `${pngBase}-crop.png`
      await img.extract(crop).toFile(croppedPath)

      // Tesseract tuned for sheet numbers/text blocks
      const tessCrop = await exec('tesseract', [
        croppedPath,
        'stdout',
        '-l',
        'eng',
        '--oem',
        '1',
        '--psm',
        '6',
        '-c',
        'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- ',
      ])
      text = tessCrop.stdout || ''

      // If the crop is too sparse, OCR full page as a fallback
      if (!text || text.trim().length < 15) {
        const tessFull = await exec('tesseract', [
          `${pngBase}.png`,
          'stdout',
          '-l',
          'eng',
          '--oem',
          '1',
          '--psm',
          '6',
        ])
        text = tessFull.stdout || ''
      }
    }

    // 4) Parse and store suggestions
    const { number, title, disc } = parseSuggestions(text)
    const confidence = Math.min(1, (text.length / 2000) + (number ? 0.25 : 0))

    const updated = await prisma.planSheet.update({
      where: { id: plan.id },
      data: {
        ocrStatus: 'DONE',
        ocrSuggestedNumber: number,
        ocrSuggestedTitle: title,
        ocrSuggestedDisc: disc,
        ocrConfidence: confidence,
        ocrRaw: {
          length: text.length,
          snippet: text.slice(0, 300),
        } as any,
      },
    })

    return NextResponse.json({
      ok: true,
      suggestions: {
        sheetNumber: updated.ocrSuggestedNumber,
        title: updated.ocrSuggestedTitle,
        discipline: updated.ocrSuggestedDisc,
        confidence: updated.ocrConfidence,
      },
    })
  } catch (err) {
    console.error('OCR error:', err)
    await prisma.planSheet.update({
      where: { id: plan.id },
      data: { ocrStatus: 'FAILED' },
    })
    return NextResponse.json({ error: 'OCR failed' }, { status: 500 })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}
