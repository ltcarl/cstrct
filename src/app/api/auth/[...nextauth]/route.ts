export { handlers as GET, handlers as POST } from 'next-auth/next'
import { auth } from '@/lib/auth'
export const handlers = auth