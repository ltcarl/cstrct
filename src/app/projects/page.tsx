'use client'
import useSWR from 'swr'
import { useState } from 'react'
import { Plus } from 'lucide-react'

const fetcher = (url: string) => fetch(url).then(r=>r.json())

export default function ProjectsPage() {
  const { data, mutate } = useSWR('/api/projects', fetcher)
  const [name, setName] = useState('')
  const [number, setNumber] = useState('')

  const create = async () => {
    if (!name) return
    await fetch('/api/projects', { method: 'POST', body: JSON.stringify({ name, number }), headers: { 'Content-Type': 'application/json' } })
    setName(''); setNumber(''); mutate()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-2">
        <div>
          <label className="block text-sm">Project name</label>
          <input value={name} onChange={e=>setName(e.target.value)} className="border rounded px-3 py-2" placeholder="e.g., Lakeside Apartments" />
        </div>
        <div>
          <label className="block text-sm">Number</label>
          <input value={number} onChange={e=>setNumber(e.target.value)} className="border rounded px-3 py-2" placeholder="e.g., MP-25001" />
        </div>
        <button onClick={create} className="inline-flex items-center gap-2 bg-black text-white rounded px-4 py-2"><Plus size={16}/>Create</button>
      </div>

      <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map((p: any)=> (
          <li key={p.id} className="border rounded-xl p-4 hover:shadow-sm">
            <a href={`/projects/${p.id}`} className="block">
              <div className="text-sm text-gray-500">{p.number || '—'}</div>
              <div className="font-semibold text-lg">{p.name}</div>
              <div className="text-gray-500 text-sm">{p.city ? `${p.city}, ${p.state}` : ''}</div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
