import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const exec = promisify(execFile)

function parseSuggestions(text: string) {
  // crude heuristics you can improve later
  const lines = text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)

  // Sheet number examples: M1.01, P-101, A2.3, E-002, FP101
  const numRegex =
    /\b([A-Z]{1,2}-?\s?\d{1,3}(?:\.\d{1,2})?)\b|\b([A-Z]{1,2}\d{1,3}(?:\.\d{1,2})?)\b/
  const numberMatch =
    lines.join(' ').match(numRegex)?.[0] ||
    lines.find(l => /SHEET\s*NO|SHEET\s*NUMBER/i.test(l))?.replace(/.*?:\s*/i, '')

  const titleCandidate =
    lines.find(l => l.length > 8 && /^[A-Z0-9 \-_/()]+$/.test(l)) || lines[0] || ''

  // Discipline guess from number/title
  let disc: any = undefined
  const lc = (titleCandidate + ' ' + (numberMatch || '')).toLowerCase()
  if (/\bhvac\b|(^|[^a-z])m\d/.test(lc)) disc = 'HVAC'
  else if (/\bplumb|\bp[-\d]/.test(lc)) disc = 'PLUMB'
  else if (/\belec|\be[-\d]/.test(lc)) disc = 'ELEC'
  else if (/\barch|\ba[-\d]/.test(lc)) disc = 'ARCH'
  else if (/\bstruct|\bs[-\d]/.test(lc)) disc = 'STRUCT'

  return {
    number: numberMatch?.toUpperCase(),
    title: titleCandidate?.replace(/\s+/g, ' ').trim(),
    disc,
  }
}

export async function POST(
  req: Request,
  { params }: { params: { planId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error: 'Plan not found' }, { status: 404 })

  // Update status → RUNNING
  await prisma.planSheet.update({
    where: { id: plan.id },
    data: { ocrStatus: 'RUNNING' },
  })

  const usingMinio = process.env.STORAGE_PROVIDER === 'minio'
  const endpoint = usingMinio
    ? process.env.S3_PUBLIC_BASE_URL?.replace(/\/[^/]+$/, '') // http://host:9000
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
  const pngBase = join(tmp, 'page1') // pdftoppm will add .png

  try {
    // Download PDF from MinIO/S3
    const getCmd = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: plan.fileKey,
    })
    const obj = await s3.send(getCmd)
    const body = obj.Body as any
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(pdfPath)
      body.pipe(ws)
      body.on('error', reject)
      ws.on('finish', () => resolve())
      ws.on('error', reject)
    })

    // Convert first page to PNG (200dpi)
    await exec('pdftoppm', ['-singlefile', '-r', '200', '-png', pdfPath, pngBase])

    // Run Tesseract CLI → stdout to text
    const pngPath = `${pngBase}.png`
    // tesseract <img> stdout
    const { stdout } = await exec('tesseract', [pngPath, 'stdout', '-l', 'eng'])
    const text = stdout || ''

    const { number, title, disc } = parseSuggestions(text)

    // Naive confidence proxy (length & presence of number)
    const confidence = Math.min(1, (text.length / 2000) + (number ? 0.2 : 0))

    const updated = await prisma.planSheet.update({
      where: { id: plan.id },
      data: {
        ocrStatus: 'DONE',
        ocrSuggestedNumber: number || undefined,
        ocrSuggestedTitle: title || undefined,
        ocrSuggestedDisc: disc,
        ocrConfidence: confidence,
        ocrRaw: {
          length: text.length,
          snippet: text.slice(0, 300),
        } as any,
      },
    })

    // Return the suggestions for convenience
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
    // cleanup temp dir
    await rm(tmp, { recursive: true, force: true })
  }
}
