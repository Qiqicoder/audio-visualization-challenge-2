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

type SpeechState = 'idle' | 'starting' | 'ready' | 'retrying' | 'blocked' | 'unsupported'

const RETRYABLE_ERRORS = new Set<SpeechErrorCode>(['network', 'audio-capture', 'no-speech', 'aborted', 'start-failed'])

export function Visualizer({ frequencyData, timeDomainData, isActive, width, height }: VisualizerProps) {
  /** Same box as WebGL; 2D words use this ref (not fixed viewport height). */
  const boundsRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vizRef = useRef<VoiceTreeVisualizer | null>(null)
  const initializedRef = useRef(false)

  const isActiveRef = useRef(isActive)
  const speechStateRef = useRef<SpeechState>('idle')
  const retryTimerRef = useRef<number | null>(null)
  const retryAttemptRef = useRef(0)

  const [speechState, setSpeechState] = useState<SpeechState>('idle')
  const [fallenWords, setFallenWords] = useState<Set<number>>(new Set())

  const setSpeechStateSafe = useCallback((next: SpeechState) => {
    speechStateRef.current = next
    setSpeechState(next)
  }, [])

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  const dropWord = useCallback((index: number) => {
    setFallenWords(prev => new Set([...prev, index]))
  }, [])

  const skipToBloom = useCallback(() => {
    setFallenWords(new Set(Array.from({ length: POEM_WORD_COUNT }, (_, i) => i)))
    vizRef.current?.skipToBloom()
  }, [])

  const tryStartSpeech = useCallback(() => {
    if (!vizRef.current) return
    if (speechStateRef.current === 'ready' || speechStateRef.current === 'blocked' || speechStateRef.current === 'unsupported') {
      return
    }
    setSpeechStateSafe('starting')
    vizRef.current.startSpeech()
  }, [setSpeechStateSafe])

  const scheduleRetry = useCallback((delayMs: number) => {
    clearRetryTimer()
    if (!isActiveRef.current) return
    setSpeechStateSafe('retrying')
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null
      if (!isActiveRef.current) return
      tryStartSpeech()
    }, delayMs)
  }, [clearRetryTimer, setSpeechStateSafe, tryStartSpeech])

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    if (!containerRef.current) return
    if (initializedRef.current) return
    initializedRef.current = true
    retryAttemptRef.current = 0

    const viz = new VoiceTreeVisualizer(containerRef.current, width, height, dropWord, {
      onSpeechListeningStart: () => {
        retryAttemptRef.current = 0
        clearRetryTimer()
        setSpeechStateSafe('ready')
      },
      onSpeechListeningEnd: () => {
        if (!isActiveRef.current || speechStateRef.current === 'blocked' || speechStateRef.current === 'unsupported') return
        scheduleRetry(450)
      },
      onSpeechError: (error) => {
        if (error === 'not-supported') {
          clearRetryTimer()
          setSpeechStateSafe('unsupported')
          return
        }
        if (error === 'not-allowed' || error === 'service-not-allowed') {
          clearRetryTimer()
          setSpeechStateSafe('blocked')
          return
        }
        if (RETRYABLE_ERRORS.has(error)) {
          retryAttemptRef.current += 1
          const delay = Math.min(8000, 500 * 2 ** (retryAttemptRef.current - 1))
          scheduleRetry(delay)
          return
        }
        scheduleRetry(1200)
      },
    })
    vizRef.current = viz

    return () => {
      clearRetryTimer()
      viz.dispose()
      vizRef.current = null
      initializedRef.current = false
      retryAttemptRef.current = 0
      setSpeechStateSafe('idle')
    }
  }, [width, height, dropWord, clearRetryTimer, scheduleRetry, setSpeechStateSafe])

  useEffect(() => {
    if (!isActive) {
      clearRetryTimer()
      retryAttemptRef.current = 0
      queueMicrotask(() => {
        setSpeechStateSafe('idle')
      })
      return
    }
    queueMicrotask(() => {
      tryStartSpeech()
    })
  }, [isActive, clearRetryTimer, setSpeechStateSafe, tryStartSpeech])

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

  let speechHint = ''
  if (speechState === 'starting' || speechState === 'retrying') speechHint = 'starting speech...'
  if (speechState === 'blocked') speechHint = 'tap anywhere to enable speech'
  if (speechState === 'unsupported') speechHint = 'speech recognition unavailable in this browser'

  return (
    <div
      ref={boundsRef}
      style={{ position: 'relative', width, height, overflow: 'hidden' }}
      onPointerDownCapture={() => {
        if (!isActive) return
        if (speechStateRef.current === 'ready' || speechStateRef.current === 'unsupported') return
        retryAttemptRef.current = 0
        clearRetryTimer()
        setSpeechStateSafe('starting')
        tryStartSpeech()
      }}
    >
      {speechHint && <div className="viz-speech-status">{speechHint}</div>}
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
