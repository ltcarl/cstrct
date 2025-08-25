import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { auth } from '@/lib/auth'

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } })
  return NextResponse.json(projects)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { name, number, organizationId } = await req.json()
  if (!name) return NextResponse.json({ error: 'Missing name' }, { status: 400 })
  const orgId = organizationId || (await prisma.organization.findFirst())?.id
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 })
  const proj = await prisma.project.create({ data: { name, number, organizationId: orgId } })
  return NextResponse.json(proj)
}