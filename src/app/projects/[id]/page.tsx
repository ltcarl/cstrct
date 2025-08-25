'use client'
import useSWR from 'swr'
import { useParams } from 'next/navigation'
import { useRef, useState } from 'react'
import { PlanViewer } from '@/components/PlanViewer'

const fetcher = (url: string) => fetch(url).then(r=>r.json())

export default function ProjectDetail() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { data: plans, mutate } = useSWR(`/api/projects/${id}/plans`, fetcher)
  const fileRef = useRef<HTMLInputElement>(null)
  const [sheetNumber, setSheetNumber] = useState('M1.01')
  const [title, setTitle] = useState('Main Level HVAC Plan')
  const [discipline, setDiscipline] = useState('HVAC')
  const [version, setVersion] = useState(1)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const upload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    // 1) presign
    const presign = await fetch(`/api/projects/${id}/plans/presign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, contentType: file.type || 'application/pdf' }) }).then(r=>r.json())
    // 2) put
    await fetch(presign.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/pdf' } })
    // 3) save record
    await fetch(`/api/projects/${id}/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetNumber, title, discipline, version, fileKey: presign.key, fileUrl: presign.publicUrl })
    })
    setPreviewUrl(presign.publicUrl)
    fileRef.current!.value = ''
    mutate()
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="text-sm text-gray-600">Upload and view project plan sheets (PDF).</p>
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-sm">Sheet #</label>
            <input className="border rounded px-3 py-2" value={sheetNumber} onChange={e=>setSheetNumber(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm">Title</label>
            <input className="border rounded px-3 py-2" value={title} onChange={e=>setTitle(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm">Discipline</label>
            <select className="border rounded px-3 py-2" value={discipline} onChange={e=>setDiscipline(e.target.value)}>
              {['ARCH','CIVIL','DEMO','ELEC','FP','HVAC','PLUMB','STRUC','TELE','OTHER'].map(d=> <option key={d} value={d}>{d}</option> )}
            </select>
          </div>
          <div>
            <label className="block text-sm">Version</label>
            <input type="number" className="border rounded px-3 py-2 w-24" value={version} onChange={e=>setVersion(parseInt(e.target.value)||1)} />
          </div>
          <div>
            <label className="block text-sm">PDF</label>
            <input ref={fileRef} type="file" accept="application/pdf" className="border rounded px-3 py-1.5" />
          </div>
          <button onClick={upload} className="bg-black text-white rounded px-4 py-2">Upload</button>
        </div>
      </header>

      {previewUrl && (
        <section className="space-y-2">
          <h2 className="font-medium">Preview</h2>
          <PlanViewer fileUrl={previewUrl} />
        </section>
      )}

      <section>
        <h2 className="font-medium mb-3">All plan sheets</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr className="text-left">
                <th className="p-2 border">Sheet #</th>
                <th className="p-2 border">Title</th>
                <th className="p-2 border">Discipline</th>
                <th className="p-2 border">Version</th>
                <th className="p-2 border">Uploaded</th>
                <th className="p-2 border">Open</th>
              </tr>
            </thead>
            <tbody>
              {plans?.map((p: any)=> (
                <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                  <td className="p-2 border font-mono">{p.sheetNumber}</td>
                  <td className="p-2 border">{p.title}</td>
                  <td className="p-2 border">{p.discipline}</td>
                  <td className="p-2 border">{p.version}</td>
                  <td className="p-2 border">{new Date(p.createdAt).toLocaleString()}</td>
                  <td className="p-2 border">
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/files/sign-get', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({ key: p.fileKey }),
                          })
                          if (!res.ok) {
                            alert('Failed to get signed link')
                            return
                          }
                          const { url } = await res.json()
                          window.open(url, '_blank')
                        } catch (err) {
                          console.error(err)
                          alert('Error opening file')
                        }
                      }}
                      className="text-blue-600 hover:underline"
                    >
                      PDF
                    </button>
                  </td>  
                  <td className="p-2 border">{p.ocrStatus}</td>
             
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}