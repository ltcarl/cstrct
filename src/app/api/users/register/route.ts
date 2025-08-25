import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function POST(req: Request) {
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return NextResponse.json({ error: 'Registration disabled' }, { status: 403 })
  }
  const { email, password, name } = await req.json()
  if (!email || !password) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return NextResponse.json({ error: 'Email in use' }, { status: 400 })
  const hash = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({ data: { email, password: hash, name, role: 'VIEWER' } })
  return NextResponse.json({ id: user.id })
}