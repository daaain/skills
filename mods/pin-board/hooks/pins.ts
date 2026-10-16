import type { PromptOrigin } from 'claude-code'

import type { PinKind } from '../types'

// Origins that mean the person themselves started the turn, on whichever client.
const PERSON_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set([
  'composer',
  'bridge',
  'sdk',
  'auto-continuation',
])

// An answer at least this long, with no question, still reads as a summary worth keeping.
export const MIN_SUMMARY_CHARS = 280

export const isBackgroundOrigin = (origin: PromptOrigin): boolean => !PERSON_ORIGINS.has(origin.kind)

const TRAILING_MARKUP = /[\s*_`)\]"'”’]+$/

export const asksQuestion = (text: string): boolean => {
  let isInFence = false

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      isInFence = !isInFence
      continue
    }
    if (!isInFence && line.replace(TRAILING_MARKUP, '').endsWith('?')) {
      return true
    }
  }

  return false
}

export const autoPinFor = (answer: string): { kind: PinKind; text: string } | null => {
  const text = answer.trim()

  if (asksQuestion(text)) {
    return { kind: 'question', text }
  }
  if (text.length >= MIN_SUMMARY_CHARS) {
    return { kind: 'summary', text }
  }

  return null
}

const LEADING_MARKUP = /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)*/

export const preview = (text: string): string =>
  text
    .split('\n')
    .map(line => line.replace(LEADING_MARKUP, '').trim())
    .find(line => line.length > 0) ?? ''

export type PinsCommand =
  | { action: 'list' }
  | { action: 'clear' }
  | { action: 'show'; n: number }
  | { action: 'go'; n: number }
  | { action: 'done'; ns: number[] }
  | { action: 'usage' }

const NUMBER = /^\d+$/

export const parsePinsCommand = (args: string): PinsCommand => {
  const [verb, ...rest] = args.trim().split(/[\s,]+/).filter(word => word !== '')

  if (verb === undefined) return { action: 'list' }
  if (rest.length === 0 && verb === 'clear') return { action: 'clear' }
  if (rest.length === 0 && NUMBER.test(verb)) return { action: 'show', n: Number(verb) }
  if (verb === 'go' && rest.length === 1 && NUMBER.test(rest[0]!)) return { action: 'go', n: Number(rest[0]) }
  if (verb === 'done' && rest.length > 0 && rest.every(word => NUMBER.test(word))) {
    return { action: 'done', ns: rest.map(Number) }
  }

  return { action: 'usage' }
}

// Whether a Messages API `content` (a string, or a list of blocks) holds visible text.
export const hasText = (content: unknown): boolean => {
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false

  return content.some(
    block => typeof block === 'object' && block !== null && block.type === 'text' && String(block.text).trim() !== '',
  )
}
