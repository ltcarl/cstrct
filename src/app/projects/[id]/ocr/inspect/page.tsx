'use client'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

type Resp = {
  dpi: number
  previewPng: string
  numberCrop: string | null
  titleCrop: string | null
}

export default function OcrInspectPage({ params }: { params: { id: string } }) {
  const projectId = params.id
  const search = useSearchParams()
  const planId = search.get('planId') || ''

  const [data, setData] = useState<Resp | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!planId) return
    fetch(`/api/plans/${planId}/ocr-crops`, { credentials: 'include' })
      .then(r => r.json())
      .then(setData)
      .catch(e => setErr(String(e)))
  }, [planId])

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">OCR Crops (server-side) — Project {projectId}</h1>
      <p className="text-sm text-gray-600">
        This shows the exact regions the server will OCR (rasterized at the project’s DPI).
      </p>

      {!planId && <p className="text-red-600">Missing planId in URL.</p>}
      {err && <p className="text-red-600">{err}</p>}
      {!data && <p>Loading…</p>}

      {data && (
        <div className="space-y-4">
          <div className="text-sm text-gray-600">Raster DPI: {data.dpi}</div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
            <div>
              <div className="font-medium mb-2">Full Page (page 1)</div>
              <img src={data.previewPng} className="max-w-full border rounded" />
            </div>

            <div>
              <div className="font-medium mb-2">Number Region</div>
              {data.numberCrop ? (
                <img src={data.numberCrop} className="max-w-full border rounded bg-white" />
              ) : (
                <div className="text-sm text-gray-500">No number region configured</div>
              )}
            </div>

            <div>
              <div className="font-medium mb-2">Title Region</div>
              {data.titleCrop ? (
                <img src={data.titleCrop} className="max-w-full border rounded bg-white" />
              ) : (
                <div className="text-sm text-gray-500">No title region configured</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
