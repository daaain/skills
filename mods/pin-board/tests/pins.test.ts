import { describe, expect, test } from 'claude-code/testing'

import { asksQuestion, autoPinFor, boardsToPrune, findQuoted, isBackgroundOrigin, parsePinsCommand, preview, replyWindow, repliesFromTranscript, textOf } from '../hooks/pins'

describe('isBackgroundOrigin', () => {
  test('the person typing, on any client, is not a background wake', () => {
    for (const kind of ['composer', 'bridge', 'sdk', 'auto-continuation'] as const) {
      expect(isBackgroundOrigin({ kind })).toBe(false)
    }
  })

  test('notifications, schedules, peers and plugins are background wakes', () => {
    expect(isBackgroundOrigin({ kind: 'task-notification' })).toBe(true)
    expect(isBackgroundOrigin({ kind: 'scheduled-trigger' })).toBe(true)
    expect(isBackgroundOrigin({ kind: 'peer' })).toBe(true)
    expect(isBackgroundOrigin({ kind: 'channel', server: 'slack' })).toBe(true)
    expect(isBackgroundOrigin({ kind: 'plugin', name: 'pr-watch' })).toBe(true)
  })
})

describe('asksQuestion', () => {
  test('a line ending in a question mark asks', () => {
    expect(asksQuestion('Fixed the lint.\n\nShall I push the branch?')).toBe(true)
  })

  test('markdown emphasis after the question mark still asks', () => {
    expect(asksQuestion('**Want me to merge it?**')).toBe(true)
  })

  test('a question mark inside a URL or mid-line does not ask', () => {
    expect(asksQuestion('See https://example.com/?q=1 for details.')).toBe(false)
  })

  test('a question inside a code fence does not ask', () => {
    expect(asksQuestion('Ran:\n```\nfoo?\n```\nAll good.')).toBe(false)
  })
})

describe('autoPinFor', () => {
  test('a short all-clear is not pinned', () => {
    expect(autoPinFor('No new review comments yet, still watching.')).toBeNull()
  })

  test('an empty answer is not pinned', () => {
    expect(autoPinFor('   ')).toBeNull()
  })

  test('a short question is pinned as a question', () => {
    expect(autoPinFor('CI failed on lint. Fix it?')).toEqual({
      kind: 'question',
      text: 'CI failed on lint. Fix it?',
    })
  })

  test('a long summary is pinned as a summary', () => {
    const answer = 'The reviewer left three comments. '.repeat(10)
    expect(autoPinFor(answer)).toEqual({ kind: 'summary', text: answer.trim() })
  })
})

describe('preview', () => {
  test('takes the first non-empty line without heading or list markers', () => {
    expect(preview('\n\n## PR #12 update\nmore')).toBe('PR #12 update')
    expect(preview('- first point\n- second')).toBe('first point')
  })
})

describe('parsePinsCommand', () => {
  test('no arguments lists, clear clears', () => {
    expect(parsePinsCommand('  ')).toEqual({ action: 'list' })
    expect(parsePinsCommand('clear')).toEqual({ action: 'clear' })
  })

  test('a number shows that pin, go jumps to it', () => {
    expect(parsePinsCommand('2')).toEqual({ action: 'show', n: 2 })
    expect(parsePinsCommand('go 3')).toEqual({ action: 'go', n: 3 })
  })

  test('done takes one or more numbers, spaces or commas', () => {
    expect(parsePinsCommand('done 1')).toEqual({ action: 'done', ns: [1] })
    expect(parsePinsCommand('done 1, 3 4')).toEqual({ action: 'done', ns: [1, 3, 4] })
  })

  test('anything else is a usage error', () => {
    for (const args of ['done', 'done x', 'go', 'go 1 2', 'nonsense', '2 3']) {
      expect(parsePinsCommand(args)).toEqual({ action: 'usage' })
    }
  })
})

describe('textOf', () => {
  test('joins text blocks and skips the rest', () => {
    expect(textOf([{ type: 'text', text: 'one' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'two' }])).toBe('one\ntwo')
    expect(textOf('plain')).toBe('plain')
    expect(textOf(undefined)).toBe('')
  })
})

describe('findQuoted', () => {
  const rows = [
    { uuid: 'old', text: '1. Rename the helper?\n2. Should we **keep** the   v1 endpoint?' },
    { uuid: 'mid', text: 'Done with the refactor.' },
    { uuid: 'new', text: 'Should we keep the v1 endpoint? Asking again.' },
  ]

  test('finds the newest reply holding the quote, ignoring case, spacing and emphasis', () => {
    expect(findQuoted(rows, 'should we KEEP the v1\nendpoint')).toBe('new')
    expect(findQuoted(rows, 'Rename the helper')).toBe('old')
  })

  test('answers undefined when nothing holds it, or the quote is too short to trust', () => {
    expect(findQuoted(rows, 'drop the database')).toBeUndefined()
    expect(findQuoted(rows, 'the')).toBeUndefined()
    expect(findQuoted(rows, '   ')).toBeUndefined()
  })
})

describe('repliesFromTranscript', () => {
  const line = (row: object) => JSON.stringify(row)
  const assistant = (uuid: string, text: string, extra: object = {}) =>
    line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra })

  test("keeps the main conversation's text replies, oldest first", () => {
    const transcript = [
      line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
      assistant('a1', 'First reply'),
      line({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } }),
      assistant('a3', 'A subagent reply', { isSidechain: true }),
      assistant('a4', 'Second reply'),
    ].join('\n')

    expect(repliesFromTranscript(transcript, false)).toEqual([
      { uuid: 'a1', text: 'First reply' },
      { uuid: 'a4', text: 'Second reply' },
    ])
  })

  test('a tail drops its cut first line, and any line that is not JSON', () => {
    const transcript = ['ssistant","uuid":"cut"}', assistant('a1', 'Kept'), '{not json', ''].join('\n')

    expect(repliesFromTranscript(transcript, true)).toEqual([{ uuid: 'a1', text: 'Kept' }])
  })
})

describe('boardsToPrune', () => {
  test('names the oldest boards past the limit, and nothing within it', () => {
    const boards = [
      { key: 'board:a', savedAt: 30 },
      { key: 'board:b', savedAt: 10 },
      { key: 'board:c', savedAt: 20 },
    ]

    expect(boardsToPrune(boards, 2)).toEqual(['board:b'])
    expect(boardsToPrune(boards, 3)).toEqual([])
  })
})

describe('replyWindow', () => {
  const row = (uuid: string, text: string) =>
    JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })

  test('joins lines split across pieces, and keeps only the newest `max` replies', () => {
    const stream = [row('a1', 'one'), row('a2', 'two'), row('a3', 'three')].join('\n')
    const window = replyWindow(2)

    for (let i = 0; i < stream.length; i += 7) window.push(stream.slice(i, i + 7))

    expect(window.end()).toEqual([
      { uuid: 'a2', text: 'two' },
      { uuid: 'a3', text: 'three' },
    ])
  })
})
