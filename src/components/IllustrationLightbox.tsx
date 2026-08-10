import { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { usePresence } from '../hooks/usePresence'
import { saveImageToDevice } from '../providers/imageAssetStore'

const LIGHTBOX_MIN_SCALE = 1
const LIGHTBOX_MAX_SCALE = 8
const LIGHTBOX_TAP_MOVE_TOLERANCE = 8
const LIGHTBOX_DOUBLE_TAP_INTERVAL_MS = 300
const LIGHTBOX_DOUBLE_TAP_DISTANCE = 28
const LIGHTBOX_DOUBLE_TAP_SCALE = 2.5
const LIGHTBOX_PINCH_MIN_START_DISTANCE = 40
const LIGHTBOX_PINCH_SENSITIVITY = 0.6

export type LightboxImage = {
  source: string
  title: string
  alt: string
  localUri?: string
}

type IllustrationLightboxProps = {
  image?: LightboxImage
  onClose: () => void
  onToast: (message: string) => void
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export default function IllustrationLightbox({ image, onClose, onToast }: IllustrationLightboxProps) {
  const [scale, setScale] = useState(LIGHTBOX_MIN_SCALE)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [saving, setSaving] = useState(false)
  const [toolbarVisible, setToolbarVisible] = useState(true)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const lastTapRef = useRef<{ x: number; y: number; at: number } | undefined>(undefined)
  const draggedRef = useRef(false)
  const lastPointerRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const toolbarTimerRef = useRef<number | undefined>(undefined)
  const viewRef = useRef({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 })
  const gestureRef = useRef<'none' | 'pan' | 'pinch'>('none')
  const pinchRef = useRef<{
    startDistance: number
    startScale: number
    startMid: { x: number; y: number }
    startOffset: { x: number; y: number }
  } | undefined>(undefined)
  const { present, closing } = usePresence(Boolean(image), onClose, 180)
  const lastImageRef = useRef(image)
  if (image) lastImageRef.current = image
  const visibleImage = image ?? lastImageRef.current

  function applyView(nextView: { scale: number; x: number; y: number }) {
    viewRef.current = nextView
    setScale(nextView.scale)
    setOffset({ x: nextView.x, y: nextView.y })
  }

  useEffect(() => {
    applyView({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 })
    pointersRef.current.clear()
    gestureRef.current = 'none'
    pinchRef.current = undefined
    lastTapRef.current = undefined
    draggedRef.current = false
    lastPointerRef.current = undefined
  }, [image])

  useEffect(() => {
    if (!image) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [image, onClose])

  useEffect(() => {
    if (!image) return
    const stage = stageRef.current
    if (!stage) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18
      zoomAround({ x: event.clientX, y: event.clientY }, factor)
    }
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  })

  useEffect(() => {
    if (!toolbarVisible) return
    window.clearTimeout(toolbarTimerRef.current)
    toolbarTimerRef.current = window.setTimeout(() => setToolbarVisible(false), 2800)
    return () => window.clearTimeout(toolbarTimerRef.current)
  }, [toolbarVisible])

  if (!present || !visibleImage) return null

  function showToolbar() {
    setToolbarVisible(true)
  }

  function stageCenter() {
    const stage = stageRef.current
    if (!stage) return { x: 0, y: 0 }
    const rect = stage.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  function clampOffset(nextOffset: { x: number; y: number }, nextScale: number) {
    const stage = stageRef.current
    const imageElement = imageRef.current
    if (!stage || !imageElement) return nextOffset
    const viewWidth = stage.clientWidth
    const viewHeight = stage.clientHeight
    const imageWidth = imageElement.offsetWidth * nextScale
    const imageHeight = imageElement.offsetHeight * nextScale
    const minVisible = 72
    const maxX = Math.max(0, Math.min(imageWidth, viewWidth) / 2 + (imageWidth > viewWidth ? minVisible : 0))
    const maxY = Math.max(0, Math.min(imageHeight, viewHeight) / 2 + (imageHeight > viewHeight ? minVisible : 0))
    return { x: clamp(nextOffset.x, -maxX, maxX), y: clamp(nextOffset.y, -maxY, maxY) }
  }

  function zoomAround(point: { x: number; y: number }, factor: number) {
    const current = viewRef.current
    const nextScale = clamp(current.scale * factor, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE)
    const center = stageCenter()
    const nextOffset = clampOffset(
      {
        x: point.x - center.x - (point.x - center.x - current.x) * (nextScale / current.scale),
        y: point.y - center.y - (point.y - center.y - current.y) * (nextScale / current.scale),
      },
      nextScale,
    )
    applyView({ scale: nextScale, x: nextOffset.x, y: nextOffset.y })
  }

  function resetZoom() {
    applyView({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 })
  }

  function beginPinch() {
    const [first, second] = Array.from(pointersRef.current.values())
    const current = viewRef.current
    const distance = Math.hypot(first.x - second.x, first.y - second.y)
    pinchRef.current = {
      startDistance: Math.max(distance, LIGHTBOX_PINCH_MIN_START_DISTANCE),
      startScale: current.scale,
      startMid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      startOffset: { x: current.x, y: current.y },
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    draggedRef.current = false
    lastPointerRef.current = { x: event.clientX, y: event.clientY }
    showToolbar()

    if (pointersRef.current.size === 2) {
      beginPinch()
      gestureRef.current = 'pinch'
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return
    const previous = lastPointerRef.current
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    lastPointerRef.current = { x: event.clientX, y: event.clientY }

    if (previous && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > LIGHTBOX_TAP_MOVE_TOLERANCE) {
      draggedRef.current = true
      lastTapRef.current = undefined
    }

    if (pointersRef.current.size >= 2) {
      if (gestureRef.current !== 'pinch') beginPinch()
      gestureRef.current = 'pinch'
      const pinch = pinchRef.current
      if (!pinch) return
      const [first, second] = Array.from(pointersRef.current.values())
      const distance = Math.hypot(first.x - second.x, first.y - second.y)
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      const rawFactor = distance / pinch.startDistance
      const factor = 1 + (rawFactor - 1) * LIGHTBOX_PINCH_SENSITIVITY
      const nextScale = clamp(pinch.startScale * factor, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE)
      const center = stageCenter()
      const nextOffset = clampOffset(
        {
          x: midpoint.x - center.x - (pinch.startMid.x - center.x - pinch.startOffset.x) * (nextScale / pinch.startScale),
          y: midpoint.y - center.y - (pinch.startMid.y - center.y - pinch.startOffset.y) * (nextScale / pinch.startScale),
        },
        nextScale,
      )
      applyView({ scale: nextScale, x: nextOffset.x, y: nextOffset.y })
      return
    }

    if (gestureRef.current === 'pinch') {
      gestureRef.current = viewRef.current.scale > LIGHTBOX_MIN_SCALE ? 'pan' : 'none'
    }
    if (!previous) return
    const deltaX = event.clientX - previous.x
    const deltaY = event.clientY - previous.y
    const current = viewRef.current
    if (current.scale > LIGHTBOX_MIN_SCALE) {
      gestureRef.current = 'pan'
      const nextOffset = clampOffset({ x: current.x + deltaX, y: current.y + deltaY }, current.scale)
      applyView({ scale: current.scale, x: nextOffset.x, y: nextOffset.y })
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    pointersRef.current.delete(event.pointerId)

    if (pointersRef.current.size === 1) {
      const [remaining] = Array.from(pointersRef.current.values())
      pinchRef.current = undefined
      gestureRef.current = viewRef.current.scale > LIGHTBOX_MIN_SCALE ? 'pan' : 'none'
      lastPointerRef.current = { x: remaining.x, y: remaining.y }
      return
    }
    if (pointersRef.current.size === 0) {
      pinchRef.current = undefined
      gestureRef.current = 'none'
      lastPointerRef.current = undefined
    }

    const now = Date.now()
    const lastTap = lastTapRef.current
    if (!draggedRef.current && pointersRef.current.size === 0) {
      const tapPoint = { x: event.clientX, y: event.clientY }
      if (lastTap && now - lastTap.at < LIGHTBOX_DOUBLE_TAP_INTERVAL_MS && Math.hypot(tapPoint.x - lastTap.x, tapPoint.y - lastTap.y) < LIGHTBOX_DOUBLE_TAP_DISTANCE) {
        lastTapRef.current = undefined
        if (viewRef.current.scale <= LIGHTBOX_MIN_SCALE) zoomAround(tapPoint, LIGHTBOX_DOUBLE_TAP_SCALE)
        else resetZoom()
        return
      }
      lastTapRef.current = { x: tapPoint.x, y: tapPoint.y, at: now }
    } else {
      lastTapRef.current = undefined
    }
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target && pointersRef.current.size === 0) {
      onClose()
      return
    }
    handlePointerDown(event)
  }

  async function handleSave() {
    if (!visibleImage || saving) return
    setSaving(true)
    try {
      await saveImageToDevice(visibleImage.source, visibleImage.localUri, visibleImage.title)
      onToast('图片已保存到相册')
    } catch (error) {
      onToast(error instanceof Error && error.message ? `保存失败：${error.message}` : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const scalePercent = Math.round(scale * 100)

  return (
    <div className={`image-lightbox-backdrop${closing ? ' closing' : ''}`} role="presentation">
      <section
        ref={stageRef}
        className="image-lightbox-stage"
        role="dialog"
        aria-modal="true"
        aria-label={visibleImage.title}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          ref={imageRef}
          src={visibleImage.source}
          alt={visibleImage.alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
        <div className={`image-lightbox-toolbar${toolbarVisible ? ' visible' : ''}`}>
          <h2>{visibleImage.title}</h2>
          <div className="image-lightbox-tools">
            <button className="icon-button" type="button" aria-label="放大" onClick={() => zoomAround(stageCenter(), 1.5)}><ZoomIn size={19} /></button>
            <button className="icon-button" type="button" aria-label="缩小" onClick={() => zoomAround(stageCenter(), 1 / 1.5)}><ZoomOut size={19} /></button>
            <button className="icon-button" type="button" aria-label="复位缩放" onClick={resetZoom} disabled={scale === 1}><RotateCcw size={19} /></button>
            <button className="icon-button" type="button" aria-label="保存图片到手机" disabled={saving} onClick={() => void handleSave()}>
              {saving ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}
            </button>
            <button className="icon-button" type="button" aria-label="关闭图片预览" onClick={onClose}><X size={20} /></button>
          </div>
          {scale > LIGHTBOX_MIN_SCALE && <span className="image-lightbox-scale">{scalePercent}%</span>}
        </div>
      </section>
    </div>
  )
}
