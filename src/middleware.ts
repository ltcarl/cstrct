export { auth as middleware } from 'next-auth'
export const config = { matcher: ['/((?!api/auth|login|_next|favicon|assets).*)'] }