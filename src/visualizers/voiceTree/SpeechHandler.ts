export type SpeechErrorCode = SpeechRecognitionErrorEvent['error'] | 'not-supported' | 'start-failed'

export type SpeechHandlerOptions = {
  onListeningStart?: () => void
  onListeningEnd?: () => void
  onError?: (error: SpeechErrorCode) => void
}

export class SpeechHandler {
  private recognition: SpeechRecognition | null = null
  private onWord: (word: string) => void
  private processedWordCount = 0
  private readonly options: SpeechHandlerOptions
  private restartAfterEnd = true
  private disposed = false

  constructor(onWord: (word: string) => void, options: SpeechHandlerOptions = {}) {
    this.onWord = onWord
    this.options = options
  }

  start() {
    if (this.disposed) return

    const SR =
      window.SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition: typeof SpeechRecognition }).webkitSpeechRecognition
    if (!SR) {
      this.options.onError?.('not-supported')
      console.warn('SpeechRecognition not supported; try Chrome.')
      return
    }

    this.detachRecognition(false)

    this.recognition = new SR()
    this.recognition.lang = 'en-US'
    this.recognition.continuous = true
    this.recognition.interimResults = true

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      let fullTranscript = ''
      for (let i = 0; i < event.results.length; i++) {
        fullTranscript += event.results[i]![0]!.transcript
      }

      const words = fullTranscript.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0)

      if (words.length > this.processedWordCount) {
        const newWords = words.slice(this.processedWordCount)
        newWords.forEach(w => {
          this.onWord(w)
        })
        this.processedWordCount = words.length
      }
    }

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.restartAfterEnd = false
      }
      this.options.onError?.(event.error)
      console.error('SpeechRecognition error:', event.error)
    }

    this.recognition.onstart = () => {
      this.options.onListeningStart?.()
    }

    this.recognition.onend = () => {
      this.options.onListeningEnd?.()
      if (this.disposed || !this.restartAfterEnd || !this.recognition) return
      this.processedWordCount = 0
      try {
        this.recognition.start()
      } catch {
        this.restartAfterEnd = false
      }
    }

    this.restartAfterEnd = true
    try {
      this.recognition.start()
    } catch (e) {
      this.options.onError?.('start-failed')
      console.error('SpeechRecognition.start() failed:', e)
      this.restartAfterEnd = false
    }
  }

  private detachRecognition(forDispose: boolean) {
    if (!this.recognition) return
    if (forDispose) this.restartAfterEnd = false
    this.recognition.onresult = null
    this.recognition.onerror = null
    this.recognition.onstart = null
    this.recognition.onend = null
    try {
      this.recognition.stop()
    } catch {
      try {
        this.recognition.abort()
      } catch {
        /* ignore */
      }
    }
    this.recognition = null
  }

  dispose() {
    this.disposed = true
    this.detachRecognition(true)
  }
}
