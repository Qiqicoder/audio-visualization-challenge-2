import { useRef, useEffect, useState, useCallback } from 'react'
import { VoiceTreeVisualizer } from './voiceTree/VoiceTreeVisualizer'
import { WordOverlay } from './wordFx/WordOverlay'
import { OVERLAY_SENTENCES, POEM_WORD_COUNT } from './poem'

export interface VisualizerProps {
  frequencyData: React.RefObject<Uint8Array>
  timeDomainData: React.RefObject<Uint8Array>
  isActive: boolean
  width: number
  height: number
}

export function Visualizer({ frequencyData, timeDomainData, isActive, width, height }: VisualizerProps) {
  /** Same box as WebGL; 2D words use this ref (not fixed viewport height). */
  const boundsRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vizRef = useRef<VoiceTreeVisualizer | null>(null)
  const initializedRef = useRef(false)
  const [fallenWords, setFallenWords] = useState<Set<number>>(new Set())

  const dropWord = useCallback((index: number) => {
    setFallenWords(prev => new Set([...prev, index]))
  }, [])

  const skipToBloom = useCallback(() => {
    setFallenWords(new Set(Array.from({ length: POEM_WORD_COUNT }, (_, i) => i)))
    vizRef.current?.skipToBloom()
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
      <button
        type="button"
        className="viz-bloom-skip"
        onClick={skipToBloom}
        title="Optional: skip the poem and jump to the tree bloom (microphone visualization)"
      >
        Bloom
      </button>
      <div ref={containerRef} style={{ width, height, display: 'block' }} />
      <WordOverlay
        boundsRef={boundsRef}
        stageHeight={height}
        sentences={OVERLAY_SENTENCES}
        droppedIndices={fallenWords}
        allWordsDropped={fallenWords.size >= POEM_WORD_COUNT}
      />
    </div>
  )
}
