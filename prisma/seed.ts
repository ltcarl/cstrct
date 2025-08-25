import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const prisma = new PrismaClient()
async function main() {
  // Org
  const org = await prisma.organization.upsert({
    where: { id: 'seed-org' },
    update: {},
    create: { id: 'seed-org', name: 'Seed Mechanical LLC' },
  })
  // Admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@mechpro.local' },
    update: {},
    create: {
      email: 'admin@mechpro.local',
      name: 'Admin',
      password: await bcrypt.hash('admin123', 10),
      role: 'ADMIN',
    },
  })
  await prisma.membership.upsert({
    where: { id: 'seed-mem-admin' },
    update: {},
    create: { id: 'seed-mem-admin', userId: admin.id, organizationId: org.id, role: 'ADMIN' },
  })
  // Sample project
  await prisma.project.create({
    data: {
      name: 'HQ Renovation',
      number: 'MP-24017',
      city: 'Austin', state: 'TX',
      organizationId: org.id,
    }
  })
}
main().then(()=>prisma.$disconnect())
.catch(async e=>{console.error(e); await prisma.$disconnect(); process.exit(1)})
