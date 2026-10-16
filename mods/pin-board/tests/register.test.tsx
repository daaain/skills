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

// What the host saw the mod do, for assertions.
type Seen = {
  contexts: (readonly string[] | undefined)[]
  opened: string[]
  isPaneUp: boolean
}

// The engine's bottom of each chain the mods reach, standing in for a session.
const setup = async ($: Engine, on: On): Promise<Seen> => {
  const seen: Seen = { contexts: [], opened: [], isPaneUp: false }

  mock.clock(on, { now: Date.UTC(2026, 9, 16, 9, 30) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pin-board__${e.name}` } }))
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

const pin = ($: Engine, id: string, text: string, kind?: string) =>
  $.tool.call({ tool: PIN_TOOL, tool_use_id: id, text, kind } as Parameters<Engine['tool']['call']>[0])

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

test("an automatic pin anchors to the answer's message", { plugins: [PR_WATCH] }, async ($, on) => {
  await setup($, on)

  await wakeTurn($, 't1', 'CI failed on lint. Fix it?')

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
