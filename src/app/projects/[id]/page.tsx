'use client'

import useSWR from 'swr'
import { useParams, useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

const fetcher = (url: string) =>
  fetch(url, { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error('Request failed')
    return r.json()
  })

export default function ProjectPlansPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const projectId = params.id
  const { data: plans, mutate, isLoading } = useSWR(`/api/projects/${projectId}/plans`, fetcher)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const upload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      // 1) presign
      const presign = await fetch(`/api/projects/${projectId}/plans/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/pdf',
        }),
      }).then((r) => r.json())

      // 2) PUT to object storage
      await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/pdf' },
        body: file,
      })

      // 3) Create plan record (no manual fields)
      const created = await fetch(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fileKey: presign.key,
          fileUrl: presign.publicUrl,
        }),
      }).then((r) => r.json())

      // 4) Go straight to the per-sheet review
      router.push(`/plans/${created.id}/review`)
    } catch (err) {
      console.error(err)
      alert('Upload failed')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
      setUploading(false)
      mutate()
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="text-sm text-gray-600">Upload a PDF; we’ll guide you to OCR review.</p>
        </div>

        <div className="ml-auto flex items-end gap-2">
          <div>
            <label className="block text-sm">PDF</label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="border rounded px-3 py-1.5"
              disabled={uploading}
            />
          </div>
          <button
            onClick={upload}
            disabled={uploading}
            className="bg-black text-white rounded px-4 py-2 disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </header>

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
                <th className="p-2 border">File</th>
                <th className="p-2 border">OCR</th>
                <th className="p-2 border">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!plans?.length && (
                <tr>
                  <td className="p-3 text-gray-500 italic" colSpan={8}>
                    {isLoading ? 'Loading…' : 'No plans yet'}
                  </td>
                </tr>
              )}
              {plans?.map((p: any) => (
                <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                  <td className="p-2 border font-mono">{p.sheetNumber || '—'}</td>
                  <td className="p-2 border">{p.title || '—'}</td>
                  <td className="p-2 border">{p.discipline || '—'}</td>
                  <td className="p-2 border">{p.version ?? '—'}</td>
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
                          if (!res.ok) { alert('Failed to get signed link'); return }
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
                  <td className="p-2 border">{p.ocrStatus || '—'}</td>
                  <td className="p-2 border">
                    <div className="flex gap-2">
                      <button
                        onClick={() => router.push(`/plans/${p.id}/review`)}
                        className="px-2 py-1 border rounded hover:bg-white"
                        title="Set regions & run OCR"
                      >
                        Review
                      </button>
                      {p.ocrStatus && p.ocrStatus !== 'DONE' && (
                        <button
                          onClick={async () => {
                            try {
                              await fetch(`/api/plans/${p.id}/ocr`, { method: 'POST', credentials: 'include' })
                              mutate()
                            } catch (e) {
                              console.error(e); alert('OCR failed')
                            }
                          }}
                          className="px-2 py-1 border rounded hover:bg-white"
                          title="Re-run OCR"
                        >
                          Re-run OCR
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
