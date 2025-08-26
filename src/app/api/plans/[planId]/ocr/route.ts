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

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

// --- Parsers tuned for plan sheets ---
function pickSheetNumber(text: string | undefined) {
  if (!text) return undefined
  // Examples: M1.01, P-101, FP101, A2.3, E-002, M-201A
  const rx = /\b([A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?)\b/g
  const hits = [...text.toUpperCase().matchAll(rx)].map(m => m[1])
  // prefer ones starting with known disciplines
  const pref = hits.find(h => /^(M|P|FP|A|E|S|ME|HVAC|PL|ARCH|ELEC)/.test(h))
  return pref || hits[0]
}

function pickTitle(text: string | undefined) {
  if (!text) return undefined
  const lines = text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  // choose the longest all-caps-ish line as title
  const caps = lines
    .filter(l => /^[A-Z0-9 \-_/()]+$/.test(l) && l.length >= 8)
    .sort((a, b) => b.length - a.length)
  return (caps[0] || lines[0] || '').replace(/\s+/g, ' ').trim() || undefined
}

function guessDiscipline(number?: string, title?: string) {
  const hay = ((number || '') + ' ' + (title || '')).toLowerCase()
  if (/(^|[^a-z])m\d|hvac/.test(hay)) return 'HVAC'
  if (/\bp[-\d]|plumb|\bfp[-\d]/.test(hay)) return 'PLUMB'
  if (/\be[-\d]|elec/.test(hay)) return 'ELEC'
  if (/\ba[-\d]|arch/.test(hay)) return 'ARCH'
  if (/\bs[-\d]|struct/.test(hay)) return 'STRUCT'
  return undefined
}

async function ocrCropPng(pngPath: string, region: Region) {
  const img = sharp(pngPath)
  const meta = await img.metadata()
  const width = meta.width || 0
  const height = meta.height || 0

  const crop = {
    left: Math.max(0, Math.floor(region.xPct * width)),
    top: Math.max(0, Math.floor(region.yPct * height)),
    width: Math.min(width, Math.floor(region.wPct * width)),
    height: Math.min(height, Math.floor(region.hPct * height)),
  }
  const out = `${pngPath.replace(/\.png$/, '')}-${crop.left}x${crop.top}.png`
  await img.extract(crop).toFile(out)

  const { stdout } = await exec('tesseract', [
    out, 'stdout',
    '-l', 'eng', '--oem', '1', '--psm', '6',
    '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.- /()'
  ])
  return stdout || ''
}

export async function POST(req: Request, { params }: { params: { planId: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  // Pull project OCR settings (our regions!)
  const project = await prisma.project.findUnique({
    where: { id: plan.projectId },
    select: { ocrDpi: true, ocrNumberRegion: true, ocrTitleRegion: true }
  })

  await prisma.planSheet.update({
    where: { id: plan.id },
    data: { ocrStatus: 'RUNNING' },
  })

  // S3/MinIO client
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

  const tmp = await mkdtemp(join(tmpdir(), 'ocr-'))
  const pdfPath = join(tmp, 'in.pdf')
  const outBase = join(tmp, 'page1')
  const pngPath = `${outBase}.png`

  try {
    // Download PDF
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

    // Always rasterize first so we can use your regions
    const dpi = project?.ocrDpi ?? 300
    await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])

    // 1) Use your saved regions first (if present)
    let numText = ''
    let titleText = ''

    const numberRegion = project?.ocrNumberRegion as Region | null
    if (numberRegion) {
      try { numText = await ocrCropPng(pngPath, numberRegion) } catch {}
    }

    const titleRegion = project?.ocrTitleRegion as Region | null
    if (titleRegion) {
      try { titleText = await ocrCropPng(pngPath, titleRegion) } catch {}
    }

    // 2) If either region text is still sparse, try embedded text quickly to help fill gaps
    let embeddedText = ''
    try {
      const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
      embeddedText = stdout || ''
    } catch {}

    // 3) If still missing, OCR full page fallback (helps when PDF is just an image)
    let fullText = ''
    if ((!numText && !titleText) && (!embeddedText || embeddedText.trim().length < 40)) {
      const { stdout } = await exec('tesseract', [
        pngPath, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'
      ])
      fullText = stdout || ''
    }

    // 4) Pick values with clear precedence:
    //    - sheetNumber from numberRegion first, else from (titleRegion + embedded + full)
    //    - title from titleRegion first, else from (embedded + full + numberRegion)
    const sheetNumber =
      pickSheetNumber(numText) ||
      pickSheetNumber(titleText) ||
      pickSheetNumber(embeddedText) ||
      pickSheetNumber(fullText)

    const title =
      pickTitle(titleText) ||
      pickTitle(embeddedText) ||
      pickTitle(fullText) ||
      pickTitle(numText)

    const disc = guessDiscipline(sheetNumber, title)

    const combinedText = [numText, titleText, embeddedText || fullText].filter(Boolean).join('\n')
    const confidence = Math.min(1, (combinedText.length / 2000) + (sheetNumber ? 0.25 : 0))

    const updated = await prisma.planSheet.update({
      where: { id: plan.id },
      data: {
        ocrStatus: 'DONE',
        ocrSuggestedNumber: sheetNumber || undefined,
        ocrSuggestedTitle: title || undefined,
        ocrSuggestedDisc: disc,
        ocrConfidence: confidence,
        ocrRaw: {
          lengths: {
            numberRegion: numText.length,
            titleRegion: titleText.length,
            embedded: embeddedText.length,
            full: fullText.length
          },
          previewDpi: dpi
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
