import { TreeSystem } from './TreeSystem'
import { SpeechHandler } from './SpeechHandler'
import { FlowerSystem } from './FlowerSystem'

// 每句话的关键词，识别到任意一个关键词就认为这句说了
const SENTENCES = [
  { words: ['There', 'is', 'a', 'seed', 'in', 'the', 'soil.'], keywords: ['seed', 'soil'] },
  { words: ['The', 'sun', 'is', 'warm.'],                       keywords: ['sun', 'warm'] },
  { words: ['The', 'rain', 'falls', 'down.'],                   keywords: ['rain', 'falls'] },
  { words: ['It', 'grows', 'into', 'a', 'tree.'],               keywords: ['grows', 'tree'] },
]

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
    dropWord: (index: number) => void
  ) {
    this.tree = new TreeSystem(container, width, height)
    this.dropWord = dropWord

    this.speech = new SpeechHandler((word) => {
      if (this.currentSentence >= SENTENCES.length) return

      const cleaned = word.toLowerCase().replace(/[^a-z]/g, '')
      const sentence = SENTENCES[this.currentSentence]

      console.log(`等待第${this.currentSentence + 1}句，关键词: ${sentence.keywords}，识别到: "${cleaned}"`)

      if (sentence.keywords.includes(cleaned)) {
        this.dropSentence(this.currentSentence)
        this.currentSentence++
      }
    })
  }

  private dropSentence(sentenceIndex: number) {
    if (this.droppedSentences.has(sentenceIndex)) return
    this.droppedSentences.add(sentenceIndex)
  
    const offset = SENTENCES.slice(0, sentenceIndex).reduce((sum, s) => sum + s.words.length, 0)
    SENTENCES[sentenceIndex].words.forEach((_, wi) => {
      setTimeout(() => {
        const idx = offset + wi
        this.dropWord(idx)
        this.tree.onWordDrop(idx)
      }, wi * 150)
    })
  
    // 语义触发
    if (sentenceIndex === 0) this.tree.triggerSeed()
    if (sentenceIndex === 1) this.tree.triggerGrow(1)
    if (sentenceIndex === 2) this.tree.triggerGrow(2)
    if (sentenceIndex === 3) this.tree.triggerGrow(3)
  }

  init() {
    this.speech.start()
  }

  update(timeDomain: Uint8Array, frequency: Uint8Array) {
    this.tryInitFlowerSystem()
    this.flower?.update(timeDomain, frequency)
  }

  /** Phase 1 结束且树上有采样点后再创建（每帧尝试直到成功） */
  private tryInitFlowerSystem() {
    if (this.flower !== null) return
    if (this.currentSentence < SENTENCES.length) return
    const tips = this.tree.getTips()
    const mids = this.tree.getMidPoints()
    const pts = [...tips, ...mids]
    if (pts.length === 0) return
    this.flower = new FlowerSystem(this.tree.getScene(), this.tree.getCamera())
    this.flower.setGrowPoints(pts)
  }

  /**
   * 开发用：跳过念诗，UI 进入「it's listening」等价状态，并按序触发种子与长树。
   * 上线前可删。
   */
  devSkipToListening() {
    this.currentSentence = SENTENCES.length
    for (let i = 0; i < SENTENCES.length; i++) {
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