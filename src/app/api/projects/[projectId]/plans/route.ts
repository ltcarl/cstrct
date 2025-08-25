import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { auth } from '@/lib/auth'

export async function GET(_: Request, { params }: { params: { projectId: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const plans = await prisma.planSheet.findMany({ where: { projectId: params.projectId }, orderBy: { createdAt: 'desc' } })
  return NextResponse.json(plans)
}

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { sheetNumber, title, discipline, version, fileKey, fileUrl } = await req.json()
  if (!sheetNumber || !title || !discipline || !fileKey || !fileUrl) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  const plan = await prisma.planSheet.create({
    data: {
      projectId: params.projectId,
      sheetNumber,
      title,
      discipline,
      version: Number(version) || 1,
      fileKey,
      fileUrl,
      uploadedBy: (session.user as any).id,
    }
  })
  return NextResponse.json(plan)
}