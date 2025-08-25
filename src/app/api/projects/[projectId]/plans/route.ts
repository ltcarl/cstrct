// src/app/api/projects/[projectId]/plans/route.ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { auth } from '@/lib/auth'

export async function GET(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const plans = await prisma.planSheet.findMany({
    where: { projectId: params.projectId },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json(plans)
}

export async function POST(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = (session.user as any).id
  const body = await req.json()
  const { sheetNumber, title, discipline, version, fileKey, fileUrl } = body

  const plan = await prisma.planSheet.create({
    data: {
      projectId: params.projectId,
      sheetNumber,
      title,
      discipline,
      version: Number(version) || 1,
      fileKey,
      fileUrl,
      uploadedBy: userId,
    },
  })

  return NextResponse.json(plan, { status: 201 })
}
