import { useRef, useEffect, useState, useCallback } from 'react'
import { VoiceTreeVisualizer } from './voiceTree/VoiceTreeVisualizer'
import { WordOverlay } from './wordFx/WordOverlay'
import { OVERLAY_SENTENCES, POEM_WORD_COUNT } from './poem'
import type { SpeechErrorCode } from './voiceTree/SpeechHandler'

export interface VisualizerProps {
  frequencyData: React.RefObject<Uint8Array>
  timeDomainData: React.RefObject<Uint8Array>
  isActive: boolean
  width: number
  height: number
}

type SpeechState = 'idle' | 'starting' | 'ready' | 'blocked' | 'unsupported' | 'error'

export function Visualizer({ frequencyData, timeDomainData, isActive, width, height }: VisualizerProps) {
  /** Same box as WebGL; 2D words use this ref (not fixed viewport height). */
  const boundsRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vizRef = useRef<VoiceTreeVisualizer | null>(null)
  const initializedRef = useRef(false)
  const speechStateRef = useRef<SpeechState>('idle')

  const [speechState, setSpeechState] = useState<SpeechState>('idle')
  const [fallenWords, setFallenWords] = useState<Set<number>>(new Set())

  const setSpeechStateSafe = useCallback((next: SpeechState) => {
    speechStateRef.current = next
    setSpeechState(next)
  }, [])

  const dropWord = useCallback((index: number) => {
    setFallenWords(prev => new Set([...prev, index]))
  }, [])

  const skipToBloom = useCallback(() => {
    setFallenWords(new Set(Array.from({ length: POEM_WORD_COUNT }, (_, i) => i)))
    vizRef.current?.skipToBloom()
  }, [])

  const beginSpeech = useCallback(() => {
    if (!vizRef.current) return
    if (speechStateRef.current === 'ready' || speechStateRef.current === 'starting' || speechStateRef.current === 'unsupported') {
      return
    }
    setSpeechStateSafe('starting')
    vizRef.current.startSpeech()
  }, [setSpeechStateSafe])

  useEffect(() => {
    if (!containerRef.current) return
    if (initializedRef.current) return
    initializedRef.current = true

    const viz = new VoiceTreeVisualizer(containerRef.current, width, height, dropWord, {
      onSpeechListeningStart: () => {
        setSpeechStateSafe('ready')
      },
      onSpeechListeningEnd: () => {
        if (!isActive || speechStateRef.current !== 'ready') return
        // SpeechHandler handles auto-restart internally when allowed.
      },
      onSpeechError: (error: SpeechErrorCode) => {
        if (error === 'not-supported') {
          setSpeechStateSafe('unsupported')
          return
        }
        if (error === 'not-allowed' || error === 'service-not-allowed') {
          setSpeechStateSafe('blocked')
          return
        }
        setSpeechStateSafe('error')
      },
    })
    vizRef.current = viz

    return () => {
      viz.dispose()
      vizRef.current = null
      initializedRef.current = false
      setSpeechStateSafe('idle')
    }
  }, [width, height, dropWord, isActive, setSpeechStateSafe])

  useEffect(() => {
    if (!isActive) {
      queueMicrotask(() => {
        setSpeechStateSafe('idle')
      })
    }
  }, [isActive, setSpeechStateSafe])

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

  const speechButtonText =
    speechState === 'starting'
      ? 'Starting...'
      : speechState === 'blocked'
        ? 'Enable Speech'
        : speechState === 'unsupported'
          ? 'Speech Unsupported'
          : speechState === 'error'
            ? 'Retry Speech'
            : 'Start Speech'

  return (
    <div ref={boundsRef} style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      {speechState !== 'ready' && (
        <button
          type="button"
          className="viz-speech-start"
          onClick={beginSpeech}
          disabled={speechState === 'starting' || speechState === 'unsupported'}
          title="Click to start speech recognition for poem keywords"
        >
          {speechButtonText}
        </button>
      )}
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
