export class SpeechHandler {
  private recognition: SpeechRecognition | null = null
  private onWord: (word: string) => void
  private processedWordCount = 0

  constructor(onWord: (word: string) => void) {
    this.onWord = onWord
  }

  start() {
    const SR = window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition: typeof SpeechRecognition }).webkitSpeechRecognition
    if (!SR) {
      console.warn('SpeechRecognition not supported; try Chrome.')
      return
    }

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
      console.error('SpeechRecognition error:', event.error)
    }

    this.recognition.onend = () => {
      this.processedWordCount = 0
      this.recognition?.start()
    }

    this.recognition.start()
  }

  dispose() {
    if (this.recognition) {
      this.recognition.onend = null
      this.recognition.stop()
      this.recognition = null
    }
  }
}
