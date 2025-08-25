import './globals.css'
import Link from 'next/link'
import { auth, signOut } from '@/lib/auth'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b bg-white sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
            <Link href="/projects" className="font-bold text-xl">{process.env.APP_NAME || 'MechPro'}</Link>
            <nav className="flex items-center gap-4">
              <Link href="/projects" className="hover:underline">Projects</Link>
              {session?.user ? (
                <form action={async () => { 'use server'; await signOut(); }}>
                  <button className="px-3 py-1.5 rounded border">Sign out</button>
                </form>
              ) : (
                <Link href="/login" className="px-3 py-1.5 rounded border">Sign in</Link>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  )
}
