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

// The visible text of a Messages API `content`: a string, or a list of blocks whose text blocks are joined.
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter(block => typeof block === 'object' && block !== null && block.type === 'text')
    .map(block => String(block.text))
    .join('\n')
}

// A quote shorter than this, once normalised, would match too many replies to trust.
export const MIN_QUOTE_CHARS = 8

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// The newest reply whose text holds the quote, ignoring case, spacing and markdown emphasis.
export const findQuoted = (rows: readonly { uuid: string; text: string }[], quote: string): string | undefined => {
  const needle = normalise(quote)
  if (needle.length < MIN_QUOTE_CHARS) return undefined

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (normalise(rows[i]!.text).includes(needle)) return rows[i]!.uuid
  }

  return undefined
}

type Reply = { uuid: string; text: string }

// The main conversation's text replies in a transcript's JSON lines, oldest first. The format
// is Claude Code's own, not the mods API, so anything unexpected is skipped, never thrown.
// `isTail` drops the first line, which a read of the file's end cuts part-way.
export const repliesFromTranscript = (transcript: string, isTail: boolean): Reply[] => {
  const lines = transcript.split('\n')
  const replies: Reply[] = []

  for (const line of isTail ? lines.slice(1) : lines) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue

    const { type, uuid, isSidechain, message } = row as Record<string, unknown>
    if (type !== 'assistant' || isSidechain === true || typeof uuid !== 'string') continue

    const text = textOf((message as { content?: unknown } | undefined)?.content)
    if (text.trim() !== '') replies.push({ uuid, text })
  }

  return replies
}

// The store keys of the oldest boards beyond the newest `keep`.
export const boardsToPrune = (boards: readonly { key: string; savedAt: number }[], keep: number): string[] =>
  [...boards]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(keep)
    .map(board => board.key)

// Collects replies from a transcript streamed in pieces of any size, keeping the newest `max`;
// a line split across two pieces is read once it is whole.
export const replyWindow = (max: number) => {
  let partial = ''
  let replies: Reply[] = []

  const take = (lines: string) => {
    replies = [...replies, ...repliesFromTranscript(lines, false)].slice(-max)
  }

  return {
    push(text: string) {
      const joined = partial + text
      const cut = joined.lastIndexOf('\n')
      if (cut === -1) {
        partial = joined
        return
      }
      take(joined.slice(0, cut))
      partial = joined.slice(cut + 1)
    },
    end(): Reply[] {
      take(partial)
      partial = ''
      return replies
    },
  }
}

// Code points a terminal draws two cells wide (East Asian wide, emoji), and none wide (combining
// marks, zero-width joiners, variation selectors); close enough to keep a row on one line.
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const ZERO_WIDTH = /[̀-ͯ​-‏⃐-⃿︀-️]/

const charWidth = (char: string): number => {
  if (ZERO_WIDTH.test(char)) return 0
  const code = char.codePointAt(0)!
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1
}

export const cellWidth = (text: string): number => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0)

// The text cut to `width` cells, an ellipsis ending what was cut.
export const fitTo = (text: string, width: number): string => {
  if (cellWidth(text) <= width) return text
  if (width <= 0) return ''

  let kept = ''
  let used = 0
  for (const char of text) {
    const next = charWidth(char)
    if (used + next > width - 1) break
    kept += char
    used += next
  }

  return `${kept}…`
}
