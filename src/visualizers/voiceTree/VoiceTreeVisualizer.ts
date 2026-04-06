import { TreeSystem } from './TreeSystem'
import { SpeechHandler } from './SpeechHandler'
import { FlowerSystem } from './FlowerSystem'
import { POEM } from '../poem'

export class VoiceTreeVisualizer {
  private tree: TreeSystem
  private speech: SpeechHandler
  private dropWord: (index: number) => void
  private currentSentence = 0
  private droppedSentences = new Set<number>()
  private flower: FlowerSystem | null = null

  constructor(
    container: HTMLElement,
    width: number,
    height: number,
    dropWord: (index: number) => void,
    opts: { onSpeechListeningStart?: () => void } = {}
  ) {
    this.tree = new TreeSystem(container, width, height)
    this.dropWord = dropWord

    this.speech = new SpeechHandler(
      (word) => {
        if (this.currentSentence >= POEM.length) return

        const cleaned = word.toLowerCase().replace(/[^a-z]/g, '')
        const line = POEM[this.currentSentence]

        if (import.meta.env.DEV) {
          console.debug(
            `[poem] line ${this.currentSentence + 1}/${POEM.length} keywords=${line.keywords.join(',')} heard="${cleaned}"`
          )
        }

        if (line.keywords.includes(cleaned)) {
          this.dropSentence(this.currentSentence)
          this.currentSentence++
        }
      },
      { onListeningStart: opts.onSpeechListeningStart }
    )
  }

  /** Start Web Speech API; Visualizer calls when `isActive` and/or after pointer on stage. */
  startSpeech() {
    this.speech.start()
  }

  private dropSentence(sentenceIndex: number) {
    if (this.droppedSentences.has(sentenceIndex)) return
    this.droppedSentences.add(sentenceIndex)

    const offset = POEM.slice(0, sentenceIndex).reduce((sum, s) => sum + s.words.length, 0)
    POEM[sentenceIndex].words.forEach((_, wi) => {
      setTimeout(() => {
        const idx = offset + wi
        this.dropWord(idx)
        this.tree.onWordDrop(idx)
      }, wi * 150)
    })

    if (sentenceIndex === 0) this.tree.triggerSeed()
    if (sentenceIndex === 1) this.tree.triggerGrow(1)
    if (sentenceIndex === 2) this.tree.triggerGrow(2)
    if (sentenceIndex === 3) this.tree.triggerGrow(3)
  }

  update(timeDomain: Uint8Array, frequency: Uint8Array) {
    this.tryInitFlower()
    if (this.flower !== null) {
      this.flower.syncAnchors(this.tree.getFlowerAnchors())
    }
    this.flower?.update(timeDomain, frequency)
  }

  private tryInitFlower() {
    if (this.flower !== null) return
    if (this.currentSentence < POEM.length) return
    if (this.tree.getFlowerAnchors().length === 0) return
    this.flower = new FlowerSystem(this.tree.getScene(), this.tree.getCamera(), this.tree)
    this.flower.syncAnchors(this.tree.getFlowerAnchors())
  }

  /** Skip poem: mark lines done, run seed + growth sequence, enable mic-driven blooms. */
  skipToBloom() {
    this.currentSentence = POEM.length
    for (let i = 0; i < POEM.length; i++) {
      this.droppedSentences.add(i)
    }
    this.tree.triggerSeed()
    window.setTimeout(() => this.tree.triggerGrow(1), 450)
    window.setTimeout(() => this.tree.triggerGrow(2), 1150)
    window.setTimeout(() => this.tree.triggerGrow(3), 1850)
  }

  dispose() {
    this.flower?.dispose()
    this.flower = null
    this.speech.dispose()
    this.tree.dispose()
  }
}
