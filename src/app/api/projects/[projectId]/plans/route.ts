import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const createSchema = z.object({
  fileKey: z.string().min(1),
  fileUrl: z.string().url().optional(), // when using MinIO behind signer, this can be optional
})

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plans = await prisma.planSheet.findMany({
    where: { projectId: params.projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      sheetNumber: true,
      title: true,
      discipline: true,
      version: true,
      createdAt: true,
      fileKey: true,
      ocrStatus: true,
    },
  })

  return NextResponse.json(plans)
}

export async function POST(
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
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad request', details: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const plan = await prisma.planSheet.create({
      data: {
        projectId: params.projectId,
        uploaderId: session.user.id,
        version: 1,
        fileKey: parsed.data.fileKey,
        fileUrl: parsed.data.fileUrl ?? null, // nullable if you only serve via sign-get
        ocrStatus: 'PENDING',
        // sheetNumber/title/discipline will be filled by OCR later
      },
      select: { id: true, projectId: true },
    })

    return NextResponse.json(plan, { status: 201 })
  } catch (e: any) {
    console.error('Create plan failed:', e)
    return new NextResponse(String(e?.message ?? 'Create failed'), { status: 500 })
  }
}
