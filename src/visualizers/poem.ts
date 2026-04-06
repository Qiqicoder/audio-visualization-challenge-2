/**
 * Single source: overlay lines + speech keywords per line.
 */
export type PoemLine = {
  words: string[]
  keywords: string[]
}

export const POEM: PoemLine[] = [
  { words: ['There', 'is', 'a', 'seed', 'in', 'the', 'soil.'], keywords: ['seed', 'soil'] },
  { words: ['The', 'sun', 'is', 'warm.'], keywords: ['sun', 'warm'] },
  { words: ['The', 'rain', 'falls', 'down.'], keywords: ['rain', 'falls'] },
  { words: ['It', 'grows', 'into', 'a', 'tree.'], keywords: ['grows', 'tree'] },
]

export const OVERLAY_SENTENCES: string[][] = POEM.map(line => [...line.words])

export const POEM_WORD_COUNT = POEM.reduce((n, line) => n + line.words.length, 0)
