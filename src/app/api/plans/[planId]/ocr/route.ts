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

async function getPdfPageInfo(pdfPath: string) {
  const { stdout } = await exec('pdfinfo', [pdfPath])
  const size = stdout.match(/Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/i)
  // Poppler prints rotation as either “Page rot:” or “Rotate:”
  const rot  = stdout.match(/Page rot:\s+(\d+)/i) || stdout.match(/Rotate:\s+(\d+)/i)

  return {
    w: size ? parseFloat(size[1]) : 612,
    h: size ? parseFloat(size[2]) : 792,
    rot: (rot ? parseInt(rot[1], 10) : 0) as 0 | 90 | 180 | 270,
  }
}

function mapRegionForRotation(
  x: number, y: number, W: number, H: number,
  pageW: number, pageH: number, rot: 0 | 90 | 180 | 270
) {
  switch (rot) {
    case 0:
      return { x, y, W, H }
    case 90:
      // (x, y, W, H) in unrotated space -> (x', y') in 90° page space
      return { x: pageH - (y + H), y: x, W: H, H: W }
    case 180:
      return { x: pageW - (x + W), y: pageH - (y + H), W, H }
    case 270:
      return { x: y, y: pageW - (x + W), W: H, H: W }
  }
}

export async function pdftotextRegion(pdfPath: string, r: RegionPct) {
  const { w: pageW, h: pageH, rot } = await getPdfPageInfo(pdfPath)

  // Region in points in *unrotated* page space
  const x0 = Math.max(0, Math.floor(r.xPct * pageW))
  const y0 = Math.max(0, Math.floor(r.yPct * pageH))
  const W0 = Math.max(1, Math.floor(r.wPct * pageW))
  const H0 = Math.max(1, Math.floor(r.hPct * pageH))

  // Remap to pdftotext’s expected (rotated) page coordinate system
  const { x, y, W, H } = mapRegionForRotation(x0, y0, W0, H0, pageW, pageH, rot)

  const args = [
    '-layout', '-nopgbrk',
    '-f', '1', '-l', '1',
    '-x', String(x), '-y', String(y),
    '-W', String(W), '-H', String(H),
    pdfPath, '-',
  ]
  const { stdout } = await exec('pdftotext', args)
  return (stdout || '').trim()
}

async function pdftotextRegion(pdfPath: string, r: RegionPct) {
  const { w: pageW, h: pageH, rot } = await getPdfPageInfo(pdfPath)

  // region → points in *unrotated* page space
  const x0 = Math.max(0, Math.floor(r.xPct * pageW))
  const y0 = Math.max(0, Math.floor(r.yPct * pageH))
  const W0 = Math.max(1, Math.floor(r.wPct * pageW))
  const H0 = Math.max(1, Math.floor(r.hPct * pageH))

  // remap for rotated page
  const { x, y, W, H } = mapRegionForRotation(x0, y0, W0, H0, pageW, pageH, rot)

  const args = ['-layout', '-nopgbrk', '-f', '1', '-l', '1',
                '-x', String(x), '-y', String(y), '-W', String(W), '-H', String(H),
                pdfPath, '-']
  const { stdout } = await exec('pdftotext', args)
  return (stdout || '').trim()
}

/** Read page size in points from pdfinfo (first page) */
async function getPdfPageSizePts(pdfPath: string) {
  const { stdout } = await exec('pdfinfo', [pdfPath])
  // Look for: "Page size:   841.89 x 595.28 pts"
  const m = stdout.match(/Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/i)
  if (!m) return { w: 612, h: 792 } // default Letter portrait, won’t hurt
  return { w: parseFloat(m[1]), h: parseFloat(m[2]) }
}

async function pdftotextRegion(pdfPath: string, regionPct: { xPct: number; yPct: number; wPct: number; hPct: number }) {
  const { w: pageWpts, h: pageHpts } = await getPdfPageSizePts(pdfPath)

  const x = Math.max(0, Math.floor(regionPct.xPct * pageWpts))
  const y = Math.max(0, Math.floor(regionPct.yPct * pageHpts))
  const W = Math.max(1, Math.floor(regionPct.wPct * pageWpts))
  const H = Math.max(1, Math.floor(regionPct.hPct * pageHpts))

  // -layout preserves ordering; -f/-l 1 clamp to page 1; -x/-y/-W/-H clip to rectangle (points; origin top-left)
  const args = ['-layout', '-nopgbrk', '-f', '1', '-l', '1', '-x', String(x), '-y', String(y), '-W', String(W), '-H', String(H), pdfPath, '-']
  const { stdout } = await exec('pdftotext', args)
  return (stdout || '').trim()
}

async function makeNumberCropVariant(
  pngPath: string,
  region: { xPct: number; yPct: number; wPct: number; hPct: number },
  opts: {
    threshold?: number
    padPct?: number
    innerTrimPct?: number   // <-- add this
  }
) {
  const img = sharp(pngPath)
  const meta = await img.metadata()
  const W = meta.width || 0
  const H = meta.height || 0

  let left = Math.max(0, Math.floor(region.xPct * W))
  let top = Math.max(0, Math.floor(region.yPct * H))
  let width = Math.min(W - left, Math.floor(region.wPct * W))
  let height = Math.min(H - top, Math.floor(region.hPct * H))

  // apply padding
  if (opts.padPct) {
    left = Math.max(0, left - Math.floor(width * opts.padPct))
    top = Math.max(0, top - Math.floor(height * opts.padPct))
    width = Math.min(W - left, width + Math.floor(width * opts.padPct * 2))
    height = Math.min(H - top, height + Math.floor(height * opts.padPct * 2))
  }

  // apply inner trim
  if (opts.innerTrimPct) {
    left += Math.floor(width * opts.innerTrimPct)
    width -= Math.floor(width * opts.innerTrimPct * 2)
    top += Math.floor(height * opts.innerTrimPct)
    height -= Math.floor(height * opts.innerTrimPct * 2)
  }

  const outPath = `${pngPath.replace(/\.png$/, '')}-num-${Date.now()}.png`
  let proc = sharp(pngPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .resize(width * 3, height * 3)

  if (typeof opts.threshold === 'number') {
    proc = proc.threshold(opts.threshold)
  }

  await proc.toFile(outPath)
  return outPath
}

type PSM = '7' | '8'
async function tesseractNumber(imgPath: string, psm: PSM = '8'): Promise<string> {
  const args = [
    imgPath, 'stdout',
    '-l', 'eng',
    '--oem', '3',                // LSTM+legacy (more robust on codes)
    '--psm', psm,
    // Turn off dictionaries; treat as code, not a word
    '-c', 'load_system_dawg=0',
    '-c', 'load_freq_dawg=0',
    // Alphanumeric + common separators for sheet ids
    '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-',
    // Prefer numeric layout; keep spacing if any
    '-c', 'classify_bln_numeric_mode=1',
    '-c', 'preserve_interword_spaces=1',
  ]

  const { stdout } = await exec('tesseract', args)
  return (stdout || '').trim()
}

// Rotate an existing PNG crop and OCR it, returning raw text
async function ocrRotated(
  imgPath: string,
  angle: 0 | 90 | 270,
  opts?: { psm?: '6' | '7'; whitelist?: string }
) {
  const rotated = angle === 0 ? imgPath : `${imgPath.replace(/\.png$/, '')}-rot${angle}.png`
  if (angle !== 0) {
    await sharp(imgPath).rotate(angle).toFile(rotated)
  }
  const args = [
    rotated, 'stdout',
    '-l', 'eng',
    '--oem', '1',
    '--psm', opts?.psm ?? '6',
  ]
  if (opts?.whitelist) args.push('-c', `tessedit_char_whitelist=${opts.whitelist}`)
  const { stdout } = await exec('tesseract', args)
  return (stdout || '').trim()
}

// Score title text: prefer more valid lines & longer text
function scoreTitleText(t: string) {
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean)
  const valid = lines.filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l))
  const length = valid.join(' ').length
  return valid.length * 50 + length // weight line count heavily
}

// Run OCR on a crop at 0/90/270 and return the best text + angle
async function ocrTitleAnyOrientation(cropPath: string) {
  const candidates: Array<{ angle: 0 | 90 | 270; text: string; score: number }> = []
  for (const angle of [0, 90, 270] as const) {
    const text = await ocrRotated(cropPath, angle, { psm: '6' })
    candidates.push({ angle, text, score: scoreTitleText(text) })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0] // { angle, text, score }
}

// Similar helper for sheet numbers (single line, whitelist)
async function ocrNumberAnyOrientation(cropPath: string) {
  const whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-'
  const variants: Array<{ angle: 0 | 90 | 270; psm: '7' | '6'; raw: string }> = []
  for (const angle of [0, 90, 270] as const) {
    for (const psm of ['7', '6'] as const) {
      const raw = await ocrRotated(cropPath, angle, { psm, whitelist })
      variants.push({ angle, psm, raw })
    }
  }
  // pick using existing pickSheetNumber + length
  const ranked = variants
    .map(v => ({ ...v, picked: pickSheetNumber(v.raw) || '' }))
    .sort((a, b) =>
      (b.picked.length - a.picked.length) ||
      (a.psm === '7' ? -1 : 1) // prefer PSM7 if tie
    )
  return ranked[0] // { angle, psm, raw, picked }
}

// Accept more formats incl. digit-first like 68H01
function pickSheetNumber(text?: string) {
  if (!text) return undefined
  const T = text.toUpperCase()

  const patterns = [
    /\b[A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?\b/g,   // letter-first
    /\b\d{1,3}[A-Z]{1,3}\d{1,4}\b/g,                  // 68H01, 15P101
    /\b\d{1,3}[A-Z]{1,3}(?:-\d{1,4}|\.\d{1,3})\b/g,   // 01G-02, 01G.02
    /\b[A-Z]\d[A-Z]\d{2,3}\b/g,                       // M1A101
  ]

  const hits = new Set<string>()
  for (const rx of patterns) for (const m of T.matchAll(rx)) hits.add(m[0])

  if (!hits.size) return undefined

  const score = (s: string) => {
    let sc = 0
    const clean = s.replace(/\s/g, '')
    const len = clean.length
    if (len >= 3 && len <= 10) sc += 2
    if (/[A-Z]/.test(clean) && /\d/.test(clean)) sc += 3
    if (/[.-]/.test(clean)) sc += 1
    if (/^(HVAC|ME|M|FP|P|PL|A|E|S|\d)/.test(clean)) sc += 1
    if (/\d$/.test(clean)) sc += 1
    return sc
  }

  return Array.from(hits)
    .map(v => ({ v: v.replace(/\s+/g, ''), s: score(v) }))
    .sort((a, b) => b.s - a.s || a.v.length - b.v.length)[0]?.v
}

// Title: join first 2 strong lines
function pickTitleFromRegion(text?: string) {
  if (!text) return undefined
  const lines = text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    // keep lines that look like titles (mostly caps/numbers/punct)
    .filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l) && l.replace(/\s+/g, ' ').length >= 5)

  if (!lines.length) return undefined
  const sorted = [...lines].sort((a, b) => b.length - a.length)
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

function fixO0(token: string) {
  let t = token.toUpperCase();

  // If an 'O' is between digits, it's almost certainly a zero (68H O 1 -> 68H 0 1)
  t = t.replace(/(?<=\d)O(?=\d)/g, '0');

  // If a '0' is between letters, it's often the letter O (rare but safe)
  t = t.replace(/(?<=[A-Z])0(?=[A-Z])/g, 'O');

  return t;
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

    // ---------- 1) Region text first (no rasterization) ----------
    let numText = ''
    let titleText = ''
    let usedNumberRegionText = false
    let usedTitleRegionText = false
    let numberDebug: any = { variants: [] as any[] }

    const numberRegion = project?.ocrNumberRegion as Region | null
    const titleRegion = project?.ocrTitleRegion as Region | null

    if (numberRegion) {
      try {
        const txt = await pdftotextRegion(pdfPath, numberRegion)
        const tight = txt.split('\n').map(s => s.trim()).filter(Boolean).join(' ')
        if (tight) { numText = tight; usedNumberRegionText = true }
      } catch { }
    }

    if (titleRegion) {
      try {
        const txt = await pdftotextRegion(pdfPath, titleRegion)
        const lines = txt.split('\n').map(s => s.trim()).filter(Boolean)
        if (lines.length) { titleText = lines.slice(0, 2).join(' '); usedTitleRegionText = true }
      } catch { }
    }

    // ---------- 2) Rasterize only if a field is still missing ----------
    if (!numText || !titleText) {
      const dpi = project?.ocrDpi ?? 300
      await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])

      // NUMBER: OCR fallback (robust)
      if (!numText && numberRegion) {
        try {
          const variants: { img: string; psm: '7' | '8'; th: number | null; raw: string; picked: string | null }[] = []

          // no-threshold
          const prepNone = await makeNumberCropVariant(pngPath, numberRegion, {
            threshold: undefined, padPct: 0.12, innerTrimPct: 0.12,
          })
          for (const psm of ['7'] as const) {
            const raw = await tesseractNumber(prepNone, psm)
            variants.push({ img: prepNone, psm, th: null, raw, picked: pickSheetNumber(raw) || null })
          }

          // binarized variants
          for (const th of [190, 170]) {
            const prepTh = await makeNumberCropVariant(pngPath, numberRegion, {
              threshold: th, padPct: 0.12, innerTrimPct: 0.12,
            })
            for (const psm of ['7'] as const) {
              const raw = await tesseractNumber(prepTh, psm)
              variants.push({ img: prepTh, psm, th, raw, picked: pickSheetNumber(raw) || null })
            }
          }

          const score = (s: string) =>
            s.replace(/[^A-Z0-9.-]/g, '').length + (/\d$/.test(s) ? 1 : 0)

          numText =
            variants
              .map(v => v.picked)
              .filter((v): v is string => !!v)
              .sort((a, b) => score(b) - score(a) || b.length - a.length)[0] || ''

          numberDebug.variants = variants
        } catch (e) {
          numberDebug.error = String(e)
        }
      }

      // TITLE: OCR fallback (simple block)
      if (!titleText && titleRegion) {
        try {
          const img = sharp(pngPath)
          const meta = await img.metadata()
          const W = meta.width || 0
          const H = meta.height || 0
          const left = Math.max(0, Math.floor(titleRegion.xPct * W))
          const top = Math.max(0, Math.floor(titleRegion.yPct * H))
          const width = Math.min(W - left, Math.floor(titleRegion.wPct * W))
          const height = Math.min(H - top, Math.floor(titleRegion.hPct * H))
          const titleCrop = `${pngPath.replace(/\.png$/, '')}-title.png`

          await sharp(pngPath)
            .extract({ left, top, width, height })
            .grayscale().normalize().gamma(1.05)
            .resize(width * 2, height * 2, { kernel: 'lanczos3' })
            .toFile(titleCrop)

          const { stdout } = await exec('tesseract', [
            titleCrop, 'stdout',
            '-l', 'eng', '--oem', '1', '--psm', '6',
            '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-_()/' // basic punctuation
          ])

          const bestTitle = await ocrTitleAnyOrientation(titleCrop)
          const lines = bestTitle.text
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l))

          titleText = (lines.slice(0, 2).join(' ') || '').trim()
        } catch { }
      }
    }

    // ---------- 3) Extra signals (optional) ----------
    let embeddedText = ''
    try {
      const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
      embeddedText = stdout || ''
    } catch { }

    let fullText = ''
    if ((!numText && !titleText) && (!embeddedText || embeddedText.trim().length < 40)) {
      const { stdout } = await exec('tesseract', [pngPath, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'])
      fullText = stdout || ''
    }

    // O/0 disambiguation on the number text before picking
    if (numText) numText = fixO0(numText)

    // ---------- 4) Final suggestion selection ----------
    let sheetNumber =
      pickSheetNumber(numText) ||
      pickSheetNumber(titleText) ||
      pickSheetNumber(embeddedText) ||
      pickSheetNumber(fullText)

    if (sheetNumber) sheetNumber = fixO0(sheetNumber)

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
            full: fullText.length,
          },
          previewDpi: project?.ocrDpi ?? 300,
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
      debug: {
        numberOCR: numberDebug,
        usedNumberRegionText,
        usedTitleRegionText,
        lengths: {
          numRegion: numText?.length || 0,
          titleRegion: titleText?.length || 0,
        },
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
