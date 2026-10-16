import type { On, RenderViewport } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

const PIN_TOOL = 'mcp__pin-board__pin'
const PANE = 'pins'
const FULLSCREEN: RenderViewport = { columns: 160, rows: 40, isFullscreen: true }

const BAND = {
  plugin: 'pin-board',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const PANE_SITE = {
  plugin: 'pin-board',
  surface: 'terminal',
  component: 'Pane',
  requestId: PANE,
  props: {
    title: 'Pins',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 38 },
    view: {},
  },
  viewport: FULLSCREEN,
} as const

// Stands in for a background watcher (a PR watch, a Monitor): when its agent
// finishes, its `$.prompt.submit` wakes the main loop with origin `{ kind: 'plugin' }`.
const PR_WATCH = {
  name: 'pr-watch',
  register(on) {
    on('turn.complete', async ($, e, next) => {
      const done = await next(e)
      if (e.agentId === 'watcher') await $.prompt.submit({ text: e.answer })
      return done
    })
  },
} satisfies Plugin

// Reads pin-board's pins out of session state, so a test can check each pin's anchor:
// the test kit can't resolve a plugin's scroll to a transcript row.
const PEEK = {
  name: 'peek',
  register(on) {
    on('session.start', async ($, e, next) => {
      await $.command.register({ name: 'peek', description: "Print pin-board's pins as JSON" })
      return next(e)
    })
    on('command.run', { command: 'peek' }, async $ => {
      const { value } = await $.state.get({ plugin: 'pin-board', key: 'pins' })
      return { text: JSON.stringify(value ?? []) }
    })
  },
} satisfies Plugin

// What the host saw the mod do, for assertions.
type Seen = {
  contexts: (readonly string[] | undefined)[]
  opened: string[]
  isPaneUp: boolean
  toolDescription: string
  // Transcript files by path (with a reported size where it differs), and each argv run.
  files: Record<string, string>
  sizes: Record<string, number>
  argvs: (readonly string[])[]
}

// The engine's bottom of each chain the mods reach, standing in for a session.
const setup = async ($: Engine, on: On, store: Record<string, unknown> = {}): Promise<Seen> => {
  const seen: Seen = { contexts: [], opened: [], isPaneUp: false, toolDescription: '', files: {}, sizes: {}, argvs: [] }

  mock.clock(on, { now: Date.UTC(2026, 9, 16, 9, 30) })
  mock.store(on, store)
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('fs.stat', ($, e) => {
    const path = (e as { path: string }).path
    if (!(path in seen.files)) return { deny: 'missing' }
    return { value: { kind: 'file', size: seen.sizes[path] ?? seen.files[path]!.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path
    return path in seen.files ? { value: seen.files[path]! } : { deny: 'missing' }
  })
  on('process.run', ($, e) => {
    const { argv } = e as { argv: readonly string[] }
    seen.argvs.push(argv)
    // A tail that starts part-way through the first line, as a real one does.
    const text = seen.files[argv[argv.length - 1]!] ?? ''
    return { value: { exitCode: 0, stdout: text.slice(50), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    seen.toolDescription = e.description
    return { value: { tool: `mcp__pin-board__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => {
    seen.contexts.push(e.context)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    seen.isPaneUp = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    seen.isPaneUp = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: seen.isPaneUp ? [{ id: PANE, title: 'Pins', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return seen
}

const command = ($: Engine, name: string, args = '') =>
  $.command.run({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  } as Parameters<Engine['command']['run']>[0])

const complete = ($: Engine, turnId: string, answer: string) =>
  $.turn.complete({ answer, reason: 'answer', durationMs: 10, isAborted: false, turnId })

type PinInput = { text: string; kind?: string; quote?: string; replaces?: string }

const pinWith = async ($: Engine, id: string, input: PinInput) => {
  const answer = await $.tool.call({ tool: PIN_TOOL, tool_use_id: id, ...input } as Parameters<Engine['tool']['call']>[0])
  return answer as { result?: string; deny?: string }
}

const pin = ($: Engine, id: string, text: string, kind?: string) => pinWith($, id, { text, kind })

type Peeked = { text: string; claudeId?: string; anchor?: { row: string; block: string } }

const peek = async ($: Engine): Promise<Peeked[]> => JSON.parse((await command($, 'peek')).text ?? '[]')

// The person pressing Enter at the prompt.
const typed = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

const watcherFinishes = ($: Engine) =>
  $.turn.complete({
    answer: 'task finished',
    reason: 'answer',
    durationMs: 10,
    isAborted: false,
    turnId: 'w1',
    agentId: 'watcher',
  })

const reply = ($: Engine, uuid: string, text: string) =>
  $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid,
  } as Parameters<Engine['session']['append']>[0])

// A turn started by a background event, ending on `answer`.
const wakeTurn = async ($: Engine, turnId: string, answer: string) => {
  await watcherFinishes($)
  await $.turn.start({ text: 'task finished', turnId })
  await reply($, `msg-${turnId}`, answer)
  await complete($, turnId, answer)
}

type Site = typeof BAND | typeof PANE_SITE

const textOf = async ($: Engine, site: Site, viewport?: RenderViewport) => {
  const ui = await $.ui.mount(viewport === undefined ? site : { ...site, viewport })
  const shown = [
    ...(await ui.findAll({ type: 'Button' })),
    ...(await ui.findAll({ type: 'Text' })),
    ...(await ui.findAll({ type: 'Markdown' })),
  ]
  await ui.unmount()
  return shown.map(one => one.text).join('\n')
}

test('a background wake that asks a question is pinned above the prompt', { plugins: [PR_WATCH] }, async ($, on) => {
  await setup($, on)

  await wakeTurn($, 't1', 'PR #42 got a review: rename the helper?')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const text = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')
    await ui.unmount()
    expect(text).toContain('Pinned (1)')
    expect(text).toContain('PR #42 got a review: rename the helper?')
  }
})

test('a background wake with a short all-clear pins nothing', { plugins: [PR_WATCH] }, async ($, on) => {
  await setup($, on)

  await wakeTurn($, 't1', 'No new comments.')

  expect(await textOf($, BAND)).toBe('')
})

test('a turn the person started is never auto-pinned', async ($, on) => {
  await setup($, on)

  await typed($, 'what changed?')
  await $.turn.start({ text: 'what changed?', turnId: 't1' })
  await complete($, 't1', 'Three files changed. Want a summary of each?')

  expect(await textOf($, BAND)).toBe('')
})

test('only a background prompt carries the reminder to pin', { plugins: [PR_WATCH] }, async ($, on) => {
  const seen = await setup($, on)

  await typed($, 'what changed?')
  await watcherFinishes($)

  expect(seen.contexts[0] ?? []).toHaveLength(0)
  expect(seen.contexts[1]?.join('\n')).toContain(PIN_TOOL)
})

test('a pin Claude makes replaces the automatic pin for that turn', { plugins: [PR_WATCH] }, async ($, on) => {
  await setup($, on)

  await watcherFinishes($)
  await $.turn.start({ text: 'task finished', turnId: 't1' })
  await pin($, 'u1', 'Merge PR #42?', 'question')
  await complete($, 't1', 'Long recap that would otherwise be pinned. Shall I merge?')

  const text = await textOf($, BAND)
  expect(text).toContain('Merge PR #42?')
  expect(text).not.toContain('Long recap')
})

test('a pin with no text is refused', async ($, on) => {
  await setup($, on)

  expect(await pin($, 'u1', '   ')).toMatchObject({ deny: expect.any(String) })
})

test('the band lists the newest pin first, numbered', async ($, on) => {
  await setup($, on)
  await pin($, 'u1', 'Older?')
  await pin($, 'u2', 'Newer?')

  const ui = await $.ui.mount(BAND)
  const rows = (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('pin:'))
  expect(rows.map(row => JSON.stringify(row.children))).toEqual([
    expect.stringMatching(/1[\s\S]*Newer\?/),
    expect.stringMatching(/2[\s\S]*Older\?/),
  ])
})

test('expanding a pin shows its full text, dismissing removes it', async ($, on) => {
  await setup($, on)
  await pin($, 'u1', 'First?\n\nWith detail below.')
  await pin($, 'u2', 'Second?')

  const ui = await $.ui.mount(BAND)
  const keys = async (prefix: string) =>
    (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith(prefix))

  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.press({ key: (await keys('toggle:'))[1]! })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('With detail below.')

  await ui.press({ key: (await keys('dismiss:'))[0]! })
  expect(await keys('dismiss:')).toHaveLength(1)

  await ui.press({ key: 'clear-all' })
  expect(await ui.find({ key: 'clear-all' })).toBeUndefined()
})

test('in fullscreen a new pin docks the pane and the band shrinks to one line', async ($, on) => {
  const seen = await setup($, on)
  await textOf($, BAND, FULLSCREEN)

  await pin($, 'u1', 'Rebase onto main?\n\nThe branch is 12 commits behind.')

  expect(seen.opened).toEqual([PANE])
  const band = await textOf($, BAND, FULLSCREEN)
  expect(band).toContain('1 pinned')
  expect(band).not.toContain('Rebase onto main?')
  expect(await textOf($, PANE_SITE)).toContain('The branch is 12 commits behind.')
})

test('outside fullscreen no pane opens', async ($, on) => {
  const seen = await setup($, on)
  await textOf($, BAND)

  await pin($, 'u1', 'Rebase onto main?')

  expect(seen.opened).toEqual([])
})

// A close by the person (ctrl+x x) can't be raised from the test kit; the mod's own close can.
test('a pane closed because the board emptied reopens on the next pin', async ($, on) => {
  const seen = await setup($, on)
  await textOf($, BAND, FULLSCREEN)
  await pin($, 'u1', 'First?')

  await command($, 'pins', 'clear')
  expect(seen.isPaneUp).toBe(false)

  await pin($, 'u2', 'Second?')
  expect(seen.opened).toEqual([PANE, PANE])
})

// The test kit can't resolve a plugin's scroll to a transcript row, so these check that a jump
// is offered and attempted with a recorded anchor, not where the transcript lands.
test("Claude's pin offers a jump in fullscreen only", async ($, on) => {
  await setup($, on)
  await pin($, 'u1', 'Merge PR #42?')

  const jumps = async (viewport?: RenderViewport) => {
    const ui = await $.ui.mount(viewport === undefined ? BAND : { ...BAND, viewport })
    const found = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('jump:'))
    await ui.unmount()
    return found
  }

  expect(await jumps()).toHaveLength(0)
  expect(await jumps({ columns: 100, rows: 40, isFullscreen: true })).toHaveLength(1)
})

test("an automatic pin anchors to the top of the answer's message", { plugins: [PR_WATCH, PEEK] }, async ($, on) => {
  await setup($, on)

  await wakeTurn($, 't1', 'CI failed on lint. Fix it?')

  expect((await peek($))[0]?.anchor).toEqual({ row: 'msg-t1', block: 'start' })
  expect((await command($, 'pins', 'go 1')).text).not.toContain('no place in the transcript')
})

test('an automatic pin with no text reply recorded has nowhere to jump', { plugins: [PR_WATCH] }, async ($, on) => {
  await setup($, on)

  await watcherFinishes($)
  await $.turn.start({ text: 'task finished', turnId: 't1' })
  await complete($, 't1', 'CI failed on lint. Fix it?')

  expect((await command($, 'pins', 'go 1')).text).toContain('no place in the transcript')
})

test('/pins lists, shows, dismisses by number and clears', async ($, on) => {
  await setup($, on)
  await pin($, 'u1', 'Rebase onto main?\n\nThe branch is behind.', 'question')
  await pin($, 'u2', 'Deploy finished.', 'fyi')

  const listed = (await command($, 'pins')).text ?? ''
  expect(listed).toMatch(/1\. .*fyi: Deploy finished\.[\s\S]*2\. .*question: Rebase onto main\?/)

  expect((await command($, 'pins', '2')).text).toContain('The branch is behind.')
  expect((await command($, 'pins', '9')).text).toContain('No pin 9')

  await command($, 'pins', 'done 1')
  expect((await command($, 'pins')).text).not.toContain('Deploy finished.')

  expect((await command($, 'pins', 'bogus')).text).toContain('Usage')

  await command($, 'pins', 'clear')
  expect((await command($, 'pins')).text).toBe('No pins.')
})

test('the pin tool runs without a permission prompt, unless the person denied it', async ($, on) => {
  let verdict: 'ask' | 'deny' = 'ask'
  on('tool.check', () => ({ decision: verdict }))
  await setup($, on)

  expect((await $.tool.check({ tool: PIN_TOOL, input: { text: 'hi' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')

  verdict = 'deny'
  expect((await $.tool.check({ tool: PIN_TOOL, input: { text: 'hi' } })).decision).toBe('deny')
})

test('the always-sent description covers parking unanswered questions', async ($, on) => {
  const seen = await setup($, on)

  expect(seen.toolDescription).toContain("hasn't answered")
})

test("a pin without a quote jumps to its own call, shown at the bottom of the screen", { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)

  await pin($, 'u1', 'Still open: Q2 and Q4')

  expect((await peek($))[0]?.anchor).toEqual({ row: 'u1', block: 'end' })
})

test('a quote anchors the pin to the top of the earlier reply it came from', { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)
  await reply($, 'msg-a', '1. Rename the helper?\n2. Should we **keep** the v1 endpoint?')
  await reply($, 'msg-b', 'Renamed it.')

  const answer = await pinWith($, 'u1', { text: 'Still open: Q2', quote: 'should we keep the v1 endpoint' })

  expect((await peek($))[0]?.anchor).toEqual({ row: 'msg-a', block: 'start' })
  expect(answer.result).not.toContain("didn't match")
})

test("a quote that matches nothing falls back to the pin's own call, and says so", { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)
  await reply($, 'msg-a', 'Rename the helper?')

  const answer = await pinWith($, 'u1', { text: 'Still open: Q9', quote: 'drop the database' })

  expect((await peek($))[0]?.anchor).toEqual({ row: 'u1', block: 'end' })
  expect(answer.result).toContain("didn't match")
})

test('Claude can update a pin by its id, then remove it', { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)

  const first = await pinWith($, 'u1', { text: 'Still open: Q2 and Q4', kind: 'question' })
  expect(first.result).toContain('p1')

  const updated = await pinWith($, 'u2', { text: 'Still open: Q4', replaces: 'p1' })
  expect(updated.result).toContain('p1')
  expect((await peek($)).map(one => [one.claudeId, one.text])).toEqual([['p1', 'Still open: Q4']])

  await pinWith($, 'u3', { text: '', replaces: 'p1' })
  expect(await peek($)).toEqual([])
})

test('an update keeps the anchor of the questions it is about, unless given a new quote', { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)
  await reply($, 'msg-a', 'Should we keep the v1 endpoint?')
  await pinWith($, 'u1', { text: 'Still open: Q2', quote: 'keep the v1 endpoint' })

  await pinWith($, 'u2', { text: 'Still open: Q2, now urgent', replaces: 'p1' })

  expect((await peek($))[0]?.anchor).toEqual({ row: 'msg-a', block: 'start' })
})

test('replacing a pin the person already dismissed pins it afresh', { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)
  await pin($, 'u1', 'Still open: Q2')
  await command($, 'pins', 'clear')

  const answer = await pinWith($, 'u2', { text: 'Still open: Q2', replaces: 'p1' })

  expect(answer.result).toContain('p2')
  expect((await peek($)).map(one => one.claudeId)).toEqual(['p2'])
})

test('removing a pin that is already gone is not an error', async ($, on) => {
  await setup($, on)

  const answer = await pinWith($, 'u1', { text: '', replaces: 'p7' })

  expect(answer.deny).toBeUndefined()
  expect(answer.result).toContain('p7')
})

const sessionStarts = ($: Engine, source: 'startup' | 'resume' | 'clear' | 'fork', id: string) =>
  $.classic.SessionStart({ source, session_id: id, transcript_path: `/t/${id}.jsonl` } as Parameters<Engine['classic']['SessionStart']>[0])

const transcriptLine = (uuid: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('pins come back when the session is resumed, and Claude ids keep counting', { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)
  await sessionStarts($, 'startup', 's1')
  await pinWith($, 'u1', { text: 'Still open: Q2', kind: 'question' })

  await sessionStarts($, 'clear', 's2')
  expect(await peek($)).toEqual([])

  await sessionStarts($, 'resume', 's1')
  expect((await peek($)).map(one => [one.claudeId, one.text])).toEqual([['p1', 'Still open: Q2']])
  expect((await pinWith($, 'u2', { text: 'Deploy done' })).result).toContain('p2')
})

test('a board saved by an earlier process loads on resume', { plugins: [PEEK] }, async ($, on) => {
  const saved = { pins: [{ id: 'x', kind: 'question', text: 'Rebase onto main?', source: 'claude', at: 0, claudeId: 'p4' }], seq: 4, savedAt: 1 }
  await setup($, on, { 'board:s9': saved })

  await sessionStarts($, 'resume', 's9')

  expect((await peek($)).map(one => one.text)).toEqual(['Rebase onto main?'])
  expect((await pinWith($, 'u1', { text: 'Next' })).result).toContain('p5')
})

test("resuming rebuilds the reply index from the transcript, so old replies can be quoted", { plugins: [PEEK] }, async ($, on) => {
  const host = await setup($, on)
  host.files['/t/s1.jsonl'] = [transcriptLine('old-1', 'Should we keep the v1 endpoint?'), transcriptLine('old-2', 'Done.')].join('\n')

  await sessionStarts($, 'resume', 's1')
  await pinWith($, 'u1', { text: 'Still open: v1?', quote: 'keep the v1 endpoint' })

  expect((await peek($))[0]?.anchor).toEqual({ row: 'old-1', block: 'start' })
  expect(host.argvs).toEqual([])
})

test('a transcript too big to read whole is read from its end with tail', { plugins: [PEEK] }, async ($, on) => {
  const host = await setup($, on)
  host.files['/t/s1.jsonl'] = ['x'.repeat(100), transcriptLine('new-1', 'Keep v1?')].join('\n')
  host.sizes['/t/s1.jsonl'] = 9_000_000

  await sessionStarts($, 'resume', 's1')
  await pinWith($, 'u1', { text: 'Still open', quote: 'Keep v1?' })

  expect(host.argvs[0]?.[0]).toBe('tail')
  expect((await peek($))[0]?.anchor).toEqual({ row: 'new-1', block: 'start' })
})

test('an unreadable transcript leaves quotes to fall back, and nothing breaks', { plugins: [PEEK] }, async ($, on) => {
  await setup($, on)

  await sessionStarts($, 'resume', 's1')
  const answer = await pinWith($, 'u1', { text: 'Still open', quote: 'keep the v1 endpoint' })

  expect(answer.result).toContain("didn't match")
})

test('a session the mod missed starting is picked up at the end of a turn', { plugins: [PEEK] }, async ($, on) => {
  const saved = { pins: [{ id: 'x', kind: 'fyi', text: 'From before', source: 'claude', at: 0, claudeId: 'p1' }], seq: 1, savedAt: 1 }
  await setup($, on, { 'board:s7': saved })

  await $.classic.Stop({ session_id: 's7', transcript_path: '/t/s7.jsonl', stop_hook_active: false } as Parameters<Engine['classic']['Stop']>[0])

  expect((await peek($)).map(one => one.text)).toEqual(['From before'])
})
