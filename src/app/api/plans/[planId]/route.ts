import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { auth } from '@/lib/auth'

export async function GET(_req:Request,{params}:{params:{planId:string}}){
  const session = await auth(); if(!session?.user) return NextResponse.json({error:'Unauthorized'},{status:401})
  const plan = await prisma.planSheet.findUnique({ where:{ id: params.planId }, select:{ id:true, projectId:true } })
  if(!plan) return NextResponse.json({error:'Not found'},{status:404})
  return NextResponse.json(plan)
}
