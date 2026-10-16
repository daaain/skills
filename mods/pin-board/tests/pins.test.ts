import { describe, expect, test } from 'claude-code/testing'

import { asksQuestion, autoPinFor, hasText, isBackgroundOrigin, parsePinsCommand, preview } from '../hooks/pins'

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

describe('hasText', () => {
  test('true only for content holding a non-empty text block', () => {
    expect(hasText([{ type: 'text', text: 'hi' }])).toBe(true)
    expect(hasText([{ type: 'text', text: ' ' }, { type: 'tool_use', id: 'x' }])).toBe(false)
    expect(hasText('plain')).toBe(true)
    expect(hasText(undefined)).toBe(false)
  })
})
