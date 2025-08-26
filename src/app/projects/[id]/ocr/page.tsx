'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

const fetcher = (url: string) => fetch(url, { credentials: 'include' }).then(r => r.json())

export default function OcrEditorPage({ params }: { params: { id: string } }) {
  const projectId = params.id

  // 1) Load project OCR settings
  const { data: settings, mutate: mutateSettings } = useSWR(
    `/api/projects/${projectId}/ocr-settings`,
    fetcher
  )

  // 2) Load this project's plans (to pick one for preview)
  const { data: plans } = useSWR(`/api/projects/${projectId}/plans`, fetcher)

  const [planId, setPlanId] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const imgRef = useRef<HTMLImageElement | null>(null)

  // local editable regions (fallback defaults if no settings yet)
  const [numRegion, setNumRegion] = useState<Region | null>(null)
  const [titleRegion, setTitleRegion] = useState<Region | null>(null)

  // initialize from settings once loaded
  useEffect(() => {
    if (!settings) return
    setNumRegion(
      settings.ocrNumberRegion ?? { xPct: 0.72, yPct: 0.75, wPct: 0.26, hPct: 0.22 }
    )
    setTitleRegion(
      settings.ocrTitleRegion ?? { xPct: 0.05, yPct: 0.05, wPct: 0.60, hPct: 0.20 }
    )
  }, [settings])

  // pick the newest plan by default
  useEffect(() => {
    if (plans && Array.isArray(plans) && plans.length && !planId) {
      setPlanId(plans[0].id)
    }
  }, [plans, planId])

  const previewUrl = useMemo(() => {
    if (!planId) return ''
    // add cache-buster
    return `/api/plans/${planId}/preview?ts=${Date.now()}`
  }, [planId])

  // helpers to convert pct<->px
  const toPx = (r: Region) => ({
    left: Math.round(r.xPct * imgSize.w),
    top: Math.round(r.yPct * imgSize.h),
    width: Math.round(r.wPct * imgSize.w),
    height: Math.round(r.hPct * imgSize.h),
  })
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const onDrag = (
    e: React.PointerEvent,
    which: 'num' | 'title',
    kind: 'move' | 'resize'
  ) => {
    if (!imgRef.current) return
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)

    const startX = e.clientX
    const startY = e.clientY
    const start = which === 'num' ? (numRegion as Region) : (titleRegion as Region)

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / rect.width
      const dy = (ev.clientY - startY) / rect.height

      let next: Region = { ...start }

      if (kind === 'move') {
        next.xPct = clamp(start.xPct + dx, 0, 1 - start.wPct)
        next.yPct = clamp(start.yPct + dy, 0, 1 - start.hPct)
      } else {
        // resize from bottom-right corner for simplicity
        next.wPct = clamp(start.wPct + dx, 0.02, 1 - start.xPct)
        next.hPct = clamp(start.hPct + dy, 0.02, 1 - start.yPct)
      }

      if (which === 'num') setNumRegion(next)
      else setTitleRegion(next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove as any)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove as any)
    window.addEventListener('pointerup', onUp)
  }

  const save = async () => {
    if (!numRegion || !titleRegion) return
    const res = await fetch(`/api/projects/${projectId}/ocr-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        ocrDpi: settings?.ocrDpi ?? 300,
        ocrNumberRegion: numRegion,
        ocrTitleRegion: titleRegion,
      }),
    })
    if (res.ok) {
      await mutateSettings()
      alert('Saved OCR regions')
    } else {
      alert('Failed to save OCR regions')
    }
  }

  const runOcr = async () => {
    if (!planId) return
    const r = await fetch(`/api/plans/${planId}/ocr`, {
      method: 'POST',
      credentials: 'include',
    })
    const j = await r.json()
    if (!r.ok) {
      console.error(j)
      alert('OCR failed')
      return
    }
    alert(`OCR done:\n${JSON.stringify(j.suggestions, null, 2)}`)
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">OCR Region Editor</h1>

      <div className="flex gap-4 items-center">
        <label className="text-sm">Plan:</label>
        <select
          className="border rounded px-2 py-1"
          value={planId ?? ''}
          onChange={(e) => setPlanId(e.target.value)}
        >
          {Array.isArray(plans) &&
            plans.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.sheetNumber || '—'} {p.title ? `— ${p.title}` : ''} ({new Date(p.createdAt).toLocaleDateString()})
              </option>
            ))}
        </select>

        <button
          onClick={save}
          className="ml-auto px-3 py-1.5 rounded bg-black text-white hover:opacity-90"
        >
          Save Regions
        </button>
        <button
          onClick={runOcr}
          className="px-3 py-1.5 rounded border hover:bg-gray-50"
        >
          Run OCR on this Plan
        </button>
      </div>

      <div className="relative inline-block border rounded overflow-hidden">
        {previewUrl && (
          <img
            ref={imgRef}
            src={previewUrl}
            alt="preview"
            onLoad={(e) => {
              const el = e.currentTarget
              setImgSize({ w: el.naturalWidth, h: el.naturalHeight })
            }}
            className="max-w-full"
            style={{ display: 'block' }}
          />
        )}

        {/* overlay layer for regions */}
        {(numRegion && imgRef.current) && (
          <div
            className="absolute border-2 border-blue-600/80 bg-blue-500/10"
            style={toPx(numRegion) as any}
          >
            <div className="absolute -top-6 left-0 text-xs bg-blue-600 text-white px-1 rounded">Number</div>
            <div
              onPointerDown={(e) => onDrag(e, 'num', 'move')}
              className="absolute inset-0 cursor-move"
              title="Drag to move"
            />
            <div
              onPointerDown={(e) => onDrag(e, 'num', 'resize')}
              className="absolute w-4 h-4 right-0 bottom-0 translate-x-1/2 translate-y-1/2 bg-blue-600 rounded cursor-se-resize"
              title="Drag to resize"
            />
          </div>
        )}

        {(titleRegion && imgRef.current) && (
          <div
            className="absolute border-2 border-amber-600/80 bg-amber-500/10"
            style={toPx(titleRegion) as any}
          >
            <div className="absolute -top-6 left-0 text-xs bg-amber-600 text-white px-1 rounded">Title</div>
            <div
              onPointerDown={(e) => onDrag(e, 'title', 'move')}
              className="absolute inset-0 cursor-move"
              title="Drag to move"
            />
            <div
              onPointerDown={(e) => onDrag(e, 'title', 'resize')}
              className="absolute w-4 h-4 right-0 bottom-0 translate-x-1/2 translate-y-1/2 bg-amber-600 rounded cursor-se-resize"
              title="Drag to resize"
            />
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500">
        Tip: drag the blue box to the sheet <b>number</b> area (often bottom-right). Drag the amber box to the <b>title</b>.
      </p>
    </div>
  )
}
