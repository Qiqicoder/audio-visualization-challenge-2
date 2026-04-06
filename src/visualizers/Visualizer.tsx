import { useRef, useEffect, useState, useCallback } from 'react'
import { VoiceTreeVisualizer } from './voiceTree/VoiceTreeVisualizer'
import { WordOverlay } from './wordFx/WordOverlay'

export interface VisualizerProps {
  frequencyData: React.RefObject<Uint8Array<ArrayBuffer>>
  timeDomainData: React.RefObject<Uint8Array<ArrayBuffer>>
  isActive: boolean
  width: number
  height: number
}

export const SENTENCES = [
  ['There', 'is', 'a', 'seed', 'in', 'the', 'soil.'],
  ['The', 'sun', 'is', 'warm.'],
  ['The', 'rain', 'falls', 'down.'],
  ['It', 'grows', 'into', 'a', 'tree.'],
]

export const ALL_WORDS = SENTENCES.flat()

export function Visualizer({ frequencyData, timeDomainData, isActive, width, height }: VisualizerProps) {
  /** 与 WebGL 同尺寸的 stage，字动画用同一坐标系（勿用 fixed / innerHeight） */
  const boundsRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vizRef = useRef<VoiceTreeVisualizer | null>(null)
  const initializedRef = useRef(false)
  const [fallenWords, setFallenWords] = useState<Set<number>>(new Set())

  const dropWord = useCallback((index: number) => {
    setFallenWords(prev => new Set([...prev, index]))
  }, [])

  /** 开发：一键进入 it's listening + 长树（勿用于正式流程） */
  const devSkipToListening = useCallback(() => {
    setFallenWords(new Set(Array.from({ length: ALL_WORDS.length }, (_, i) => i)))
    vizRef.current?.devSkipToListening()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    if (initializedRef.current) return
    initializedRef.current = true

    const viz = new VoiceTreeVisualizer(containerRef.current, width, height, dropWord)
    vizRef.current = viz
    viz.init()

    return () => {
      viz.dispose()
      vizRef.current = null
      initializedRef.current = false
    }
  }, [width, height, dropWord])

  useEffect(() => {
    if (!isActive) return
    let frameId: number
    const loop = () => {
      vizRef.current?.update(timeDomainData.current, frequencyData.current)
      frameId = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(frameId)
  }, [isActive, timeDomainData, frequencyData])

  return (
    <div ref={boundsRef} style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      {import.meta.env.DEV && (
        <button
          type="button"
          onClick={devSkipToListening}
          style={{
            position: 'absolute',
            right: 6,
            top: 6,
            zIndex: 100,
            padding: '4px 8px',
            fontSize: 11,
            fontFamily: 'system-ui, sans-serif',
            cursor: 'pointer',
            borderRadius: 4,
            border: '1px solid rgba(41,239,181,0.5)',
            background: 'rgba(0,20,40,0.75)',
            color: 'rgba(200,245,230,0.95)',
            pointerEvents: 'auto',
          }}
          title="Skip poem → it's listening (dev only)"
        >
          → listening
        </button>
      )}
      <div ref={containerRef} style={{ width, height, display: 'block' }} />
      <WordOverlay
        boundsRef={boundsRef}
        stageHeight={height}
        sentences={SENTENCES}
        droppedIndices={fallenWords}
        allWordsDropped={fallenWords.size >= ALL_WORDS.length}
      />
    </div>
  )
}