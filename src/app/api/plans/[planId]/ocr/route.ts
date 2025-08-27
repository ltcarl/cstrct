// src/app/api/plans/[planId]/ocr/route.ts (orientation-fix)
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

// NOTE: no helper exports — keep route exports clean
const exec = promisify(execFile)

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

type PageInfo = { w: number; h: number; rot: 0 | 90 | 180 | 270 }
async function getPdfPageInfo(pdfPath: string): Promise<PageInfo> {
  const { stdout } = await exec('pdfinfo', [pdfPath])
  const size = stdout.match(/Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/i)
  const rot = stdout.match(/Page rot:\s+(\d+)/i) || stdout.match(/Rotate:\s+(\d+)/i)
  const w = size ? parseFloat(size[1]) : 612
  const h = size ? parseFloat(size[2]) : 792
  const r = (rot ? parseInt(rot[1], 10) : 0) as 0 | 90 | 180 | 270
  return { w, h, rot: r }
}

// --- Region mapping with top-left origin, matching pdftotext/pdftoppm expectations ---
// Map an unrotated-page-space rect into the page-space AFTER rotation has been applied.
function mapRegionForRotation(
  x: number, y: number, W: number, H: number,
  pageW: number, pageH: number, rot: 0 | 90 | 180 | 270
) {
  if (rot === 0) return { x, y, W, H }
  if (rot === 90) {
    return {
      x: y,
      y: pageW - (x + W),
      W: H,
      H: W,
    }
  }
  if (rot === 180) {
    return {
      x: pageW - (x + W),
      y: pageH - (y + H),
      W, H,
    }
  }
  // 270
  return {
    x: pageH - (y + H),
    y: x,
    W: H,
    H: W,
  }
}

function clampRect(x: number, y: number, W: number, H: number, pageW: number, pageH: number) {
  const cx = Math.max(0, Math.min(x, pageW - 1))
  const cy = Math.max(0, Math.min(y, pageH - 1))
  const cW = Math.max(1, Math.min(W, pageW - cx))
  const cH = Math.max(1, Math.min(H, pageH - cy))
  return { x: cx, y: cy, W: cW, H: cH }
}

// If regions were saved against a rotated preview (90/180/270), map them back
// to unrotated (0°) page-space percentages.
function invertPctRegionFromRotated(region: Region, rot: 0 | 90 | 180 | 270): Region {
  const { xPct: x, yPct: y, wPct: w, hPct: h } = region
  if (rot === 0) return region
  if (rot === 90) return { xPct: 1 - (y + h), yPct: x, wPct: h, hPct: w }
  if (rot === 180) return { xPct: 1 - (x + w), yPct: 1 - (y + h), wPct: w, hPct: h }
  // 270
  return { xPct: y, yPct: 1 - (x + w), wPct: h, hPct: w }
}

// Vector-first extraction with both -raw and -layout; pick best by heuristic.
async function pdftotextRegionBest(pdfPath: string, r: Region) {
  const { w: pageW, h: pageH, rot } = await getPdfPageInfo(pdfPath)

  // Try as-saved and an inverted variant in case UI saved rotated coords
  const candidates: Region[] = [r]
  if (rot !== 0) candidates.push(invertPctRegionFromRotated(r, rot))

  const runFor = async (R: Region) => {
    const x0 = Math.max(0, Math.floor(R.xPct * pageW))
    const y0 = Math.max(0, Math.floor(R.yPct * pageH))
    const W0 = Math.max(1, Math.floor(R.wPct * pageW))
    const H0 = Math.max(1, Math.floor(R.hPct * pageH))

    const m = mapRegionForRotation(x0, y0, W0, H0, pageW, pageH, rot)
    const { x, y, W, H } = clampRect(
      m.x, m.y, m.W, m.H,
      rot === 90 || rot === 270 ? pageH : pageW,
      rot === 90 || rot === 270 ? pageW : pageH
    )

    const run = async (mode: 'layout' | 'raw') => {
      const args = [
        mode === 'layout' ? '-layout' : '-raw',
        '-nopgbrk',
        '-f', '1', '-l', '1',
        '-x', String(x), '-y', String(y),
        '-W', String(W), '-H', String(H),
        pdfPath, '-'
      ]
      const { stdout } = await exec('pdftotext', args)
      return (stdout || '').trim()
    }

    const layout = await run('layout')
    const raw = await run('raw')

    const score = (s: string) => {
      const t = s.replace(/\s+/g, '')
      const alnum = (t.match(/[A-Z0-9]/gi) || []).length
      return (alnum / Math.max(1, t.length)) + Math.min(0.4, t.length / 200)
    }
    return score(raw) >= score(layout) ? raw : layout
  }

  const outputs = await Promise.all(candidates.map(runFor))
  const pickIdx = outputs
    .map((s, i) => {
      const t = s.replace(/\s+/g, '')
      const a = (t.match(/[A-Z0-9]/gi) || []).length
      return { i, score: (a / Math.max(1, t.length)) + Math.min(0.4, t.length / 200) }
    })
    .sort((a, b) => b.score - a.score)[0]?.i ?? 0

  return outputs[pickIdx]
}


// Rasterize page to PNG, then normalize image so region % always match unrotated page-space
async function rasterizeAndNormalize(pdfPath: string, outBase: string, dpi: number) {
  await exec('pdftoppm', ['-singlefile', '-r', String(dpi), '-png', pdfPath, outBase])
  const pngPath = `${outBase}.png`
  const { rot } = await getPdfPageInfo(pdfPath)
  if (rot === 0) return { pngPath, rot }
  const rotBack = (360 - rot) % 360 // rotate image back to 0°
  const normalized = `${outBase}-norm.png`
  await sharp(pngPath).rotate(rotBack).toFile(normalized)
  return { pngPath: normalized, rot }
}

async function cropPctFromPng(pngPath: string, region: Region) {
  const img = sharp(pngPath)
  const meta = await img.metadata()
  const W = meta.width || 0
  const H = meta.height || 0
  const left = Math.max(0, Math.floor(region.xPct * W))
  const top = Math.max(0, Math.floor(region.yPct * H))
  const width = Math.min(W - left, Math.floor(region.wPct * W))
  const height = Math.min(H - top, Math.floor(region.hPct * H))
  const out = `${pngPath.replace(/\.png$/, '')}-${left}x${top}-${width}x${height}.png`
  await img.extract({ left, top, width, height }).toFile(out)
  return out
}

async function cropBothOrientations(pngPath: string, region: Region, rot: 0 | 90 | 180 | 270) {
  const a = await cropPctFromPng(pngPath, region)
  if (rot === 0) return [a, a]
  const b = await cropPctFromPng(pngPath, invertPctRegionFromRotated(region, rot))
  return [a, b]
}

async function ocrRotated(imgPath: string, angle: 0 | 90 | 270, opts?: { psm?: '6' | '7'; whitelist?: string }) {
  const rotated = angle === 0 ? imgPath : `${imgPath.replace(/\.png$/, '')}-rot${angle}.png`
  if (angle !== 0) await sharp(imgPath).rotate(angle).toFile(rotated)
  const args = [rotated, 'stdout', '-l', 'eng', '--oem', '1', '--psm', opts?.psm ?? '6']
  if (opts?.whitelist) args.push('-c', `tessedit_char_whitelist=${opts.whitelist}`)
  const { stdout } = await exec('tesseract', args)
  return (stdout || '').trim()
}

function scoreTitleText(t: string) {
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean)
  const valid = lines.filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l))
  const length = valid.join(' ').length
  return valid.length * 50 + length
}

async function ocrTitleAnyOrientation(cropPath: string) {
  const candidates: Array<{ angle: 0 | 90 | 270; text: string; score: number }> = []
  for (const angle of [0, 90, 270] as const) {
    const text = await ocrRotated(cropPath, angle, { psm: '6' })
    candidates.push({ angle, text, score: scoreTitleText(text) })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]
}

async function ocrNumberAnyOrientation(cropPath: string) {
  const whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-'
  const trials: Array<{ angle: 0 | 90 | 270; psm: '7' | '6'; raw: string }> = []
  for (const angle of [0, 90, 270] as const) {
    for (const psm of ['7', '6'] as const) {
      const raw = await ocrRotated(cropPath, angle, { psm, whitelist })
      trials.push({ angle, psm, raw })
    }
  }
  return trials
}

function pickSheetNumber(text?: string) {
  if (!text) return undefined
  const T = text.toUpperCase()
  const patterns = [
    /\b[A-Z]{1,3}-?\d{1,4}(?:\.\d{1,3})?[A-Z]?\b/g,
    /\b\d{1,3}[A-Z]{1,3}\d{1,4}\b/g,
    /\b\d{1,3}[A-Z]{1,3}(?:-\d{1,4}|\.\d{1,3})\b/g,
    /\b[A-Z]\d[A-Z]\d{2,3}\b/g,
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

function pickTitleFromRegion(text?: string) {
  if (!text) return undefined
  const lines = text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l) && l.replace(/\s+/g, ' ').length >= 5)
  if (!lines.length) return undefined
  const sorted = [...lines].sort((a, b) => b.length - a.length)
  const top = sorted.slice(0, 2)
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
  let t = token.toUpperCase()
  t = t.replace(/(?<=\d)O(?=\d)/g, '0')
  t = t.replace(/(?<=[A-Z])0(?=[A-Z])/g, 'O')
  return t
}

export async function POST(req: Request, { params }: { params: { planId: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  const project = await prisma.project.findUnique({
    where: { id: plan.projectId },
    select: { ocrDpi: true, ocrNumberRegion: true, ocrTitleRegion: true }
  })

  await prisma.planSheet.update({ where: { id: plan.id }, data: { ocrStatus: 'RUNNING' } })

  const usingMinio = process.env.STORAGE_PROVIDER === 'minio'
  const endpoint = usingMinio ? process.env.S3_PUBLIC_BASE_URL?.replace(/\/[^/]+$/, '') : undefined

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

  try {
    // Download PDF
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: plan.fileKey }))
    const body = obj.Body as any
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(pdfPath)
      body.pipe(ws)
      body.on('error', reject)
      ws.on('finish', resolve)
      ws.on('error', reject)
    })

    // 1) Vector text first (with -raw fallback) — handles many vertical stacks
    const numberRegion = project?.ocrNumberRegion as Region | null
    const titleRegion = project?.ocrTitleRegion as Region | null

    let numText = ''
    let titleText = ''
    let usedNumberRegionText = false
    let usedTitleRegionText = false

    if (numberRegion) {
      try {
        const txt = await pdftotextRegionBest(pdfPath, numberRegion)
        const tight = txt.split('\n').map(s => s.trim()).filter(Boolean).join(' ')
        if (tight) { numText = tight; usedNumberRegionText = true }
      } catch { }
    }
    if (titleRegion) {
      try {
        const txt = await pdftotextRegionBest(pdfPath, titleRegion)
        const lines = txt.split('\n').map(s => s.trim()).filter(Boolean)
        if (lines.length) { titleText = lines.slice(0, 2).join(' '); usedTitleRegionText = true }
      } catch { }
    }

    // 2) Rasterize only if still missing; normalize image so % regions are stable vs rotation
    let numberDebug: any = { variants: [] as any[], rotationsTried: [0, 90, 270] }

    // Prepare backup vars regardless of whether we rasterize
    let embeddedText = ''
    let fullText = ''

    if (!numText || !titleText) {
      const dpi = project?.ocrDpi ?? 350
      const { pngPath, rot: pageRot } = await rasterizeAndNormalize(pdfPath, outBase, dpi)

      // NUMBER: OCR fallback (rotate 0/90/270)
      if (!numText && numberRegion) {
        try {
          const [numCropA, numCropB] = await cropBothOrientations(pngPath, numberRegion, pageRot)
          const trialsA = await ocrNumberAnyOrientation(numCropA)
          const trialsB = await ocrNumberAnyOrientation(numCropB)
          const trials = [...trialsA, ...trialsB]
          const scored = trials.map(t => ({ ...t, picked: pickSheetNumber(t.raw) || '' }))
          const rank = (s: string) =>
            s.replace(/[^A-Z0-9.-]/g, '').length + (/(?:\.|-)\d+$/.test(s) ? 1 : 0)
          scored.sort((a, b) => (rank(b.picked) - rank(a.picked)) || (a.psm === '7' ? -1 : 1))
          numText = scored[0]?.picked || ''
          numberDebug.variants = scored
        } catch (e) {
          numberDebug.error = String(e)
        }
      }

      // TITLE: OCR fallback with multi-rotation and dual-orientation crops
      if (!titleText && titleRegion) {
        try {
          const [titleCropA, titleCropB] = await cropBothOrientations(pngPath, titleRegion, pageRot)
          const bestA = await ocrTitleAnyOrientation(titleCropA)
          const bestB = await ocrTitleAnyOrientation(titleCropB)
          const best = bestA.score >= bestB.score ? bestA : bestB
          const lines = best.text
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .filter(l => /^[A-Z0-9 .\-_/()]+$/.test(l))
          titleText = (lines.slice(0, 2).join(' ') || '').trim()
        } catch { }
      }

      // 3) Backup signals (rare)
      try {
        const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
        embeddedText = stdout || ''
      } catch { }
      if ((!numText && !titleText) && (!embeddedText || embeddedText.trim().length < 40)) {
        const { stdout } = await exec('tesseract', [pngPath, 'stdout', '-l', 'eng', '--oem', '1', '--psm', '6'])
        fullText = stdout || ''
      }

      // ---- Final selection + persist (always runs)
      if (numText) numText = fixO0(numText)

      let sheetNumber =
        pickSheetNumber(numText) ||
        pickSheetNumber(titleText) ||
        pickSheetNumber(embeddedText) ||
        pickSheetNumber(fullText)

      if (sheetNumber) sheetNumber = fixO0(sheetNumber)

      const title =
        pickTitleFromRegion(titleText) ||
        (!titleRegion ? (pickTitleFromRegion(embeddedText) || pickTitleFromRegion(fullText)) : undefined)

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
              numberRegion: (numText || '').length,
              titleRegion: (titleText || '').length,
              embedded: (embeddedText || '').length,
              full: (fullText || '').length,
            },
            previewDpi: project?.ocrDpi ?? 350,
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
        },
      })
    }

    // If vector extraction already produced text, finalize and return
    if (numText || titleText) {
      let embeddedText = ''
      try {
        const { stdout } = await exec('pdftotext', ['-layout', '-f', '1', '-l', '1', pdfPath, '-'])
        embeddedText = stdout || ''
      } catch {}

      if (numText) numText = fixO0(numText)
      let sheetNumber =
        pickSheetNumber(numText) ||
        pickSheetNumber(titleText) ||
        pickSheetNumber(embeddedText)
      if (sheetNumber) sheetNumber = fixO0(sheetNumber)

      const title =
        pickTitleFromRegion(titleText) ||
        (!titleRegion ? pickTitleFromRegion(embeddedText) : undefined)

      const disc = guessDiscipline(sheetNumber, title)
      const combinedText = [numText, titleText, embeddedText].filter(Boolean).join('
')
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
              numberRegion: (numText || '').length,
              titleRegion: (titleText || '').length,
              embedded: (embeddedText || '').length,
              full: 0,
            },
            previewDpi: project?.ocrDpi ?? 350,
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
        },
      })
    }

    } catch (err) {
      console.error('OCR error:', err)
      await prisma.planSheet.update({ where: { id: plan.id }, data: { ocrStatus: 'FAILED' } })
      return NextResponse.json({ error: 'OCR failed' }, { status: 500 })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }
