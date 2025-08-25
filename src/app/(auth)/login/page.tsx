'use client'
import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('admin@mechpro.local')
  const [password, setPassword] = useState('admin123')
  const [error, setError] = useState<string|undefined>()
  const router = useRouter()
  return (
    <div className="max-w-sm mx-auto border rounded-2xl p-6 shadow-sm">
      <h1 className="text-2xl font-semibold mb-4">Sign in</h1>
      <form onSubmit={async (e)=>{e.preventDefault();
        const res = await signIn('credentials', { email, password, redirect: false })
        if (res?.error) setError('Invalid credentials')
        else router.push('/projects')
      }} className="space-y-3">
        <input className="w-full border rounded px-3 py-2" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" />
        <input className="w-full border rounded px-3 py-2" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button className="w-full bg-black text-white rounded py-2">Sign in</button>
      </form>
    </div>
  )
}