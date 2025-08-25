'use client'
export function PlanViewer({ fileUrl }: { fileUrl: string }) {
  return (
    <div className="w-full h-[75vh] border rounded-lg overflow-hidden">
      {/* Simple embedded PDF viewer. Works on most browsers + mobile. */}
      <object data={fileUrl} type="application/pdf" className="w-full h-full">
        <iframe src={fileUrl} className="w-full h-full" title="Plan PDF" />
      </object>
    </div>
  )
}