'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }
type Settings = {
  ocrDpi?: number
  ocrCorner?: 'BOTTOM_RIGHT' | 'BOTTOM_LEFT' | 'TOP_RIGHT' | 'TOP_LEFT'
  ocrNumberRegion?: Region | null
  ocrTitleRegion?: Region | null
}
type Plan = { id: string; sheetNumber?: string; title?: string; createdAt: string }

const fetcher = (url: string) =>
  fetch(url, { credentials: 'include' }).then((r) => {
    if (!r.ok) throw new Error('Request failed')
    return r.json()
  })

export default function OcrEditorPage({ params }: { params: { id: string } }) {
  const projectId = params.id

  // --- Data ---
  const { data: settings, mutate: mutateSettings } = useSWR<Settings>(
    `/api/projects/${projectId}/ocr-settings`,
    fetcher
  )
  const { data: plans } = useSWR<Plan[]>(
    `/api/projects/${projectId}/plans`,
    fetcher
  )

  // --- UI state ---
  const [planId, setPlanId] = useState<string | ''>('')
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })

  // Default visible boxes immediately; override when settings load
  const [numRegion, setNumRegion] = useState<Region>({
    xPct: 0.72,
    yPct: 0.75,
    wPct: 0.26,
    hPct: 0.22,
  })
  const [titleRegion, setTitleRegion] = useState<Region>({
    xPct: 0.05,
    yPct: 0.05,
    wPct: 0.6,
    hPct: 0.2,
  })

  const containerRef = useRef<HTMLDivElement | null>(null)

  // Initialize from settings once loaded
  useEffect(() => {
    if (!settings) return
    if (settings.ocrNumberRegion) setNumRegion(settings.ocrNumberRegion)
    if (settings.ocrTitleRegion) setTitleRegion(settings.ocrTitleRegion)
  }, [settings])

  // Pick newest plan by default once loaded
  useEffect(() => {
    if (!plans || !plans.length) return
    if (!planId) setPlanId(plans[0].id)
  }, [plans, planId])

  const previewUrl = useMemo(() => {
    if (!planId) return ''
    return `/api/plans/${planId}/preview?ts=${Date.now()}`
  }, [planId])

  // Measure rendered image size (CSS pixels)
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return
      const img = containerRef.current.querySelector('img') as HTMLImageElement | null
      if (!img) return
      setImgSize({ w: img.clientWidth, h: img.clientHeight })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Helpers
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
  const toPx = (r: Region) => ({
    left: Math.round(r.xPct * imgSize.w),
    top: Math.round(r.yPct * imgSize.h),
    width: Math.round(r.wPct * imgSize.w),
    height: Math.round(r.hPct * imgSize.h),
  })

  // Drag handler supporting move, resize from BR and TL
  const onDrag = (
    e: React.PointerEvent,
    which: 'num' | 'title',
    kind: 'move' | 'resize-br' | 'resize-tl'
  ) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)

    const startX = e.clientX
    const startY = e.clientY
    const start =
      which === 'num' ? ({ ...numRegion } as Region) : ({ ...titleRegion } as Region)

    const move = (ev: PointerEvent) => {
      const dxPct = (ev.clientX - startX) / rect.width
      const dyPct = (ev.clientY - startY) / rect.height
      let next = { ...start }

      if (kind === 'move') {
        next.xPct = clamp(start.xPct + dxPct, 0, 1 - start.wPct)
        next.yPct = clamp(start.yPct + dyPct, 0, 1 - start.hPct)
      } else if (kind === 'resize-br') {
        next.wPct = clamp(start.wPct + dxPct, 0.02, 1 - start.xPct)
        next.hPct = clamp(start.hPct + dyPct, 0.02, 1 - start.yPct)
      } else if (kind === 'resize-tl') {
        const newX = clamp(start.xPct + dxPct, 0, start.xPct + start.wPct - 0.02)
        const newY = clamp(start.yPct + dyPct, 0, start.yPct + start.hPct - 0.02)
        next.wPct = clamp(start.wPct - (newX - start.xPct), 0.02, 1 - newX)
        next.hPct = clamp(start.hPct - (newY - start.yPct), 0.02, 1 - newY)
        next.xPct = newX
        next.yPct = newY
      }

      if (which === 'num') setNumRegion(next)
      else setTitleRegion(next)
    }

    const up = () => {
      window.removeEventListener('pointermove', move as any)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move as any)
    window.addEventListener('pointerup', up)
  }

  const save = async () => {
    const body = {
      ocrDpi: settings?.ocrDpi ?? 300,
      ocrNumberRegion: numRegion,
      ocrTitleRegion: titleRegion,
    }
    const res = await fetch(`/api/projects/${projectId}/ocr-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      alert('Failed to save OCR regions')
      return
    }
    await mutateSettings()
    alert('Saved OCR regions')
  }

  const runOcr = async () => {
    if (!planId) return
    const r = await fetch(`/api/plans/${planId}/ocr`, { method: 'POST', credentials: 'include' })
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

      <div className="flex flex-wrap gap-4 items-center">
        <label className="text-sm">Plan:</label>
        <select
          className="border rounded px-2 py-1"
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
        >
          {Array.isArray(plans) &&
            plans.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.sheetNumber || '—')}{' '}
                {p.title ? `— ${p.title}` : ''} ({new Date(p.createdAt).toLocaleDateString()})
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

      <div ref={containerRef} className="relative inline-block border rounded overflow-hidden">
        {previewUrl && (
          <img
            src={previewUrl}
            alt="preview"
            className="max-w-full block"
            onLoad={() => {
              if (!containerRef.current) return
              const img = containerRef.current.querySelector('img') as HTMLImageElement
              setImgSize({ w: img.clientWidth, h: img.clientHeight })
            }}
          />
        )}

        {/* NUMBER (blue) */}
        {imgSize.w > 0 && imgSize.h > 0 && (
          <div
            className="absolute border-2 border-blue-600/80 bg-blue-500/10 z-20"
            style={toPx(numRegion) as any}
          >
            <div className="absolute -top-6 left-0 text-xs bg-blue-600 text-white px-1 rounded">
              Number
            </div>
            {/* move area */}
            <div
              onPointerDown={(e) => onDrag(e, 'num', 'move')}
              className="absolute inset-0 cursor-move"
              title="Drag to move"
            />
            {/* resize: bottom-right */}
            <div
              onPointerDown={(e) => onDrag(e, 'num', 'resize-br')}
              className="absolute w-4 h-4 right-0 bottom-0 translate-x-1/2 translate-y-1/2 bg-blue-600 rounded cursor-se-resize"
              title="Drag to resize"
            />
            {/* resize: top-left */}
            <div
              onPointerDown={(e) => onDrag(e, 'num', 'resize-tl')}
              className="absolute w-4 h-4 left-0 top-0 -translate-x-1/2 -translate-y-1/2 bg-blue-600 rounded cursor-nw-resize"
              title="Drag to resize"
            />
          </div>
        )}

        {/* TITLE (amber) */}
        {imgSize.w > 0 && imgSize.h > 0 && (
          <div
            className="absolute border-2 border-amber-600/80 bg-amber-500/10 z-20"
            style={toPx(titleRegion) as any}
          >
            <div className="absolute -top-6 left-0 text-xs bg-amber-600 text-white px-1 rounded">
              Title
            </div>
            <div
              onPointerDown={(e) => onDrag(e, 'title', 'move')}
              className="absolute inset-0 cursor-move"
              title="Drag to move"
            />
            <div
              onPointerDown={(e) => onDrag(e, 'title', 'resize-br')}
              className="absolute w-4 h-4 right-0 bottom-0 translate-x-1/2 translate-y-1/2 bg-amber-600 rounded cursor-se-resize"
              title="Drag to resize"
            />
            <div
              onPointerDown={(e) => onDrag(e, 'title', 'resize-tl')}
              className="absolute w-4 h-4 left-0 top-0 -translate-x-1/2 -translate-y-1/2 bg-amber-600 rounded cursor-nw-resize"
              title="Drag to resize"
            />
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500">
        Tip: drag the <span className="text-blue-600 font-medium">blue</span> box to the sheet
        <b> number</b> area (often bottom-right). Drag the{' '}
        <span className="text-amber-600 font-medium">amber</span> box to the <b>title</b>.
      </p>
    </div>
  )
}
