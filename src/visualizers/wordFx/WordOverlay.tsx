import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'

/** px/frame² @~60fps，越大落得越快 */
const GRAVITY = 1.18
const DRIFT_MAX = 0.35
/** 落地时相对起始大小的缩放（营造由高往远的透视感） */
const FALL_SCALE_MIN = 0.66
const SPIN_MAX = 0.15
/** 涟漪中心相对字底边往上偏移（px）；越小越贴近字底、越靠画面下缘 */
const RIPPLE_UP_FROM_BOTTOM_PX = 4
const IMPACT_MS = 220
const DISSOLVE_MS = 650
const RIPPLE_COUNT = 3

/**
 * 落地高度：词「底边」停在舞台内的比例（0=顶，1=底）。
 * 想整体更靠下 → 两个数都略增大；更靠上则减小。
 */
const LANDING_BOTTOM_MIN_RATIO = 0.68
const LANDING_BOTTOM_MAX_RATIO = 0.94
/** 同一句话里上下起伏幅度（相对舞台高度） */
const LANDING_WOBBLE_RATIO = 0.06

/** 诗行：偏轻的衬线，无发光（与 index.html 字体一致） */
const FONT_POEM = "'Cormorant Garamond', Georgia, 'Times New Roman', serif"
/** 顶部提示：花体（两阶段同一字体） */
const FONT_SCRIPT = "'Great Vibes', cursive"

/** 梦幻青绿 #29EFB5 */
const POEM_GREEN = '#29EFB5'

const POEM_WORD_STYLE: CSSProperties = {
  fontFamily: FONT_POEM,
  fontWeight: 300,
  letterSpacing: '0.05em',
  color: POEM_GREEN,
}

type Phase = 'idle' | 'falling' | 'impact' | 'dissolve' | 'done'

type ImpactBox = { cx: number; rippleY: number; dissolveY: number; w: number; h: number }

/** 稳定 0..1，用于按词索引生成树冠上的落地高度 */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  return ((x >>> 0) % 10000) / 10000
}

/**
 * 词底边触达的 Y（舞台坐标，越大越靠下）。
 * 落在「树冠」一带：有上有下。
 */
function landingBottomYOnTree(globalIndex: number, stageHeight: number): number {
  const h = hash01(globalIndex)
  const h2 = hash01(globalIndex + 31)
  const minBottom = stageHeight * LANDING_BOTTOM_MIN_RATIO
  const maxBottom = stageHeight * LANDING_BOTTOM_MAX_RATIO
  const spread = minBottom + h * (maxBottom - minBottom)
  const wobble = (h2 - 0.5) * stageHeight * LANDING_WOBBLE_RATIO
  return Math.min(maxBottom, Math.max(minBottom, spread + wobble))
}

type FallingWordProps = {
  word: string
  globalIndex: number
  triggered: boolean
  boundsRef: RefObject<HTMLElement | null>
  stageHeight: number
  /** 诗行字号 */
  poemFontSizePx: number
}

function RippleBurst({
  centerX,
  centerY,
  onDone,
}: {
  centerX: number
  centerY: number
  onDone?: () => void
}) {
  const rings = useMemo(() => Array.from({ length: RIPPLE_COUNT }, (_, i) => i), [])

  useEffect(() => {
    if (!onDone) return
    const t = window.setTimeout(onDone, 950)
    return () => window.clearTimeout(t)
  }, [onDone])

  return (
    <div
      style={{
        position: 'absolute',
        left: centerX,
        top: centerY,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 40,
      }}
    >
      {rings.map(i => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 28,
            height: 28,
            marginLeft: -14,
            marginTop: -14,
            borderRadius: '50%',
            border: '1px solid rgba(200, 220, 255, 0.38)',
            boxShadow:
              '0 0 18px rgba(180, 210, 255, 0.22), 0 0 36px rgba(220, 190, 255, 0.14), inset 0 0 12px rgba(255, 255, 255, 0.06)',
            animation: `wordRipple 1.05s cubic-bezier(0.22, 0.61, 0.36, 1) forwards`,
            animationDelay: `${i * 0.14}s`,
            opacity: 0,
            mixBlendMode: 'screen',
          }}
        />
      ))}
      <style>{`
        @keyframes wordRipple {
          0% {
            transform: scale(0.12);
            opacity: 0.42;
            filter: blur(0px);
          }
          40% {
            opacity: 0.28;
            filter: blur(0.3px);
          }
          100% {
            transform: scale(3.1);
            opacity: 0;
            filter: blur(1.2px);
          }
        }
      `}</style>
    </div>
  )
}

function WordDissolveParticles({
  centerX,
  centerY,
  width,
  height,
  onDone,
}: {
  centerX: number
  centerY: number
  width: number
  height: number
  onDone: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = 160
    const h = 120
    canvas.width = w
    canvas.height = h
    const cx = w / 2
    const cy = h / 2

    type Particle = { x: number; y: number; vx: number; vy: number; life: number; size: number }
    const n = 28
    const parts: Particle[] = []
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2
      const sp = 1.8 + Math.random() * 3.2
      parts.push({
        x: cx + (Math.random() - 0.5) * width * 0.4,
        y: cy + (Math.random() - 0.5) * height * 0.35,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 1.2,
        life: 1,
        size: 1.2 + Math.random() * 2,
      })
    }

    const t0 = performance.now()
    let frame: number

    const tick = (now: number) => {
      const elapsed = now - t0
      const u = Math.min(1, elapsed / DISSOLVE_MS)
      ctx.clearRect(0, 0, w, h)

      for (const p of parts) {
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.06
        p.life = 1 - u

        ctx.fillStyle = `rgba(255, 245, 230, ${0.55 * p.life})`
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size)
      }

      if (u < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        onDoneRef.current()
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [centerX, centerY, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={160}
      height={120}
      style={{
        position: 'absolute',
        left: centerX,
        top: centerY,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 41,
      }}
    />
  )
}

function FallingWord({
  word,
  globalIndex,
  triggered,
  boundsRef,
  stageHeight,
  poemFontSizePx,
}: FallingWordProps) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const fallingRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [placeholder, setPlaceholder] = useState<{ w: number; h: number } | null>(null)
  const [impact, setImpact] = useState<ImpactBox | null>(null)
  const physicsRef = useRef({
    left: 0,
    top: 0,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
    rot: 0,
    vrot: 0,
  })
  const landingBottomRef = useRef(0)
  const fallStartTopRef = useRef(0)

  useLayoutEffect(() => {
    if (!triggered || phase !== 'idle') return
    const el = wrapRef.current
    const bounds = boundsRef.current?.getBoundingClientRect()
    if (!el || !bounds) return
    const r = el.getBoundingClientRect()
    const p0 = {
      left: r.left - bounds.left,
      top: r.top - bounds.top,
      w: r.width,
      h: r.height,
      vx: (Math.random() - 0.5) * 2 * DRIFT_MAX,
      vy: 0,
      rot: 0,
      vrot: (Math.random() - 0.5) * 2 * SPIN_MAX,
    }
    physicsRef.current = p0
    fallStartTopRef.current = p0.top
    const targetLand = landingBottomYOnTree(globalIndex, stageHeight)
    landingBottomRef.current = Math.max(targetLand, p0.top + p0.h + 2)
    setPlaceholder({ w: r.width, h: r.height })
    setPhase('falling')
  }, [triggered, phase, boundsRef, globalIndex, stageHeight])

  useEffect(() => {
    if (phase !== 'falling') return
    const landBottom = landingBottomRef.current
    let frame = 0

    const applyDom = () => {
      const node = fallingRef.current
      if (!node) return
      const p = physicsRef.current
      const endTop = landBottom - p.h
      const startTop = fallStartTopRef.current
      const span = Math.max(1e-4, endTop - startTop)
      let t = (p.top - startTop) / span
      t = Math.min(1, Math.max(0, t))
      // 略加速收缩感（越接近地面越小）
      const eased = t * t * (3 - 2 * t)
      const scale = 1 + (FALL_SCALE_MIN - 1) * eased

      node.style.left = `${p.left}px`
      node.style.top = `${p.top}px`
      node.style.width = `${p.w}px`
      node.style.minHeight = `${p.h}px`
      node.style.transformOrigin = 'center center'
      node.style.transform = `rotate(${p.rot}deg) scale(${scale})`
    }

    const tick = () => {
      const p = physicsRef.current
      p.vy += GRAVITY
      p.left += p.vx
      p.top += p.vy
      p.rot += p.vrot

      const bottom = p.top + p.h
      if (bottom >= landBottom) {
        p.top = landBottom - p.h
        applyDom()
        const cx = p.left + p.w / 2
        const wordBottom = p.top + p.h
        setImpact({
          cx,
          rippleY: wordBottom - RIPPLE_UP_FROM_BOTTOM_PX,
          dissolveY: p.top + p.h * 0.5,
          w: p.w,
          h: p.h,
        })
        setPhase('impact')
        return
      }
      applyDom()
      frame = requestAnimationFrame(tick)
    }

    applyDom()
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase])

  useEffect(() => {
    if (phase !== 'impact') return
    const t = window.setTimeout(() => setPhase('dissolve'), IMPACT_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  const handleDissolveDone = useCallback(() => setPhase('done'), [])

  return (
    <>
      <span
        ref={wrapRef}
        style={{ display: 'inline-block', verticalAlign: 'baseline' }}
      >
        {phase === 'idle' && (
          <span style={{ ...POEM_WORD_STYLE, fontSize: `${poemFontSizePx}px` }}>{word}</span>
        )}
        {phase !== 'idle' && placeholder && (
          <span
            style={{
              display: 'inline-block',
              width: placeholder.w,
              minHeight: placeholder.h,
              visibility: 'hidden',
            }}
            aria-hidden
          >
            {word}
          </span>
        )}
      </span>
      {(phase === 'falling' || phase === 'impact') && (
        <div
          ref={fallingRef}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            margin: 0,
            padding: 0,
            ...POEM_WORD_STYLE,
            fontSize: `${poemFontSizePx}px`,
            pointerEvents: 'none',
            zIndex: 30,
            whiteSpace: 'nowrap',
            transformOrigin: 'center center',
            willChange: 'transform',
          }}
        >
          {word}
        </div>
      )}
      {phase === 'impact' && impact && (
        <RippleBurst centerX={impact.cx} centerY={impact.rippleY} />
      )}
      {phase === 'dissolve' && impact && (
        <WordDissolveParticles
          centerX={impact.cx}
          centerY={impact.dissolveY}
          width={impact.w}
          height={impact.h}
          onDone={handleDissolveDone}
        />
      )}
    </>
  )
}

type WordOverlayProps = {
  sentences: string[][]
  droppedIndices: ReadonlySet<number>
  boundsRef: RefObject<HTMLElement | null>
  stageHeight: number
  /** 诗行已全部掉落后：切换提示，引导自由说话开花 */
  allWordsDropped: boolean
}

const POEM_LINE_FONT_SIZE_PX = 18

/** 顶部两句切换：渐隐渐出时长 */
const LABEL_CROSSFADE_MS = 950

/** 2D 字效果：坐标与落地均在 boundsRef（与 canvas 同尺寸的 stage）内 */
export function WordOverlay({
  sentences,
  droppedIndices,
  boundsRef,
  stageHeight,
  allWordsDropped,
}: WordOverlayProps) {
  const labelShared: CSSProperties = {
    fontFamily: FONT_SCRIPT,
    fontSize: '22px',
    fontWeight: 400,
    fontStyle: 'normal',
    letterSpacing: '0.05em',
    textShadow:
      '0 0 10px rgba(240, 245, 255, 0.65), 0 0 26px rgba(230, 238, 255, 0.4), 0 0 44px rgba(220, 232, 255, 0.2)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    transition: `opacity ${LABEL_CROSSFADE_MS}ms ease-in-out`,
  }

  const labelPhase1: CSSProperties = {
    ...labelShared,
    color: 'rgba(252, 253, 255, 0.88)',
    opacity: allWordsDropped ? 0 : 1,
  }

  const labelPhase2: CSSProperties = {
    ...labelShared,
    color: 'rgba(255, 255, 255, 0.92)',
    opacity: allWordsDropped ? 1 : 0,
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '20px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          minHeight: '40px',
          marginBottom: '12px',
        }}
      >
        <div style={labelPhase1}>say it out loud</div>
        <div style={labelPhase2}>it&apos;s listening</div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {sentences.map((sentence, si) => (
          <div
            key={si}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: '6px',
              rowGap: '4px',
            }}
          >
            {sentence.map((word, wi) => {
              const globalIndex = sentences.slice(0, si).flat().length + wi
              return (
                <FallingWord
                  key={globalIndex}
                  word={word}
                  globalIndex={globalIndex}
                  triggered={droppedIndices.has(globalIndex)}
                  boundsRef={boundsRef}
                  stageHeight={stageHeight}
                  poemFontSizePx={POEM_LINE_FONT_SIZE_PX}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
