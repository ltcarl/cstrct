'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

type Region = { xPct: number; yPct: number; wPct: number; hPct: number }

export default function PlanReviewPage({ params }: { params: { id: string } }) {
  const planId = params.id
  const [projectId, setProjectId] = useState<string>('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 })
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [numRegion, setNumRegion] = useState<Region>({ xPct: 0.72, yPct: 0.75, wPct: 0.26, hPct: 0.22 })
  const [titleRegion, setTitleRegion] = useState<Region>({ xPct: 0.05, yPct: 0.05, wPct: 0.60, hPct: 0.20 })
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<null | {
    suggestions: { sheetNumber?: string; title?: string; discipline?: string; confidence?: number }
    alternatives?: { sheetNumbers: string[] }
  }>(null)
  const [useAsDefault, setUseAsDefault] = useState(true) // checkbox

  // fetch minimal plan info + project ocr settings
  useEffect(() => {
    (async () => {
      const plan = await fetch(`/api/plans/${planId}`, { credentials: 'include' }).then(r => r.json())
      setProjectId(plan.projectId)
      setPreviewUrl(`/api/plans/${planId}/preview?ts=${Date.now()}`)

      const settings = await fetch(`/api/projects/${plan.projectId}/ocr-settings`, { credentials: 'include' }).then(r => r.json())
      if (settings?.ocrNumberRegion) setNumRegion(settings.ocrNumberRegion)
      if (settings?.ocrTitleRegion) setTitleRegion(settings.ocrTitleRegion)
    })()
  }, [planId])

  // helpers
  const clamp = (v:number,min:number,max:number)=>Math.max(min,Math.min(max,v))
  const toPx = (r:Region)=>({
    left: Math.round(r.xPct * imgSize.w),
    top: Math.round(r.yPct * imgSize.h),
    width: Math.round(r.wPct * imgSize.w),
    height: Math.round(r.hPct * imgSize.h),
  })
  const onDrag = (e:React.PointerEvent, which:'num'|'title', kind:'move'|'resize-br'|'resize-tl')=>{
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    const startX = e.clientX, startY = e.clientY
    const start = which==='num'? {...numRegion}:{...titleRegion}
    const move = (ev:PointerEvent)=>{
      const dx = (ev.clientX - startX) / rect.width
      const dy = (ev.clientY - startY) / rect.height
      let next = { ...start }
      if (kind==='move'){
        next.xPct = clamp(start.xPct + dx, 0, 1 - start.wPct)
        next.yPct = clamp(start.yPct + dy, 0, 1 - start.hPct)
      } else if (kind==='resize-br'){
        next.wPct = clamp(start.wPct + dx, 0.02, 1 - start.xPct)
        next.hPct = clamp(start.hPct + dy, 0.02, 1 - start.yPct)
      } else {
        const newX = clamp(start.xPct + dx, 0, start.xPct + start.wPct - 0.02)
        const newY = clamp(start.yPct + dy, 0, start.yPct + start.hPct - 0.02)
        next.wPct = clamp(start.wPct - (newX - start.xPct), 0.02, 1 - newX)
        next.hPct = clamp(start.hPct - (newY - start.yPct), 0.02, 1 - newY)
        next.xPct = newX; next.yPct = newY
      }
      which==='num'? setNumRegion(next) : setTitleRegion(next)
    }
    const up = ()=>{ window.removeEventListener('pointermove', move as any); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move as any)
    window.addEventListener('pointerup', up)
  }

  // Single-button flow: save regions + run OCR
  const runOcr = async () => {
    if (!projectId) return
    setLoading(true)
    try {
      // 1) save regions to project (so they’re defaults)
      await fetch(`/api/projects/${projectId}/ocr-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ocrNumberRegion: numRegion, ocrTitleRegion: titleRegion })
      })
      // 2) run ocr
      const res = await fetch(`/api/plans/${planId}/ocr`, { method: 'POST', credentials: 'include' })
      const j = await res.json()
      // mine alternatives (top unique sheet-number candidates) from debug if present
      const alts = Array.isArray(j?.debug?.numberOCR?.variants)
        ? [...new Set(j.debug.numberOCR.variants.map((v:any)=>v?.picked).filter(Boolean))].slice(0,5)
        : []
      setResult({ suggestions: j.suggestions || {}, alternatives: { sheetNumbers: alts } })
    } finally {
      setLoading(false)
    }
  }

  const accept = async (overrideNumber?: string) => {
    const payload = {
      overrideNumber: overrideNumber || undefined,
      useRegionsAsDefault: useAsDefault,
      numberRegion: numRegion,
      titleRegion: titleRegion,
    }
    const r = await fetch(`/api/plans/${planId}/apply-suggestions`, {
      method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    })
    if (!r.ok) { alert('Failed to apply'); return }
    // go back to project plans list (or show success)
    window.location.href = `/projects/${projectId}` // adjust to your listing route
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Review Sheet</h1>

      <div className="flex items-center gap-4">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useAsDefault} onChange={e=>setUseAsDefault(e.target.checked)} />
          Use these regions for this project
        </label>

        <button
          onClick={runOcr}
          disabled={loading}
          className="ml-auto px-3 py-1.5 rounded bg-black text-white disabled:opacity-50"
        >
          {loading ? 'Running…' : 'Run OCR'}
        </button>
      </div>

      <div ref={containerRef} className="relative inline-block border rounded overflow-hidden">
        {previewUrl && (
          <img
            src={previewUrl}
            alt="preview"
            className="max-w-full block"
            onLoad={(e) => {
              const el = e.currentTarget
              setImgSize({ w: el.clientWidth, h: el.clientHeight })
            }}
          />
        )}

        {/* Number (blue) */}
        {imgSize.w>0 && (
          <div className="absolute border-2 border-blue-600/80 bg-blue-500/10 z-20" style={toPx(numRegion) as any}>
            <div className="absolute -top-6 left-0 text-xs bg-blue-600 text-white px-1 rounded">Number</div>
            <div onPointerDown={(e)=>onDrag(e,'num','move')} className="absolute inset-0 cursor-move" />
            <div onPointerDown={(e)=>onDrag(e,'num','resize-br')} className="absolute w-4 h-4 right-0 bottom-0 translate-x-1/2 translate-y-1/2 bg-blue-600 rounded cursor-se-resize" />
            <div onPointerDown={(e)=>onDrag(e,'num','resize-tl')} className="absolute w-4 h-4 left-0 top-0 -translate-x-1/2 -translate-y-1/2 bg-blue-600 rounded cursor-nw-resize" />
          </div>
        )}

        {/* Title (amber) */}
        {imgSize.w>0 && (
          <div className="absolute border-2 border-amber-600/80 bg-amber-500/10 z-20" style={toPx(titleRegion) as any}>
            <div className="absolute -top-6 left-0 text-xs bg-amber-600 text-white px-1 rounded">Title</div>
            <div onPointerDown={(e)=>onDrag(e,'title','move')} className="absolute inset-0 cursor-move" />
            <div onPointerDown={(e)=>onDrag(e,'title','resize-br')} className="absolute w-4 h-4 right-0 bottom-0 translate-x-1/2 translate-y-1/2 bg-amber-600 rounded cursor-se-resize" />
            <div onPointerDown={(e)=>onDrag(e,'title','resize-tl')} className="absolute w-4 h-4 left-0 top-0 -translate-x-1/2 -translate-y-1/2 bg-amber-600 rounded cursor-nw-resize" />
          </div>
        )}
      </div>

      {result && (
        <div className="mt-4 p-3 border rounded bg-gray-50">
          <div className="text-sm text-gray-700">
            <div><b>Detected Number:</b> {result.suggestions.sheetNumber || '—'}</div>
            <div><b>Detected Title:</b> {result.suggestions.title || '—'}</div>
            <div><b>Discipline:</b> {result.suggestions.discipline || '—'}</div>
            <div><b>Confidence:</b> {result.suggestions.confidence?.toFixed(2) ?? '—'}</div>
          </div>

          {result.alternatives?.sheetNumbers?.length ? (
            <div className="mt-3">
              <div className="text-sm font-medium">Other possible sheet numbers:</div>
              <div className="flex flex-wrap gap-2 mt-2">
                {result.alternatives.sheetNumbers.map((n) => (
                  <button key={n} onClick={()=>accept(n)}
                    className="px-2 py-1 border rounded hover:bg-white">
                    Use “{n}”
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex gap-2">
            <button
              onClick={()=>accept()}
              className="px-3 py-1.5 rounded bg-green-600 text-white"
            >
              Looks good — Apply
            </button>
            <button
              onClick={()=>setResult(null)}
              className="px-3 py-1.5 rounded border"
            >
              Adjust boxes & re-run
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
