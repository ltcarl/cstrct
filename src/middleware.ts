// src/middleware.ts
import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const { pathname } = req.nextUrl
  const isAuthRoute = pathname.startsWith('/api/auth') || pathname === '/login'
  const isPublicAsset = pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.startsWith('/assets')

  if (!req.auth && !isAuthRoute && !isPublicAsset) {
    const url = new URL('/login', req.url)
    return NextResponse.redirect(url)
  }
  // otherwise allow
})

export const config = {
  matcher: ['/((?!_next|favicon|assets).*)'],
}
