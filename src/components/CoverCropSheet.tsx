import { useEffect, useRef, useState, type PointerEvent, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import './CoverCropSheet.css'

const OUTPUT = 1000

type Props = {
  file: File | Blob
  fileName?: string
  onCancel: () => void
  onConfirm: (file: File) => Promise<void>
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function coverOffset(frame: number, nw: number, nh: number, zoom: number) {
  const scale = Math.max(frame / nw, frame / nh) * zoom
  const drawW = nw * scale
  const drawH = nh * scale
  return {
    scale,
    drawW,
    drawH,
    minX: Math.min(0, frame - drawW),
    minY: Math.min(0, frame - drawH),
    maxX: 0,
    maxY: 0,
    centerX: (frame - drawW) / 2,
    centerY: (frame - drawH) / 2,
  }
}

export function CoverCropSheet({ file, fileName = 'cover.jpg', onCancel, onConfirm }: Props) {
  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [frame, setFrame] = useState(280)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [busy, setBusy] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)

  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const measure = () => setFrame(Math.min(el.clientWidth, 340) || 280)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout =
    natural.w > 0 && natural.h > 0
      ? coverOffset(frame, natural.w, natural.h, zoom)
      : null

  const constrained = layout
    ? {
        x: clamp(offset.x, layout.minX, layout.maxX),
        y: clamp(offset.y, layout.minY, layout.maxY),
      }
    : { x: 0, y: 0 }

  useEffect(() => {
    if (!layout) return
    setOffset((prev) => ({
      x: clamp(prev.x, layout.minX, layout.maxX),
      y: clamp(prev.y, layout.minY, layout.maxY),
    }))
  }, [zoom, frame, natural.w, natural.h])

  const onImgLoad = (img: HTMLImageElement) => {
    imgRef.current = img
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    setNatural({ w: nw, h: nh })
    setZoom(1)
    const f = frameRef.current ? Math.min(frameRef.current.clientWidth, 340) || 280 : frame
    const L = coverOffset(f, nw, nh, 1)
    setOffset({ x: L.centerX, y: L.centerY })
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.cover-crop__zoom')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: constrained.x,
      origY: constrained.y,
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    setOffset({
      x: d.origX + (e.clientX - d.startX),
      y: d.origY + (e.clientY - d.startY),
    })
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const a = e.touches[0]
      const b = e.touches[1]
      pinchRef.current = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        zoom,
      }
      dragRef.current = null
    }
  }

  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault()
      const a = e.touches[0]
      const b = e.touches[1]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      setZoom(clamp(pinchRef.current.zoom * (dist / pinchRef.current.dist), 1, 4))
    }
  }

  const onTouchEnd = () => {
    pinchRef.current = null
  }

  const exportCrop = async () => {
    const img = imgRef.current
    if (!img || !layout) {
      window.alert('Espera a que cargue la imagen o prueba con otra (JPG/PNG).')
      return
    }
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = OUTPUT
      canvas.height = OUTPUT
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        window.alert('No se pudo preparar la imagen en este navegador.')
        return
      }

      const scale = layout.scale
      const sx = -constrained.x / scale
      const sy = -constrained.y / scale
      const sw = frame / scale
      const sh = frame / scale

      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, OUTPUT, OUTPUT)

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92),
      )
      if (!blob) {
        window.alert('No se pudo exportar la imagen. Prueba con JPG o PNG.')
        return
      }
      const outName = fileName.replace(/\.\w+$/, '') + '-cover.jpg'
      await onConfirm(new File([blob], outName, { type: 'image/jpeg' }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al guardar la portada'
      window.alert(msg)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="sheet cover-crop-sheet">
      <button type="button" className="sheet-backdrop" onClick={onCancel} />
      <div className="sheet__panel cover-crop">
        <h3>Ajustar portada</h3>
        <p className="cover-crop__hint">Arrastra para mover · pellizca o usa el zoom</p>

        <div
          ref={frameRef}
          className="cover-crop__frame"
          style={{ width: '100%', maxWidth: 340, aspectRatio: '1' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              className="cover-crop__img"
              style={{
                width: natural.w || undefined,
                height: natural.h || undefined,
                transform: `translate(${constrained.x}px, ${constrained.y}px) scale(${layout?.scale ?? 1})`,
                transformOrigin: '0 0',
              }}
              onLoad={(e) => onImgLoad(e.currentTarget)}
            />
          )}
          <div className="cover-crop__mask" aria-hidden />
        </div>

        <label className="cover-crop__zoom">
          Zoom
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>

        <div className="cover-crop__actions">
          <button type="button" className="cover-crop__btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary cover-crop__save"
            onClick={() => void exportCrop()}
            disabled={busy || !natural.w}
          >
            {busy ? 'Guardando…' : 'Usar este recorte'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
