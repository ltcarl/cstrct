// src/middleware.ts
export { auth as middleware } from '@/lib/auth';

export const config = {
  // protect everything except the auth endpoints, login page, and Next static assets
  matcher: ['/((?!api/auth|login|_next|favicon|assets).*)'],
};
