import {
  Container as CoreContainer,
  Glass as CoreGlass,
  Scene as CoreScene,
  WebGpuGlassCore,
} from '@liquid-dom/core'
import { useEffect, useRef } from 'react'
import './App.css'

const wallpaperSrc = '/bg.webp'

const coreGlassOptions = {
  blur: 8,
  spacing: 10,
  bezelWidth: 12,
  tint: { r: 0.1, g: 0.1, b: 0.1, a: 0.2 },
  shadowColor: { r: 0, g: 0, b: 0, a: 0.2 },
  shadowOffsetY: 7,
  shadowBlur: 21,
  specularOpacity: 0.6,
}

const handleGlassOptions = {
  ...coreGlassOptions,
  blur: 12,
  spacing: 2,
  bezelWidth: 4,
  tint: { r: 0.72, g: 0.86, b: 1, a: 0.34 },
  shadowColor: { r: 0, g: 0, b: 0, a: 0.28 },
  shadowOffsetY: 3,
  shadowBlur: 10,
  specularOpacity: 0.9,
  zIndex: 2,
}

const canvasPadding = 18
const defaultGlassGap = 48
const defaultGlassHeight = 260
const defaultGlassRadius = 46
const defaultGlassWidth = 280
const resizeHandleSize = 14
const radiusHandleSize = 16
const circularCornerExponent = 2
const cornerSmoothing = 0.6
const cornerSmoothingExponentDelta = (4 - circularCornerExponent) / cornerSmoothing
const sdfEpsilon = 0.0001
const resizeHandleOrder: ResizeHandle[] = [
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
  'nw',
]

type CanvasSize = {
  dpr: number
  height: number
  pixelHeight: number
  pixelWidth: number
  width: number
}

type GlassRect = {
  height: number
  radius: number
  width: number
  x: number
  y: number
}

type Point = {
  x: number
  y: number
}

type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

type HitTarget =
  | { type: 'none' }
  | { index: number; type: 'body' }
  | { type: 'radius' }
  | { type: 'resize'; handle: ResizeHandle }

type InteractionMode = 'idle' | 'drag' | 'radius' | 'resize'

type InteractionState = {
  activeIndex: number | null
  mode: InteractionMode
  pointerId: number | null
  rects: GlassRect[] | null
  resizeHandle: ResizeHandle | null
  selectedIndex: number | null
  startPoint: Point
  startRect: GlassRect
}

type GradientVariant = 'middleBlack' | 'linearBlack'

type GlassItem = {
  glass: CoreGlass
  gradient: GradientVariant
}

type RendererHandles = {
  backdropCanvas: HTMLCanvasElement
  backdropContext: CanvasRenderingContext2D
  backdropTexture: GPUTexture | null
  context: GPUCanvasContext
  core: WebGpuGlassCore
  device: GPUDevice
  format: GPUTextureFormat
  items: GlassItem[]
  radiusHandle: CoreGlass
  resizeHandles: Record<ResizeHandle, CoreGlass>
  scene: CoreScene
  size: CanvasSize
  uiContainer: CoreContainer
}

type QuickGlassWindow = Window & {
  __quickGlassRect?: GlassRect
  __quickGlassRects?: GlassRect[]
  __quickGlassStatus?: string
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let disposed = false
    let fallbackActive = false
    let frame = 0
    let handles: RendererHandles | null = null
    let imageReady = false
    const interaction: InteractionState = {
      activeIndex: null,
      mode: 'idle',
      pointerId: null,
      rects: null,
      resizeHandle: null,
      selectedIndex: null,
      startPoint: { x: 0, y: 0 },
      startRect: { height: 0, radius: 0, width: 0, x: 0, y: 0 },
    }

    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (disposed) return
      imageReady = true
      if (fallbackActive) {
        paintUnsupportedFallback(canvas, image, imageReady)
      }
      requestRender()
    }
    image.onerror = () => {
      if (disposed) return
      imageReady = false
      requestRender()
    }
    image.src = wallpaperSrc

    const requestRender = () => {
      if (disposed || document.hidden || frame) return
      frame = requestAnimationFrame(render)
    }

    const render = () => {
      frame = 0
      if (disposed || !handles) return

      resizeRenderer(canvas, handles)
      paintBackdrop(
        handles.backdropContext,
        image,
        imageReady,
        handles.size.width,
        handles.size.height,
      )
      paintRectBackgroundLayers(handles.backdropContext, handles, interaction)
      syncBackdropTexture(handles)
      syncGlassRects(handles, interaction)

      handles.core.render({
        scene: handles.scene,
        width: handles.size.pixelWidth,
        height: handles.size.pixelHeight,
        dpr: handles.size.dpr,
        outputTexture: handles.context.getCurrentTexture(),
        backdropTexture: handles.backdropTexture,
      })
    }

    const initialize = async () => {
      const gpu = navigator.gpu
      if (!gpu) {
        ;(window as QuickGlassWindow).__quickGlassStatus = 'fallback:no-navigator-gpu'
        fallbackActive = true
        paintUnsupportedFallback(canvas, image, imageReady)
        return
      }

      const adapter = await gpu.requestAdapter()
      if (disposed) return

      if (!adapter) {
        ;(window as QuickGlassWindow).__quickGlassStatus = 'fallback:no-adapter'
        fallbackActive = true
        paintUnsupportedFallback(canvas, image, imageReady)
        return
      }

      const device = await adapter.requestDevice()
      if (disposed) {
        device.destroy()
        return
      }

      const context = canvas.getContext('webgpu')

      if (
        !context ||
        typeof device.queue.copyExternalImageToTexture !== 'function'
      ) {
        device.destroy()
        ;(window as QuickGlassWindow).__quickGlassStatus = 'fallback:no-webgpu-canvas'
        fallbackActive = true
        paintUnsupportedFallback(canvas, image, imageReady)
        return
      }

      const backdropCanvas = document.createElement('canvas')
      const backdropContext = backdropCanvas.getContext('2d', { alpha: false })
      if (!backdropContext) {
        device.destroy()
        return
      }

      const format = gpu.getPreferredCanvasFormat()
      const scene = new CoreScene()
      const container = new CoreContainer({ ...coreGlassOptions, zIndex: 1 })
      const items: GlassItem[] = [
        {
          glass: new CoreGlass({
            cornerRadius: defaultGlassRadius,
            cornerSmoothing: 0.6,
          }),
          gradient: 'middleBlack',
        },
        {
          glass: new CoreGlass({
            cornerRadius: defaultGlassRadius,
            cornerSmoothing: 0.6,
          }),
          gradient: 'linearBlack',
        },
      ]
      const uiContainer = new CoreContainer({
        ...handleGlassOptions,
        opacity: 0,
      })
      const resizeHandles = createResizeHandles()
      const radiusHandle = new CoreGlass({
        width: radiusHandleSize,
        height: radiusHandleSize,
        cornerRadius: radiusHandleSize / 2,
        cornerSmoothing: 0.6,
      })

      items.forEach((item) => container.add(item.glass))
      resizeHandleOrder.forEach((handle) => {
        uiContainer.add(resizeHandles[handle])
      })
      uiContainer.add(radiusHandle)
      scene.add(container)
      scene.add(uiContainer)

      handles = {
        backdropCanvas,
        backdropContext,
        backdropTexture: null,
        context,
        core: new WebGpuGlassCore({ device, format }),
        device,
        format,
        items,
        radiusHandle,
        resizeHandles,
        scene,
        size: {
          dpr: 1,
          height: 0,
          pixelHeight: 0,
          pixelWidth: 0,
          width: 0,
        },
        uiContainer,
      }

      ;(window as QuickGlassWindow).__quickGlassStatus = 'webgpu:liquid-dom-core'
      resizeRenderer(canvas, handles)
      requestRender()
    }

    const resizeObserver = new ResizeObserver(requestRender)
    resizeObserver.observe(canvas)

    const handleVisibilityChange = () => {
      if (!document.hidden) requestRender()
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!handles || event.button !== 0) return

      const point = getCanvasPoint(canvas, event)
      const hit = hitTest(point, interaction, handles.size)

      if (hit.type === 'none') {
        interaction.selectedIndex = null
        interaction.activeIndex = null
        interaction.mode = 'idle'
        interaction.pointerId = null
        interaction.resizeHandle = null
        updateCanvasCursor(canvas, hit)
        requestRender()
        return
      }

      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
      interaction.selectedIndex =
        hit.type === 'body'
          ? hit.index
          : (interaction.selectedIndex ?? interaction.activeIndex ?? 0)
      interaction.activeIndex = interaction.selectedIndex
      interaction.pointerId = event.pointerId
      interaction.startPoint = point
      interaction.startRect = cloneRect(
        getSelectedRect(interaction, handles.size),
      )

      if (hit.type === 'radius') {
        interaction.mode = 'radius'
        interaction.resizeHandle = null
      } else if (hit.type === 'resize') {
        interaction.mode = 'resize'
        interaction.resizeHandle = hit.handle
      } else {
        interaction.mode = 'drag'
        interaction.resizeHandle = null
      }

      updateCanvasCursor(canvas, hit)
      requestRender()
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!handles) return

      const point = getCanvasPoint(canvas, event)

      if (interaction.pointerId === event.pointerId && interaction.mode !== 'idle') {
        event.preventDefault()
        updateInteractionDrag(interaction, point, handles.size)
        requestRender()
        return
      }

      updateCanvasCursor(canvas, hitTest(point, interaction, handles.size))
    }

    const finishPointerInteraction = (event: PointerEvent) => {
      if (interaction.pointerId !== event.pointerId) return

      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }

      interaction.mode = 'idle'
      interaction.pointerId = null
      interaction.resizeHandle = null

      if (handles) {
        updateCanvasCursor(
          canvas,
          hitTest(getCanvasPoint(canvas, event), interaction, handles.size),
        )
      }

      requestRender()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', finishPointerInteraction)
    canvas.addEventListener('pointercancel', finishPointerInteraction)
    void initialize()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', finishPointerInteraction)
      canvas.removeEventListener('pointercancel', finishPointerInteraction)
      handles?.backdropTexture?.destroy()
      handles?.core.destroy()
      handles?.device.destroy()
      handles = null
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-label="Liquid glass rounded rectangle over wallpaper"
      className="liquid-glass-stage"
    />
  )
}

function resizeRenderer(canvas: HTMLCanvasElement, handles: RendererHandles) {
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))

  if (
    handles.size.width === width &&
    handles.size.height === height &&
    handles.size.dpr === dpr &&
    handles.size.pixelWidth === pixelWidth &&
    handles.size.pixelHeight === pixelHeight
  ) {
    return
  }

  handles.size = {
    dpr,
    height,
    pixelHeight,
    pixelWidth,
    width,
  }

  canvas.width = pixelWidth
  canvas.height = pixelHeight
  handles.backdropCanvas.width = pixelWidth
  handles.backdropCanvas.height = pixelHeight
  handles.backdropContext.setTransform(dpr, 0, 0, dpr, 0, 0)

  handles.context.configure({
    device: handles.device,
    format: handles.format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })

  handles.backdropTexture?.destroy()
  handles.backdropTexture = handles.device.createTexture({
    size: { width: pixelWidth, height: pixelHeight },
    format: handles.format,
    usage:
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING,
  })
}

function syncGlassRects(handles: RendererHandles, interaction: InteractionState) {
  const rects = getInteractionRects(interaction, handles.size)

  handles.items.forEach((item, index) => {
    const rect = rects[index]
    item.glass.x = rect.x
    item.glass.y = rect.y
    item.glass.width = rect.width
    item.glass.height = rect.height
    item.glass.cornerRadius = rect.radius
  })

  const selectedRect =
    interaction.selectedIndex === null ? null : rects[interaction.selectedIndex]

  handles.uiContainer.opacity = selectedRect ? 1 : 0

  if (selectedRect) {
    syncResizeHandles(handles.resizeHandles, selectedRect)
    syncRadiusHandle(handles.radiusHandle, selectedRect)
  }

  ;(window as QuickGlassWindow).__quickGlassRect = selectedRect
    ? cloneRect(selectedRect)
    : undefined
  ;(window as QuickGlassWindow).__quickGlassRects = rects.map(cloneRect)
}

function computeInitialGlassRects(size: CanvasSize): GlassRect[] {
  const availableWidth = Math.max(1, size.width - canvasPadding * 2)
  const availableHeight = Math.max(1, size.height - canvasPadding * 2)
  const width =
    defaultGlassWidth * 2 + defaultGlassGap <= availableWidth
      ? defaultGlassWidth
      : Math.max(80, (availableWidth - defaultGlassGap) / 2)
  const height = Math.min(defaultGlassHeight, availableHeight)
  const totalWidth = width * 2 + defaultGlassGap
  const x = (size.width - totalWidth) / 2
  const y = (size.height - height) / 2
  const radius = clamp(defaultGlassRadius, 8, Math.min(width, height) / 2 - 2)

  return [
    constrainRect({ height, radius, width, x, y }, size),
    constrainRect(
      {
        height,
        radius,
        width,
        x: x + width + defaultGlassGap,
        y,
      },
      size,
    ),
  ]
}

function createResizeHandles() {
  return Object.fromEntries(
    resizeHandleOrder.map((handle) => [
      handle,
      new CoreGlass({
        width: resizeHandleSize,
        height: resizeHandleSize,
        cornerRadius: resizeHandleSize / 2,
        cornerSmoothing: 0.6,
      }),
    ]),
  ) as Record<ResizeHandle, CoreGlass>
}

function syncResizeHandles(
  handles: Record<ResizeHandle, CoreGlass>,
  rect: GlassRect,
) {
  const rects = getResizeHandleRects(rect)

  resizeHandleOrder.forEach((handle) => {
    const handleRect = rects[handle]
    const glass = handles[handle]
    glass.x = handleRect.x
    glass.y = handleRect.y
    glass.width = handleRect.width
    glass.height = handleRect.height
    glass.cornerRadius = Math.min(handleRect.width, handleRect.height) / 2
  })
}

function syncRadiusHandle(handle: CoreGlass, rect: GlassRect) {
  const handleRect = getRadiusHandleRect(rect)

  handle.x = handleRect.x
  handle.y = handleRect.y
  handle.width = handleRect.width
  handle.height = handleRect.height
  handle.cornerRadius = handleRect.width / 2
}

function getResizeHandleRects(rect: GlassRect) {
  const corner = resizeHandleSize
  const sideLong = 28
  const sideShort = 10
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height

  return {
    n: {
      height: sideShort,
      width: sideLong,
      x: centerX - sideLong / 2,
      y: rect.y - sideShort / 2,
    },
    ne: {
      height: corner,
      width: corner,
      x: right - corner / 2,
      y: rect.y - corner / 2,
    },
    e: {
      height: sideLong,
      width: sideShort,
      x: right - sideShort / 2,
      y: centerY - sideLong / 2,
    },
    se: {
      height: corner,
      width: corner,
      x: right - corner / 2,
      y: bottom - corner / 2,
    },
    s: {
      height: sideShort,
      width: sideLong,
      x: centerX - sideLong / 2,
      y: bottom - sideShort / 2,
    },
    sw: {
      height: corner,
      width: corner,
      x: rect.x - corner / 2,
      y: bottom - corner / 2,
    },
    w: {
      height: sideLong,
      width: sideShort,
      x: rect.x - sideShort / 2,
      y: centerY - sideLong / 2,
    },
    nw: {
      height: corner,
      width: corner,
      x: rect.x - corner / 2,
      y: rect.y - corner / 2,
    },
  } satisfies Record<ResizeHandle, Rect>
}

function getRadiusHandleRect(rect: GlassRect): Rect {
  const center = getRadiusHandleCenter(rect)

  return {
    height: radiusHandleSize,
    width: radiusHandleSize,
    x: center.x - radiusHandleSize / 2,
    y: center.y - radiusHandleSize / 2,
  }
}

function getRadiusHandleCenter(rect: GlassRect): Point {
  return {
    x: rect.x + rect.radius,
    y: rect.y + rect.radius,
  }
}

function getInteractionRects(
  interaction: InteractionState,
  size: CanvasSize,
) {
  if (!interaction.rects) {
    interaction.rects = computeInitialGlassRects(size)
  }

  interaction.rects = interaction.rects.map((rect) => constrainRect(rect, size))

  return interaction.rects
}

function getSelectedRect(interaction: InteractionState, size: CanvasSize) {
  const rects = getInteractionRects(interaction, size)
  const index = interaction.selectedIndex ?? interaction.activeIndex ?? 0

  return rects[index]
}

function updateInteractionDrag(
  interaction: InteractionState,
  point: Point,
  size: CanvasSize,
) {
  const dx = point.x - interaction.startPoint.x
  const dy = point.y - interaction.startPoint.y
  const index = interaction.activeIndex

  if (index === null) return

  if (interaction.mode === 'drag') {
    setInteractionRect(
      interaction,
      index,
      {
        ...interaction.startRect,
        x: interaction.startRect.x + dx,
        y: interaction.startRect.y + dy,
      },
      size,
    )
    return
  }

  if (interaction.mode === 'radius') {
    const radius = Math.max(
      point.x - interaction.startRect.x,
      point.y - interaction.startRect.y,
    )
    setInteractionRect(
      interaction,
      index,
      {
        ...interaction.startRect,
        radius,
      },
      size,
    )
    return
  }

  if (interaction.mode === 'resize' && interaction.resizeHandle) {
    setInteractionRect(
      interaction,
      index,
      resizeRect(
        interaction.startRect,
        interaction.resizeHandle,
        dx,
        dy,
        size,
      ),
      size,
    )
  }
}

function setInteractionRect(
  interaction: InteractionState,
  index: number,
  rect: GlassRect,
  size: CanvasSize,
) {
  const rects = getInteractionRects(interaction, size)
  rects[index] = constrainRect(rect, size)
  interaction.rects = rects
}

function resizeRect(
  startRect: GlassRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  size: CanvasSize,
) {
  const minWidth = Math.min(180, Math.max(80, size.width - canvasPadding * 2))
  const minHeight = Math.min(120, Math.max(70, size.height - canvasPadding * 2))
  let left = startRect.x
  let top = startRect.y
  let right = startRect.x + startRect.width
  let bottom = startRect.y + startRect.height

  if (handle.includes('w')) {
    left = clamp(
      startRect.x + dx,
      canvasPadding,
      right - minWidth,
    )
  }

  if (handle.includes('e')) {
    right = clamp(
      startRect.x + startRect.width + dx,
      left + minWidth,
      size.width - canvasPadding,
    )
  }

  if (handle.includes('n')) {
    top = clamp(
      startRect.y + dy,
      canvasPadding,
      bottom - minHeight,
    )
  }

  if (handle.includes('s')) {
    bottom = clamp(
      startRect.y + startRect.height + dy,
      top + minHeight,
      size.height - canvasPadding,
    )
  }

  return constrainRect(
    {
      height: bottom - top,
      radius: startRect.radius,
      width: right - left,
      x: left,
      y: top,
    },
    size,
  )
}

function constrainRect(rect: GlassRect, size: CanvasSize) {
  const maxWidth = Math.max(1, size.width - canvasPadding * 2)
  const maxHeight = Math.max(1, size.height - canvasPadding * 2)
  const minWidth = Math.min(180, Math.max(80, maxWidth))
  const minHeight = Math.min(120, Math.max(70, maxHeight))
  const width = clamp(rect.width, minWidth, maxWidth)
  const height = clamp(rect.height, minHeight, maxHeight)
  const x = clamp(rect.x, canvasPadding, size.width - canvasPadding - width)
  const y = clamp(rect.y, canvasPadding, size.height - canvasPadding - height)
  const maxRadius = Math.max(8, Math.min(width, height) / 2 - 2)

  return {
    height,
    radius: clamp(rect.radius, 8, maxRadius),
    width,
    x,
    y,
  }
}

function hitTest(
  point: Point,
  interaction: InteractionState,
  size: CanvasSize,
): HitTarget {
  const rects = getInteractionRects(interaction, size)
  const selectedRect =
    interaction.selectedIndex === null ? null : rects[interaction.selectedIndex]

  if (selectedRect) {
    if (
      pointInCircle(
        point,
        getRadiusHandleCenter(selectedRect),
        radiusHandleSize / 2 + 7,
      )
    ) {
      return { type: 'radius' }
    }

    const resizeRects = getResizeHandleRects(selectedRect)
    const hitHandle = resizeHandleOrder.find((handle) =>
      pointInRect(point, inflateRect(resizeRects[handle], 8)),
    )

    if (hitHandle) {
      return { type: 'resize', handle: hitHandle }
    }
  }

  for (let index = rects.length - 1; index >= 0; index -= 1) {
    if (pointInRoundedRect(point, rects[index])) {
      return { index, type: 'body' }
    }
  }

  return { type: 'none' }
}

function getCanvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect()

  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
}

function updateCanvasCursor(canvas: HTMLCanvasElement, hit: HitTarget) {
  canvas.style.cursor = getCursorForHit(hit)
}

function getCursorForHit(hit: HitTarget) {
  if (hit.type === 'body') return 'move'
  if (hit.type === 'radius') return 'nesw-resize'
  if (hit.type !== 'resize') return 'default'

  switch (hit.handle) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
  }
}

function cloneRect(rect: GlassRect) {
  return { ...rect }
}

type Rect = {
  height: number
  width: number
  x: number
  y: number
}

function inflateRect(rect: Rect, amount: number) {
  return {
    height: rect.height + amount * 2,
    width: rect.width + amount * 2,
    x: rect.x - amount,
    y: rect.y - amount,
  }
}

function pointInRect(point: Point, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

function pointInCircle(point: Point, center: Point, radius: number) {
  return Math.hypot(point.x - center.x, point.y - center.y) <= radius
}

function pointInRoundedRect(point: Point, rect: GlassRect) {
  return smoothRoundRectDistance(point, rect) <= 0
}

function paintBackdrop(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  imageReady: boolean,
  width: number,
  height: number,
) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#172554'
  ctx.fillRect(0, 0, width, height)

  if (!imageReady) return

  ctx.save()
  ctx.filter = 'brightness(0.78) saturate(1.08)'
  drawCoverImage(ctx, image, width, height)
  ctx.restore()
}

function paintRectBackgroundLayers(
  ctx: CanvasRenderingContext2D,
  handles: RendererHandles,
  interaction: InteractionState,
) {
  const rects = getInteractionRects(interaction, handles.size)

  handles.items.forEach((item, index) => {
    const rect = rects[index]
    const gradient = ctx.createLinearGradient(
      rect.x,
      rect.y,
      rect.x,
      rect.y + rect.height,
    )

    if (item.gradient === 'middleBlack') {
      gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
      gradient.addColorStop(0.34, 'rgba(0, 0, 0, 1)')
      gradient.addColorStop(0.48, 'rgba(0, 0, 0, 0.82)')
      gradient.addColorStop(0.6, 'rgba(0, 0, 0, 0.32)')
      gradient.addColorStop(0.76, 'rgba(0, 0, 0, 0)')
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
    } else {
      gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
    }

    ctx.save()
    smoothRoundRectPath(ctx, rect, 1)
    ctx.clip()
    ctx.fillStyle = gradient
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    ctx.restore()
  })
}

function syncBackdropTexture(handles: RendererHandles) {
  if (!handles.backdropTexture) return

  handles.device.queue.copyExternalImageToTexture(
    { source: handles.backdropCanvas },
    { texture: handles.backdropTexture },
    {
      width: handles.size.pixelWidth,
      height: handles.size.pixelHeight,
    },
  )
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
  const imageRatio = image.naturalWidth / image.naturalHeight
  const canvasRatio = width / height
  const drawWidth = imageRatio > canvasRatio ? height * imageRatio : width
  const drawHeight = imageRatio > canvasRatio ? height : width / imageRatio
  const x = (width - drawWidth) / 2
  const y = (height - drawHeight) / 2

  ctx.drawImage(image, x, y, drawWidth, drawHeight)
}

function smoothRoundRectPath(
  ctx: CanvasRenderingContext2D,
  rect: GlassRect,
  outset = 0,
) {
  const expanded = {
    height: rect.height + outset * 2,
    radius: rect.radius + outset,
    width: rect.width + outset * 2,
    x: rect.x - outset,
    y: rect.y - outset,
  }
  const stepsPerCorner = 24
  const radius = Math.min(expanded.radius, expanded.width / 2, expanded.height / 2)
  const exponent = resolveSmoothCornerExponent(expanded)
  const right = expanded.x + expanded.width
  const bottom = expanded.y + expanded.height
  const corners = [
    {
      cx: right - radius,
      cy: expanded.y + radius,
      end: 0,
      start: -Math.PI / 2,
    },
    {
      cx: right - radius,
      cy: bottom - radius,
      end: Math.PI / 2,
      start: 0,
    },
    {
      cx: expanded.x + radius,
      cy: bottom - radius,
      end: Math.PI,
      start: Math.PI / 2,
    },
    {
      cx: expanded.x + radius,
      cy: expanded.y + radius,
      end: Math.PI * 1.5,
      start: Math.PI,
    },
  ]

  ctx.beginPath()

  corners.forEach((corner, cornerIndex) => {
    for (let step = 0; step <= stepsPerCorner; step += 1) {
      const t = step / stepsPerCorner
      const angle = corner.start + (corner.end - corner.start) * t
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const px =
        corner.cx +
          radius *
          Math.sign(cos) *
          Math.abs(cos) ** (2 / exponent)
      const py =
        corner.cy +
          radius *
          Math.sign(sin) *
          Math.abs(sin) ** (2 / exponent)

      if (cornerIndex === 0 && step === 0) {
        ctx.moveTo(px, py)
      } else {
        ctx.lineTo(px, py)
      }
    }
  })

  ctx.closePath()
}

function smoothRoundRectDistance(point: Point, rect: GlassRect) {
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2
  const radius = Math.min(Math.max(rect.radius, 0), halfWidth, halfHeight)
  const exponent = resolveSmoothCornerExponent(rect)
  const localX = point.x - rect.x - halfWidth
  const localY = point.y - rect.y - halfHeight
  const qx = Math.abs(localX) - halfWidth + radius
  const qy = Math.abs(localY) - halfHeight + radius
  const cornerDistance =
    Math.max(qx, 0) === 0 && Math.max(qy, 0) === 0
      ? 0
      : superellipseLength(
          Math.max(qx, 0),
          Math.max(qy, 0),
          exponent,
        )

  return cornerDistance + Math.min(Math.max(qx, qy), 0) - radius
}

function superellipseLength(x: number, y: number, exponent: number) {
  return (Math.abs(x) ** exponent + Math.abs(y) ** exponent) ** (1 / exponent)
}

function resolveSmoothCornerExponent(rect: GlassRect) {
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2
  const cornerLimit = Math.min(halfWidth, halfHeight)
  const radius = Math.max(rect.radius, 0)
  const maxSmoothingThatFits =
    radius > sdfEpsilon
      ? Math.max(cornerLimit / Math.max(radius, sdfEpsilon) - 1, 0)
      : 0
  const effectiveSmoothing = Math.min(
    Math.max(cornerSmoothing, 0),
    1,
    maxSmoothingThatFits,
  )

  return circularCornerExponent + effectiveSmoothing * cornerSmoothingExponentDelta
}

function paintUnsupportedFallback(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  imageReady: boolean,
) {
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return

  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)

  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  paintBackdrop(ctx, image, imageReady, width, height)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export default App
