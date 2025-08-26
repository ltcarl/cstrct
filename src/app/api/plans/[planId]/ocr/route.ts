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
import { Discipline } from '@prisma/client'
import sharp from 'sharp'

const exec = promisify(execFile)

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

// Number: e.g., M1.01, P-101, FP101, A2.3, E-002, M-201A
function pickSheetNumber(text?: string) {
  if (!text) return undefined
  const rx = /\b([A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?)\b/g
  const hits = [...text.toUpperCase().matchAll(rx)].map(m => m[1])
  if (!hits.length) return undefined
  const pref = hits.find(h => /^(HVAC|ME|M|FP|P|PL|A|E|S)/.test(h))
  return (pref || hits[0]).replace(/\s+/g, '')
}

// Title: join first 2 strong lines
function pickTitleFromRegion(text?: string) {
  if (!text) return undefined
  const lines = text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    // keep lines that look like titles (mostly caps/numbers/punct)
    .filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l) && l.replace(/\s+/g,' ').length >= 5)

  if (!lines.length) return undefined
  const sorted = [...lines].sort((a,b) => b.length - a.length)
  // use the top two unique lines, keep their original order if they appear in sequence
  const top = sorted.slice(0, 2)
  // rebuild in appearance order if possible
  const appearanceOrder = lines.filter(l => top.includes(l))
  const chosen = appearanceOrder.slice(0, 2).join(' ')
  return chosen || top.join(' ')
}

function guessDiscipline(number?: string, title?: string): Discipline | undefined {
  const hay = ((number || '') + ' ' + (title || '')).toLowerCase()

  if (/(^|[^a-z])m\d|hvac/.test(hay)) return Discipline.HVAC
  if (/\bp[-\d]|plumb|\bfp[-\d]/.test(hay)) return Discipline.PLUMB
  if (/\be[-\d]|elec/.test(hay)) return Discipline.ELEC
  if (/\ba[-\d]|arch/.test(hay)) return Discipline.ARCH
  if (/\bs[-\d]|struct/.test(hay)) return Discipline.STRUC 

  return undefined
}

async function ocrCropPng(
  pngPath: string,
  region: Region,
  opts?: {
    psm?: '6' | '7',          // '7' = single line, '6' = block of text
    whitelist?: string,       // tesseract char whitelist
    keepNewlines?: boolean
  }
) {
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

  const args = [
    out, 'stdout',
    '-l', 'eng',
    '--oem', '1',
    '--psm', opts?.psm ?? '6',
  ]
  if (opts?.whitelist) {
    args.push('-c', `tessedit_char_whitelist=${opts.whitelist}`)
  }
  // When we want line breaks preserved, Tesseract's stdout already includes them

  const { stdout } = await exec('tesseract', args)
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

    // Always rasterize so we can use regions
    const dpi = project?.ocrDpi ?? 300
    await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])
    const pngPath = `${outBase}.png`

    // 1) Use saved regions first — with tuned PSM + whitelist
    let numText = ''
    let titleText = ''

    const numberRegion = project?.ocrNumberRegion as Region | null
    if (numberRegion) {
      try {
       // number is usually one line → PSM=7 with tight whitelist
        numText = await ocrCropPng(pngPath, numberRegion, {
          psm: '7',
          whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-'
        })
      } catch {}
    }

    const titleRegion = project?.ocrTitleRegion as Region | null
    if (titleRegion) {
      try {
        // title can be multi-line → PSM=6, keep broad chars and newlines
        titleText = await ocrCropPng(pngPath, titleRegion, {
          psm: '6',
          whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-_()/',
          keepNewlines: true
        })
      } catch {}
    }

// 2) Try embedded text to help only if a field is still missing
let embeddedText = ''
try {
  const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
  embeddedText = stdout || ''
} catch {}

// 3) Full-page OCR only if *both* are missing and embedded text is weak
let fullText = ''
if ((!numText && !titleText) && (!embeddedText || embeddedText.trim().length < 40)) {
  const { stdout } = await exec('tesseract', [
    pngPath, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'
  ])
  fullText = stdout || ''
}

// 4) Lock precedence: region → embedded → full
const sheetNumber =
  pickSheetNumber(numText) ||
  pickSheetNumber(embeddedText) ||
  pickSheetNumber(fullText)

const title =
  pickTitleFromRegion(titleText) ||
  pickTitleFromRegion(embeddedText) ||
  pickTitleFromRegion(fullText)

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
