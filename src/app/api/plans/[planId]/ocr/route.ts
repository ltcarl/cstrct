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

// preprocess the crop: pad a bit, grayscale, normalize, binarize, upscale 2x
async function prepareNumberCrop(pngPath: string, region: Region) {
  const img = sharp(pngPath)
  const meta = await img.metadata()
  const W = meta.width || 0
  const H = meta.height || 0

  // add 8% padding around the region to avoid clipping last char
  const pad = 0.08
  const left = Math.max(0, Math.floor((region.xPct - pad) * W))
  const top = Math.max(0, Math.floor((region.yPct - pad) * H))
  const w = Math.min(W - left, Math.floor((region.wPct + pad * 2) * W))
  const h = Math.min(H - top, Math.floor((region.hPct + pad * 2) * H))

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

async function makeNumberCropVariant(pngPath: string, region: Region, opts: { padPct?: number, threshold?: number }) {
  const img = sharp(pngPath)
  const meta = await img.metadata()
  const W = meta.width || 0
  const H = meta.height || 0

  const pad = opts.padPct ?? 0.12 // a bit more padding
  const left = Math.max(0, Math.floor((region.xPct - pad) * W))
  const top = Math.max(0, Math.floor((region.yPct - pad) * H))
  const w = Math.min(W - left, Math.floor((region.wPct + pad * 2) * W))
  const h = Math.min(H - top, Math.floor((region.hPct + pad * 2) * H))

  const out = `${pngPath.replace(/\.png$/, '')}-num-${randomUUID()}.png`

  // preprocess: grayscale → normalize → sharpen → gamma → threshold → 2x resize
  await sharp(pngPath)
    .extract({ left, top, width: w, height: h })
    .grayscale()
    .normalize()
    .sharpen()
    .gamma(1.2)
    .threshold(opts.threshold ?? 170)   // try several later
    .resize(w * 2, h * 2, { kernel: 'lanczos3' })
    .toFile(out)

  return out
}

async function tesseractNumber(imgPath: string, psm: '7' | '8' | '13') {
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

async function tesseractStdout(imgPath: string, psm: '7' | '8') {
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

    // 0) Region text first (vector text beats OCR)
    let numText = ''
    let titleText = ''

    let numberDebug: any = { variants: [] as any[] }

    const numberRegion = project?.ocrNumberRegion as Region | null
    const titleRegion = project?.ocrTitleRegion as Region | null

    if (numberRegion) {
      try {
        const txt = await pdftotextRegion(pdfPath, numberRegion)
        // Keep only a tight line for numbers (avoid grabbing too much)
        numText = txt.split('\n').map(s => s.trim()).filter(Boolean).join(' ')
      } catch { }
    }

    if (titleRegion) {
      try {
        const txt = await pdftotextRegion(pdfPath, titleRegion)
        // Keep first two strong lines for the title
        const lines = txt.split('\n').map(s => s.trim()).filter(Boolean)
        titleText = lines.slice(0, 2).join(' ')
      } catch { }
    }
    // Rasterize only if a field is still missing
    if (!numText || !titleText) {
      const dpi = project?.ocrDpi ?? 300
      await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])
      const pngPath = `${outBase}.png`

      // Number fallback OCR (your padded/trim variants)
      if (!numText || !titleText) {
        const dpi = project?.ocrDpi ?? 300
        await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])
        const pngPath = `${outBase}.png`

        // ---------- NUMBER: OCR fallback (robust) ----------
        if (!numText && numberRegion) {
          try {
            const variants: {
              img: string; psm: '7' | '8'; th: number | null; raw: string; picked: string | null
            }[] = []

            // variant A: no threshold (clean grayscale)
            const prepNone = await makeNumberCropVariant(pngPath, numberRegion, {
              threshold: null,          // no binarize
              padPct: 0.12,             // outer pad
              innerTrimPct: 0.12,       // trim away inner edges to avoid borders
            })
            for (const psm of ['8', '7'] as const) {
              const raw = await tesseractNumber(prepNone, psm)
              variants.push({ img: prepNone, psm, th: null, raw, picked: pickSheetNumber(raw) || null })
            }

            // variant B/C: binarized at two levels
            for (const th of [190, 170]) {
              const prepTh = await makeNumberCropVariant(pngPath, numberRegion, {
                threshold: th,
                padPct: 0.12,
                innerTrimPct: 0.12,
              })
              for (const psm of ['8', '7'] as const) {
                const raw = await tesseractNumber(prepTh, psm)
                variants.push({ img: prepTh, psm, th, raw, picked: pickSheetNumber(raw) || null })
              }
            }

            // choose best candidate
            const score = (s: string) =>
              s.replace(/[^A-Z0-9.-]/g, '').length + (/\d$/.test(s) ? 1 : 0)

            const best =
              variants
                .map(v => v.picked)
                .filter((v): v is string => !!v)
                .sort((a, b) => score(b) - score(a) || b.length - a.length)[0] || ''

            numText = best
            numberDebug.variants = variants
          } catch (e) {
            numberDebug.error = String(e)
          }
        }

        // Title fallback OCR (your title OCR block)
        if (!titleText && titleRegion) {
          try {
            // Render once, crop the title area, OCR as a block (keep newlines)
            // Simple version using tesseract directly over the full page + region crop helper:
            // If you have ocrCropPng(region, { psm:'6', whitelist:, keepNewlines:true }) keep it.
            // Here we do it with sharp then tesseract:

            // Reuse the number-crop maker shape but without innerTrim; titles are away from borders
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
              .grayscale()
              .normalize()
              .gamma(1.05)
              .resize(width * 2, height * 2, { kernel: 'lanczos3' })
              .toFile(titleCrop)

            const { stdout } = await exec('tesseract', [
              titleCrop, 'stdout',
              '-l', 'eng',
              '--oem', '1',
              '--psm', '6', // block of text
              '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-_()/'
            ])

            // Join the top 2 strongest lines
            const lines = (stdout || '')
              .split('\n')
              .map(s => s.trim())
              .filter(Boolean)
              .filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l))
            titleText = (lines.slice(0, 2).join(' ') || '').trim()
          } catch {
            // ignore — title stays empty, later fallbacks (embedded/full) may fill it
          }
        }
      }
      // 2) Try embedded text to help only if a field is still missing
      let embeddedText = ''
      try {
        const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
        embeddedText = stdout || ''
      } catch { }

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
        pickSheetNumber(titleText) || // rarely needed
        pickSheetNumber(embeddedText) || // if you still compute it
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
        debug: {
          numberOCR: numberDebug,   // <- declared earlier: let numberDebug: any = { variants: [] }
        },
      });
    } catch (err) {
      console.error('OCR error:', err);
      await prisma.planSheet.update({
        where: { id: plan.id },
        data: { ocrStatus: 'FAILED' },
      });
      return NextResponse.json({ error: 'OCR failed' }, { status: 500 });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }