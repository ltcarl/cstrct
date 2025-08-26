import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { auth } from '@/lib/auth'
import { z } from 'zod'

const regionSchema = z.object({
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
  wPct: z.number().min(0.01).max(1),
  hPct: z.number().min(0.01).max(1),
})

const payloadSchema = z.object({
  ocrDpi: z.number().int().min(72).max(600).optional(),
  ocrCorner: z.enum(['BOTTOM_RIGHT', 'BOTTOM_LEFT', 'TOP_RIGHT', 'TOP_LEFT']).optional(),
  ocrNumberRegion: regionSchema.optional(),
  ocrTitleRegion: regionSchema.optional(),
})

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { ocrDpi: true, ocrCorner: true, ocrNumberRegion: true, ocrTitleRegion: true },
  })
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(project)
}

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parse = payloadSchema.safeParse(body)
  if (!parse.success) {
    return NextResponse.json({ error: 'Validation failed', details: parse.error.flatten() }, { status: 400 })
  }

  const { ocrDpi, ocrCorner, ocrNumberRegion, ocrTitleRegion } = parse.data

  const updated = await prisma.project.update({
    where: { id: params.projectId },
    data: {
      ...(ocrDpi !== undefined ? { ocrDpi } : {}),
      ...(ocrCorner !== undefined ? { ocrCorner } : {}),
      ...(ocrNumberRegion ? { ocrNumberRegion } : {}),
      ...(ocrTitleRegion ? { ocrTitleRegion } : {}),
    },
    select: { ocrDpi: true, ocrCorner: true, ocrNumberRegion: true, ocrTitleRegion: true },
  })

  return NextResponse.json(updated)
}
