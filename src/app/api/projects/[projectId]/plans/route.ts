import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function POST(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = (session.user as any).id
  if (!userId) return NextResponse.json({ error: 'No user id in session' }, { status: 401 })

  const body = await req.json()
  const { sheetNumber, title, discipline, version, fileKey, fileUrl } = body

  const plan = await prisma.planSheet.create({
    data: {
      projectId: params.projectId,
      sheetNumber,
      title,
      discipline,                           // enum value from client
      version: Number(version) || 1,
      fileKey,
      fileUrl,
      uploadedBy: userId,                   // <-- key fix
    },
  })

  return NextResponse.json(plan)
}
