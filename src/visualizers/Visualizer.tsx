import { useRef, useEffect } from 'react'

import bg from './bg.png'
import sil1 from './silhouettes/1.png'
import sil2 from './silhouettes/2.png'
import sil3 from './silhouettes/3.png'
import sil4 from './silhouettes/4.png'
import sil5 from './silhouettes/5.png'
import sil6 from './silhouettes/6.png'
import sil7 from './silhouettes/7.png'
import sil8 from './silhouettes/8.png'
import sil9 from './silhouettes/9.png'
import sil10 from './silhouettes/10.png'
import sil11 from './silhouettes/11.png'
import sil12 from './silhouettes/12.png'

/**
 * Visualizer — "The City Never Sleeps"
 *
 * A night-time building facade driven by microphone input.
 * Speaking lights up windows one by one; silence lets them fade.
 *
 * Audio dimensions used:
 *   - Energy (RMS)      → how many windows light up, and how fast
 *   - Frequency (bass/treble) → which floor lights up first
 *   - Transients (treble spike) → building shake + caption override
 *
 * All tuneable parameters are top-level named constants.
 * Only Visualizer.tsx is modified; useAudio.ts and App.tsx are untouched.
 */

/** Fixed mapping: window index i uses SILHOUETTES[i] (no random swaps). */
const SILHOUETTES = [sil1, sil2, sil3, sil4, sil5, sil6, sil7, sil8, sil9, sil10, sil11, sil12]

/** Window quad size in design pixels (matches WINDOWS layout). */
const WIN_W = 85
const WIN_H = 79

/** 12 window positions on the 640×480 design canvas (aligned with bg). */
const WINDOWS = [
  { id: 0, x: 69, y: 142 },
  { id: 1, x: 209, y: 142 },
  { id: 2, x: 349, y: 142 },
  { id: 3, x: 489, y: 142 },
  { id: 4, x: 69, y: 251 },
  { id: 5, x: 209, y: 251 },
  { id: 6, x: 349, y: 251 },
  { id: 7, x: 489, y: 251 },
  { id: 8, x: 69, y: 360 },
  { id: 9, x: 209, y: 360 },
  { id: 10, x: 349, y: 360 },
  { id: 11, x: 489, y: 360 },
] as const

/** Grid columns for row derivation (must match WINDOWS layout). */
const COLS = 4

/** Row index 0 = top, 1 = middle, 2 = bottom; ids derived from WINDOWS order. */
const getRowIds = (row: number) =>
  WINDOWS.filter((_, i) => Math.floor(i / COLS) === row).map(w => w.id)

/** Design canvas size used to scale drawing to the canvas width/height props. */
const DESIGN_CANVAS_W = 640
const DESIGN_CANVAS_H = 480

const WINDOW_COUNT = 12

/** RMS above this counts as “speaking”. */
const RMS_SPEECH_THRESHOLD = 0.03

/** While speaking, enqueue one more light every this many ms. */
const SPEAK_INTERVAL_MS = 2000

/** FFT bin ranges for bass / treble averages (byte frequency data, 0–255). */
const FREQ_BASS_START = 0
const FREQ_BASS_END = 15
const FREQ_TREBLE_START = 150
const FREQ_TREBLE_END = 400

/** Layer-priority threshold on normalized band energy. */
const FREQ_LAYER_THRESHOLD = 0.4

/** Shake: treble must exceed this and jump vs previous frame. */
const SHAKE_TREBLE_MIN = 0.3
const SHAKE_TREBLE_JUMP = 0.1
/** Shake motion duration (s) and max offset (px). */
const SHAKE_DURATION_SEC = 0.4
const SHAKE_MAX_OFFSET_PX = 6

/** Forced caption duration after shake (s), then crossfade back to lamp-based copy. */
const SHAKE_CAPTION_DURATION_SEC = 5
/** Caption crossfade rate (alpha units per second). */
const TEXT_ALPHA_FADE_RATE = 2

/** Caption forced while shake override is active. */
const SHAKE_LINE = "Hey... it's late."

/**
 * Louder RMS → more lights per burst and shorter spacing between dequeue (seconds).
 */
const getOpenConfig = (rms: number) => {
  if (rms > 0.15) return { count: 2, interval: 0.2 }
  return { count: 1, interval: 0.4 }
}

const WINDOW_LIFE = { min: 6, max: 10 } as const

const OPEN_ANIM = {
  fadeSpeed: 2,
  flash: { t1: 0.1, t2: 0.2 },
} as const

const CLOSE_ANIM = {
  fadeSpeed: 1.5,
  flash1: { t1: 0.15, t2: 0.3 },
  flash2: {
    steps: [0.15, 0.3, 0.45, 0.6] as const,
    levels: [0.3, 0.8, 0.2, 0.7] as const,
  },
} as const

interface WinState {
  brightness: number
  phase: 'off' | 'opening' | 'on' | 'closing'
  lifeTimer: number
  lifeDuration: number
  closeStyle: 'instant' | 'fade' | 'flash1' | 'flash2'
  openStyle: 'instant' | 'fade' | 'flash'
  animTimer: number
}

function createOffState(): WinState {
  return {
    brightness: 0,
    phase: 'off',
    lifeTimer: 0,
    lifeDuration: WINDOW_LIFE.min,
    closeStyle: 'instant',
    openStyle: 'instant',
    animTimer: 0,
  }
}

function randomOpenStyle(): WinState['openStyle'] {
  const r = Math.random()
  if (r < 1 / 3) return 'instant'
  if (r < 2 / 3) return 'fade'
  return 'flash'
}

function randomCloseStyle(): WinState['closeStyle'] {
  const r = Math.random()
  if (r < 0.25) return 'instant'
  if (r < 0.5) return 'fade'
  if (r < 0.75) return 'flash1'
  return 'flash2'
}

const getCaptionForLitCount = (lit: number): string => {
  if (lit === 0) return 'The night is quiet.'
  if (lit <= 4) return 'Not everyone is awake.'
  if (lit <= 8) return 'Some are trying to rest.'
  return 'The city never sleeps...'
}

interface VisualizerProps {
  frequencyData: React.RefObject<Uint8Array>
  timeDomainData: React.RefObject<Uint8Array>
  isActive: boolean
  width: number
  height: number
}

export function Visualizer({
  frequencyData,
  timeDomainData,
  isActive,
  width,
  height,
}: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const bgImgRef = useRef<HTMLImageElement | null>(null)
  const silImagesRef = useRef<HTMLImageElement[]>([])
  const readyRef = useRef(false)

  const winStates = useRef<WinState[]>(Array.from({ length: WINDOW_COUNT }, createOffState))

  const queueRef = useRef<number[]>([])
  const nextEmitRef = useRef(0)

  const speakRef = useRef({ active: false, lastBurstAt: 0 })

  /** Building shake (active, timer) + caption override timer (captionTimer; -1 = lamp-based). */
  const shakeRef = useRef({ active: false, timer: 0, captionTimer: -1 })
  const prevTrebleRef = useRef(0)

  /**
   * Bottom captions: fields `current` / `next` (not React ref.current) for crossfade.
   */
  const textRef = useRef({
    current: 'the night is quiet',
    next: '',
    currentAlpha: 1,
    nextAlpha: 0,
  })

  useEffect(() => {
    let cancelled = false
    let loaded = 0
    const total = 1 + WINDOW_COUNT

    const onOne = () => {
      loaded++
      if (loaded === total && !cancelled) {
        readyRef.current = true
      }
    }

    const bgEl = new Image()
    bgImgRef.current = bgEl
    bgEl.onload = onOne
    bgEl.onerror = onOne
    bgEl.src = bg

    const sils: HTMLImageElement[] = []
    silImagesRef.current = sils
    for (let i = 0; i < WINDOW_COUNT; i++) {
      const img = new Image()
      sils.push(img)
      img.onload = onOne
      img.onerror = onOne
      img.src = SILHOUETTES[i]
    }

    return () => {
      cancelled = true
      readyRef.current = false
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (!isActive) {
      winStates.current = Array.from({ length: WINDOW_COUNT }, createOffState)
      queueRef.current = []
      nextEmitRef.current = 0
      speakRef.current = { active: false, lastBurstAt: 0 }
      shakeRef.current = { active: false, timer: 0, captionTimer: -1 }
      prevTrebleRef.current = 0
      textRef.current = {
        current: 'the night is quiet',
        next: '',
        currentAlpha: 1,
        nextAlpha: 0,
      }

      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#a3a3a3'
      ctx.font = '12px monospace'
      ctx.textAlign = 'center'
      ctx.fillText('> awaiting microphone input...', width / 2, height / 2)
      ctx.textAlign = 'left'
      return
    }

    let frameId = 0
    let prevNow = performance.now()

    const scaleX = width / DESIGN_CANVAS_W
    const scaleY = height / DESIGN_CANVAS_H

    const getRms = (timeData: Uint8Array): number => {
      if (timeData.length === 0) return 0
      let sum = 0
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128
        sum += v * v
      }
      return Math.sqrt(sum / timeData.length)
    }

    const freqBand = (freq: Uint8Array, start: number, end: number): number => {
      if (freq.length === 0) return 0
      const s = Math.max(0, Math.min(start, freq.length - 1))
      const e = Math.max(s, Math.min(end, freq.length - 1))
      let sum = 0
      for (let i = s; i <= e; i++) sum += freq[i]
      return sum / ((e - s + 1) * 255)
    }

    const pickWindow = (freq: Uint8Array, winSt: WinState[]): number | null => {
      const bass = freqBand(freq, FREQ_BASS_START, FREQ_BASS_END)
      const treble = freqBand(freq, FREQ_TREBLE_START, FREQ_TREBLE_END)

      const darkIn = (ids: readonly number[]) => ids.filter(id => winSt[id].phase === 'off')

      let preferred: number[] = []
      if (bass > FREQ_LAYER_THRESHOLD && bass > treble) {
        preferred = darkIn(getRowIds(2))
      } else if (treble > FREQ_LAYER_THRESHOLD && treble > bass) {
        preferred = darkIn(getRowIds(0))
      } else {
        preferred = darkIn(getRowIds(1))
      }

      if (preferred.length > 0) {
        return preferred[Math.floor(Math.random() * preferred.length)]
      }

      const fallback = winSt.map((s, i) => (s.phase === 'off' ? i : -1)).filter(i => i >= 0)
      if (fallback.length === 0) return null
      return fallback[Math.floor(Math.random() * fallback.length)]
    }

    const randInt = (min: number, max: number) =>
      min + Math.floor(Math.random() * (max - min + 1))

    const openWindow = (s: WinState) => {
      s.openStyle = randomOpenStyle()
      s.closeStyle = randomCloseStyle()
      s.lifeDuration = randInt(WINDOW_LIFE.min, WINDOW_LIFE.max)
      s.lifeTimer = 0
      s.animTimer = 0
      s.phase = 'opening'
      if (s.openStyle === 'fade') {
        s.brightness = 0
      }
    }

    const closeWindow = (s: WinState) => Object.assign(s, createOffState())

    const updateAudio = (
      rms: number,
      speaking: boolean,
      freqData: Uint8Array,
      now: number,
      states: WinState[]
    ) => {
      const trebleNow = freqBand(freqData, FREQ_TREBLE_START, FREQ_TREBLE_END)
      if (
        trebleNow > SHAKE_TREBLE_MIN &&
        trebleNow - prevTrebleRef.current > SHAKE_TREBLE_JUMP
      ) {
        const sh = shakeRef.current
        sh.active = true
        sh.timer = 0
        sh.captionTimer = 0
        const tr0 = textRef.current
        tr0.current = SHAKE_LINE
        tr0.next = ''
        tr0.currentAlpha = 1
        tr0.nextAlpha = 0
      }
      prevTrebleRef.current = trebleNow

      const sp = speakRef.current
      if (speaking) {
        if (!sp.active) {
          const { count } = getOpenConfig(rms)
          queueRef.current = Array.from({ length: count }, () => 1)
          nextEmitRef.current = now
          sp.lastBurstAt = now
        } else if (now - sp.lastBurstAt >= SPEAK_INTERVAL_MS) {
          const hasDark = states.some(s => s.phase === 'off')
          if (hasDark) {
            queueRef.current.push(1)
          }
          sp.lastBurstAt = now
        }
      }

      sp.active = speaking
    }

    let frameTime = 0

    const updateWindows = (
      dtSec: number,
      rms: number,
      freqData: Uint8Array,
      states: WinState[]
    ) => {
      const now = frameTime
      const q = queueRef.current
      if (q.length > 0 && now >= nextEmitRef.current) {
        q.shift()
        const idx = pickWindow(freqData, states)
        if (idx !== null) {
          const st = states[idx]
          if (st.phase === 'off') {
            openWindow(st)
          }
        }
        nextEmitRef.current = now + getOpenConfig(rms).interval * 1000
      }

      for (let i = 0; i < WINDOW_COUNT; i++) {
        const s = states[i]
        switch (s.phase) {
          case 'off':
            break
          case 'opening': {
            if (s.openStyle === 'instant') {
              s.brightness = 1
              s.phase = 'on'
              s.lifeTimer = 0
            } else if (s.openStyle === 'fade') {
              s.brightness += dtSec * OPEN_ANIM.fadeSpeed
              if (s.brightness >= 1) {
                s.brightness = 1
                s.phase = 'on'
                s.lifeTimer = 0
              }
            } else {
              s.animTimer += dtSec
              const t = s.animTimer
              if (t < OPEN_ANIM.flash.t1) {
                s.brightness = 1
              } else if (t < OPEN_ANIM.flash.t2) {
                s.brightness = 0.3
              } else {
                s.brightness = 1
                s.phase = 'on'
                s.lifeTimer = 0
                s.animTimer = 0
              }
            }
            break
          }
          case 'on': {
            s.lifeTimer += dtSec
            s.brightness = 1
            if (s.lifeTimer >= s.lifeDuration) {
              s.phase = 'closing'
              s.animTimer = 0
            }
            break
          }
          case 'closing': {
            if (s.closeStyle === 'instant') {
              closeWindow(s)
            } else if (s.closeStyle === 'fade') {
              s.brightness -= dtSec * CLOSE_ANIM.fadeSpeed
              if (s.brightness <= 0) {
                closeWindow(s)
              }
            } else if (s.closeStyle === 'flash1') {
              s.animTimer += dtSec
              const t = s.animTimer
              if (t < CLOSE_ANIM.flash1.t1) {
                s.brightness = 0.3
              } else if (t < CLOSE_ANIM.flash1.t2) {
                s.brightness = 0.9
              } else {
                closeWindow(s)
              }
            } else {
              s.animTimer += dtSec
              const t = s.animTimer
              if (t >= CLOSE_ANIM.flash2.steps[CLOSE_ANIM.flash2.steps.length - 1]) {
                closeWindow(s)
              } else {
                for (let j = 0; j < CLOSE_ANIM.flash2.steps.length; j++) {
                  if (t < CLOSE_ANIM.flash2.steps[j]) {
                    s.brightness = CLOSE_ANIM.flash2.levels[j]
                    break
                  }
                }
              }
            }
            break
          }
          default:
            break
        }
      }
    }

    const updateCaption = (dtSec: number, litCount: number) => {
      const targetCaption = getCaptionForLitCount(litCount)
      const tr = textRef.current

      if (shakeRef.current.captionTimer >= 0) {
        shakeRef.current.captionTimer += dtSec
        if (shakeRef.current.captionTimer >= SHAKE_CAPTION_DURATION_SEC) {
          shakeRef.current.captionTimer = -1
          tr.current = SHAKE_LINE
          tr.currentAlpha = 1
          tr.next = targetCaption
          tr.nextAlpha = 0
        } else {
          tr.current = SHAKE_LINE
          tr.next = ''
          tr.currentAlpha = 1
          tr.nextAlpha = 0
        }
      } else {
        if (tr.next === '' && tr.current !== targetCaption) {
          tr.next = targetCaption
          tr.nextAlpha = 0
        } else if (tr.next !== '' && tr.next !== targetCaption) {
          tr.next = targetCaption
          tr.nextAlpha = 0
        }
        if (tr.next !== '') {
          tr.currentAlpha -= dtSec * TEXT_ALPHA_FADE_RATE
          tr.nextAlpha += dtSec * TEXT_ALPHA_FADE_RATE
          tr.currentAlpha = Math.max(0, tr.currentAlpha)
          tr.nextAlpha = Math.min(1, tr.nextAlpha)
          if (tr.currentAlpha <= 0 && tr.nextAlpha >= 1) {
            tr.current = tr.next
            tr.currentAlpha = 1
            tr.next = ''
            tr.nextAlpha = 0
          }
        }
      }
    }

    const drawCaption = () => {
      const t = textRef.current
      ctx.save()
      ctx.font = 'italic 15px Georgia, serif'
      ctx.fillStyle = '#e8d5a3'
      ctx.textAlign = 'center'
      ctx.globalAlpha = t.currentAlpha
      ctx.fillText(t.current, width / 2, height - 20)
      ctx.globalAlpha = t.nextAlpha
      ctx.fillText(t.next, width / 2, height - 20)
      ctx.restore()
    }

    const renderFrame = (states: WinState[]) => {
      const bgImg = bgImgRef.current
      const shake = shakeRef.current
      let shakeSx = 0
      let shakeSy = 0
      let useShakeDraw = false

      if (shake.active) {
        shake.timer += dtSec
        const intensity = (1 - shake.timer / SHAKE_DURATION_SEC) * SHAKE_MAX_OFFSET_PX
        shakeSx = (Math.random() - 0.5) * 2 * intensity
        shakeSy = (Math.random() - 0.5) * intensity
        useShakeDraw = true
        if (bgImg && bgImg.naturalWidth > 0) {
          ctx.drawImage(
            bgImg,
            shakeSx,
            shakeSy,
            width + Math.abs(shakeSx) * 2,
            height + Math.abs(shakeSy) * 2
          )
        } else {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, width, height)
        }
        if (shake.timer >= SHAKE_DURATION_SEC) {
          shake.active = false
          shake.timer = 0
        }
      } else if (bgImg && bgImg.naturalWidth > 0) {
        ctx.drawImage(bgImg, 0, 0, width, height)
      } else {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
      }

      const sils = silImagesRef.current
      for (const win of WINDOWS) {
        const br = states[win.id].brightness
        if (br <= 0) continue
        const img = sils[win.id]
        if (!img || img.naturalWidth === 0) continue

        const dx = win.x * scaleX
        const dy = win.y * scaleY
        const dw = WIN_W * scaleX
        const dh = WIN_H * scaleY

        ctx.globalAlpha = Math.min(1, br)
        if (useShakeDraw) {
          ctx.drawImage(img, dx + shakeSx, dy + shakeSy, dw, dh)
        } else {
          ctx.drawImage(img, dx, dy, dw, dh)
        }
        ctx.globalAlpha = 1
      }

      drawCaption()
    }

    let dtSec = 0

    const draw = () => {
      const timeData = timeDomainData.current
      const freqData = frequencyData.current
      const rms = getRms(timeData)
      const speaking = rms > RMS_SPEECH_THRESHOLD
      const now = performance.now()
      dtSec = Math.min(0.05, (now - prevNow) / 1000)
      prevNow = now

      const states = winStates.current

      frameTime = now
      updateAudio(rms, speaking, freqData, now, states)
      updateWindows(dtSec, rms, freqData, states)

      const litCount = states.reduce((n, s) => n + (s.brightness > 0 ? 1 : 0), 0)
      updateCaption(dtSec, litCount)

      if (!readyRef.current) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        drawCaption()
        frameId = requestAnimationFrame(draw)
        return
      }

      renderFrame(states)

      frameId = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [isActive, frequencyData, timeDomainData, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: 'block' }}
    />
  )
}
