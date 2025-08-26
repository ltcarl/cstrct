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
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

// preprocess the crop: pad a bit, grayscale, normalize, binarize, upscale 2x
async function prepareNumberCrop(pngPath: string, region: Region) {
  const img = sharp(pngPath)
  const meta = await img.metadata()
  const W = meta.width || 0
  const H = meta.height || 0

  // add 8% padding around the region to avoid clipping last char
  const pad = 0.08
  const left  = Math.max(0, Math.floor((region.xPct - pad) * W))
  const top   = Math.max(0, Math.floor((region.yPct - pad) * H))
  const w     = Math.min(W - left, Math.floor((region.wPct + pad * 2) * W))
  const h     = Math.min(H - top,  Math.floor((region.hPct + pad * 2) * H))

  const out = `${pngPath.replace(/\.png$/, '')}-num-${randomUUID()}.png`

  await sharp(pngPath)
    .extract({ left, top, width: w, height: h })
    .grayscale()
    .normalize()                 // improve contrast
    .threshold(180)             // binarize
    .resize(w * 2, h * 2, {    // upscale 2x to help thin glyphs like '1'
      kernel: 'lanczos3'
    })
    .toFile(out)

  return out
}

async function tesseractStdout(imgPath: string, psm: '7'|'8') {
  const args = [
    imgPath, 'stdout',
    '-l', 'eng',
    '--oem', '1',
    '--psm', psm,
    '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-'
  ]
  const { stdout } = await exec('tesseract', args)
  return (stdout || '').trim()
}

// Accepts IDs like: M1.01, P-101, FP101, A2.3, E-002, M-201A,
// and also digit-first like: 68H01, 15P101, 1M101, 2A-03, 01G.02
function pickSheetNumber(text?: string) {
  if (!text) return undefined
  const T = text.toUpperCase()

  // 1) Collect candidates from several flexible patterns:
  const patterns = [
    /\b[A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?\b/g,   // letter-first (old)
    /\b\d{1,3}[A-Z]{1,3}\d{1,4}\b/g,                  // digit + letter + digit (e.g., 68H01, 15P101)
    /\b\d{1,3}[A-Z]{1,3}(?:-\d{1,4}|\.\d{1,3})\b/g,   // 01G-02, 01G.02
    /\b[A-Z]\d[A-Z]\d{2,3}\b/g,                       // M1A101 style
  ]

  const hits = new Set<string>()
  for (const rx of patterns) {
    for (const m of T.matchAll(rx)) hits.add(m[0])
  }

  // nothing matched
  if (!hits.size) return undefined

  // 2) Score candidates: prefer mix of letters+digits, sane length, and common discipline hints
  const score = (s: string) => {
    let sc = 0
    const len = s.replace(/\s/g,'').length
    if (len >= 3 && len <= 8) sc += 2
    if (/[A-Z]/.test(s) && /\d/.test(s)) sc += 3
    if (/[.-]/.test(s)) sc += 1
    if (/^(HVAC|ME|M|FP|P|PL|A|E|S)/.test(s)) sc += 1
    // slight nudge if it ends with 2–3 digits (common)
    if (/\d{2,3}$/.test(s)) sc += 1
    return sc
  }

  // 3) Pick highest scored; break ties by shorter, then original order
  const ordered = Array.from(hits)
    .map(v => ({ v, s: score(v) }))
    .sort((a,b) => b.s - a.s || a.v.length - b.v.length)

  return ordered[0]?.v?.replace(/\s+/g, '')
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
    const numberRegion = project?.ocrNumberRegion as Region | null
    if (numberRegion) {
      try {
        // preprocess the crop first (padding + binarize + 2x)
        const numImg = await prepareNumberCrop(pngPath, numberRegion)
    
        // pass 1: single line (psm 7)
        const pass1 = await tesseractStdout(numImg, '7')
    
        // pass 2: single word (psm 8) — often better for IDs like 68H01
        const pass2 = await tesseractStdout(numImg, '8')
    
        // choose the pass that yields the stronger sheet number
        const cand1 = pickSheetNumber(pass1) || ''
        const cand2 = pickSheetNumber(pass2) || ''
    
        // scoring: prefer longer alnum strings, then the one that ends with a digit
        const score = (s: string) =>
          (s.replace(/[^A-Z0-9.-]/g, '').length) +
          (/\d$/.test(s) ? 1 : 0)
    
        numText = score(cand2) > score(cand1) ? cand2 : cand1
      } catch {}
    }

    let titleText = ''
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
