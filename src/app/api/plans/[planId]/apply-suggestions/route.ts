import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { auth } from '@/lib/auth'
import { z } from 'zod'

const bodySchema = z.object({
  overrideNumber: z.string().trim().min(1).optional(),
  useRegionsAsDefault: z.boolean().optional(),
  numberRegion: z.object({ xPct: z.number(), yPct: z.number(), wPct: z.number(), hPct: z.number() }).optional(),
  titleRegion:  z.object({ xPct: z.number(), yPct: z.number(), wPct: z.number(), hPct: z.number() }).optional(),
})

export async function POST(req:Request, { params }:{ params:{ planId:string } }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error:'Unauthorized' }, { status:401 })

  const plan = await prisma.planSheet.findUnique({ where: { id: params.planId } })
  if (!plan) return NextResponse.json({ error:'Not found' }, { status:404 })

  const body = await req.json().catch(()=>null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error:'Bad request', details: parsed.error.flatten() }, { status:400 })

  const { overrideNumber, useRegionsAsDefault, numberRegion, titleRegion } = parsed.data

  // Pull suggestions from plan (already set by /ocr)
  const updated = await prisma.planSheet.update({
    where: { id: plan.id },
    data: {
      sheetNumber: overrideNumber ?? plan.ocrSuggestedNumber ?? undefined,
      title: plan.ocrSuggestedTitle ?? undefined,
      discipline: plan.ocrSuggestedDisc ?? undefined,
    },
    select: { id:true, projectId:true, sheetNumber:true, title:true, discipline:true }
  })

  // Optionally persist regions on the project (we already PATCHed during Run OCR, but this keeps it idempotent)
  if (useRegionsAsDefault && (numberRegion || titleRegion)) {
    await prisma.project.update({
      where: { id: updated.projectId },
      data: {
        ...(numberRegion ? { ocrNumberRegion: numberRegion } : {}),
        ...(titleRegion  ? { ocrTitleRegion:  titleRegion  } : {}),
      }
    })
  }

  return NextResponse.json({ ok:true, plan: updated })
}
