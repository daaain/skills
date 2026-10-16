import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin, PinKind } from '../types'
import { autoPinFor, hasText, isBackgroundOrigin, parsePinsCommand, preview } from './pins'

const PIN_TOOL = 'mcp__pin-board__pin'
const PANE = 'pins'
const MAX_PINS = 50

const pins = atom({ plugin: 'pin-board', key: 'pins' } as const, [])
const expanded = atom({ plugin: 'pin-board', key: 'expanded' } as const, null)

const KIND_COLOR: Record<PinKind, string> = {
  question: 'warning',
  decision: 'suggestion',
  fyi: 'subtle',
  summary: 'inactive',
}

// Sent on every request, so it stays one line; the guidance rides on background prompts only.
const TOOL_DESCRIPTION = "Pin a one- or two-line note above the user's prompt so it isn't lost when the transcript scrolls."

const WAKE_CONTEXT = [
  'pin-board: this turn was started by a background event, not by the user typing.',
  `If something here needs the user's input or attention, call ${PIN_TOOL} with the question`,
  'or finding itself in one or two lines; it stays visible above their prompt. Skip routine',
  "all-clear updates. If you don't pin, a question or long summary in your final answer is pinned for you.",
].join(' ')

const USAGE = [
  'Usage:',
  '  /pins            list pins, newest first (and reopen the side pane in fullscreen)',
  '  /pins <n>        show pin n in full',
  '  /pins go <n>     scroll the transcript to where pin n came from (fullscreen)',
  '  /pins done <n>…  dismiss pins by number',
  '  /pins clear      dismiss every pin',
].join('\n')

const clockTime = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const isPinKind = (value: unknown): value is PinKind =>
  value === 'question' || value === 'decision' || value === 'fyi'

// Pins are stored oldest first; everything the person sees, and every number, is newest first.
const newestFirst = (list: readonly Pin[]) => [...list].reverse()

// Session bookkeeping outside $.state: a hot reload loses it, costing at most one auto-pin
// or anchor, and the fullscreen flag is learnt again on the next draw.
type Live = {
  pendingWake: boolean
  currentTurn: string | undefined
  lastTextRow: string | undefined
  isFullscreen: boolean
  isPaneClosedByPerson: boolean
  wakeTurns: Set<string>
  pinnedByClaude: Set<string>
}

const fresh = (): Live => ({
  pendingWake: false,
  currentTurn: undefined,
  lastTextRow: undefined,
  isFullscreen: false,
  isPaneClosedByPerson: false,
  wakeTurns: new Set(),
  pinnedByClaude: new Set(),
})

let live = fresh()

const openPane = async ($: EngineInterface, isAsked: boolean) => {
  if (isAsked) live.isPaneClosedByPerson = false
  if (!live.isFullscreen || live.isPaneClosedByPerson) return

  await $.ui.open({ id: PANE, title: 'Pins' })
  $.ui.invalidate('ui.render')
}

const addPin = async ($: EngineInterface, fields: Omit<Pin, 'id' | 'at'>) => {
  const at = await $.clock.now()
  const pin: Pin = { ...fields, id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at }
  await update($, pins, list => [...list, pin].slice(-MAX_PINS))
  await openPane($, false)
}

const removePins = async ($: EngineInterface, ids: ReadonlySet<string>) => {
  const left = await update($, pins, list => list.filter(pin => !ids.has(pin.id)))
  if (left.length === 0 && (await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
  }
}

const clearPins = async ($: EngineInterface) => removePins($, new Set((await read($, pins)).map(pin => pin.id)))

// Scrolls the transcript to where the pin came from; answers why not, or undefined once it moved.
// Only works in answer to the person's own press or command, and only where the transcript scrolls.
const jumpTo = async ($: EngineInterface, pin: Pin): Promise<string | undefined> => {
  if (pin.anchor === undefined) return 'That pin has no place in the transcript to jump to.'

  try {
    const moved = await $.ui.scroll({ to: { requestId: pin.anchor }, block: 'start' })
    return moved.deny === undefined ? undefined : `Couldn't scroll there: ${moved.deny}`
  } catch (error) {
    return `Couldn't scroll there: ${error instanceof Error ? error.message : String(error)}`
  }
}

// One pin's row: number, time, kind, preview, and its buttons. `isFull` shows the whole text.
const pinRow = ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], pin: Pin, n: number, open: string | null, isFull: boolean) => {
  const { Box, Button, Markdown, Text } = $.ui.resolve(e)
  const isOpen = isFull || open === pin.id
  const toggle = () => update($, expanded, current => (current === pin.id ? null : pin.id))
  const dismiss = () => removePins($, new Set([pin.id]))
  const jump = async () => {
    const why = await jumpTo($, pin)
    if (why !== undefined) $.ui.toast(`pin-board: ${why}`)
  }

  return (
    <Box key={`pin:${pin.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {isFull ? <Text dimColor>{n}</Text> : <Button key={`toggle:${pin.id}`} plain label={`${isOpen ? '▾' : '▸'}${n}`} onPress={toggle} />}
        <Text dimColor>{clockTime(pin.at)}</Text>
        <Text color={KIND_COLOR[pin.kind]}>{pin.kind}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{isFull ? '' : preview(pin.text)}</Text>
        </Box>
        {live.isFullscreen && pin.anchor !== undefined && (
          <Button key={`jump:${pin.id}`} plain label="↑ jump" onPress={jump} />
        )}
        <Button key={`dismiss:${pin.id}`} plain label="✕" onPress={dismiss} />
      </Box>
      {isOpen && (
        <Box paddingLeft={2} marginBottom={isFull ? 1 : 0}>
          <Markdown text={pin.text} />
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  live = fresh()

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'pin',
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What the user needs to see, in one or two lines.' },
          kind: { type: 'string', enum: ['question', 'decision', 'fyi'], description: 'Defaults to fyi.' },
        },
        required: ['text'],
      },
    })
    await $.command.register({
      name: 'pins',
      description: 'List, show, jump to or dismiss pinned notes',
      argumentHint: '[<n> | go <n> | done <n>… | clear]',
    })

    return next(e)
  })

  // The turn starts inside next(e), so the wake is marked before it.
  on('prompt.submit', async ($, e, next) => {
    const isWake = e.origin !== undefined && isBackgroundOrigin(e.origin)
    const passed = isWake ? { ...e, context: [...(e.context ?? []), WAKE_CONTEXT] } : e

    if (e.turnId !== undefined) {
      if (isWake) live.wakeTurns.add(e.turnId)
      return next(passed)
    }

    live.pendingWake = isWake
    const entered = await next(passed)
    if (entered.drop !== undefined) live.pendingWake = false

    return entered
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      live.currentTurn = e.turnId
      live.lastTextRow = undefined
      if (live.pendingWake) live.wakeTurns.add(e.turnId)
      live.pendingWake = false
    }

    return next(e)
  })

  // Remembers the main loop's latest text reply, the row an automatic pin jumps back to.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const isReply = e.door === 'response' && e.agentId === undefined && e.message.role === 'assistant'

    if (isReply && stored.uuid !== undefined && hasText(e.message.content)) live.lastTextRow = stored.uuid

    return stored
  })

  on('tool.call', { tool: PIN_TOOL }, async ($, e) => {
    const input = e as unknown as { text?: unknown; kind?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''

    if (text === '') {
      return { deny: 'pin needs a non-empty `text`.' }
    }

    const kind = isPinKind(input.kind) ? input.kind : 'fyi'
    await addPin($, { kind, text, source: 'claude', anchor: e.tool_use_id })
    if (e.agentId === undefined && live.currentTurn !== undefined) live.pinnedByClaude.add(live.currentTurn)

    return { result: 'Pinned above the prompt.' }
  })

  // A permission prompt mid-wake would be the very interruption this mod exists to avoid.
  // Pinning only writes session state, so approve it, but keep a deny the person set.
  on('tool.check', { tool: PIN_TOOL }, async ($, e, next) => {
    const verdict = await next(e)
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'pin-board: pinning only writes session state' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      const isWake = live.wakeTurns.delete(e.turnId)
      const isPinned = live.pinnedByClaude.delete(e.turnId)
      if (live.currentTurn === e.turnId) live.currentTurn = undefined

      const auto = isWake && !isPinned && e.reason === 'answer' ? autoPinFor(e.answer) : null
      if (auto !== null) await addPin($, { ...auto, source: 'auto', anchor: live.lastTextRow })
    }

    return done
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') live.isPaneClosedByPerson = true
    $.ui.invalidate('ui.render')
    return closed
  })

  on('command.run', { command: 'pins' }, async ($, e) => {
    const parsed = parsePinsCommand(e.args)
    const list = newestFirst(await read($, pins))
    const at = (n: number) => list[n - 1]
    const missing = (n: number) => `No pin ${n}. There ${list.length === 1 ? 'is 1' : `are ${list.length}`}.`

    switch (parsed.action) {
      case 'usage':
        return { text: USAGE }
      case 'clear':
        await clearPins($)
        return { text: 'Cleared all pins.' }
      case 'show': {
        const pin = at(parsed.n)
        return { text: pin === undefined ? missing(parsed.n) : `${pin.kind} · ${clockTime(pin.at)}\n\n${pin.text}` }
      }
      case 'go': {
        const pin = at(parsed.n)
        return { text: pin === undefined ? missing(parsed.n) : ((await jumpTo($, pin)) ?? 'Scrolled to the pin.') }
      }
      case 'done': {
        const bad = parsed.ns.find(n => at(n) === undefined)
        if (bad !== undefined) return { text: missing(bad) }

        await removePins($, new Set(parsed.ns.map(n => at(n)!.id)))
        return { text: `Dismissed ${parsed.ns.length === 1 ? 'pin' : 'pins'} ${parsed.ns.join(', ')}.` }
      }
      case 'list':
        if (list.length === 0) return { text: 'No pins.' }
        await openPane($, true)
        return { text: list.map((pin, i) => `${i + 1}. [${clockTime(pin.at)}] ${pin.kind}: ${pin.text}`).join('\n\n') }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    live.isFullscreen = e.viewport?.isFullscreen === true
    const list = newestFirst(await read($, pins))

    if (e.props.hasSurvey || list.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isDocked = live.isFullscreen && (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)

    if (isDocked) {
      return <Text dimColor>📌 {list.length} pinned in the side pane · /pins for commands</Text>
    }

    const open = await read($, expanded)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text weight="bold">📌 Pinned ({list.length})</Text>
          <Button key="clear-all" plain label="clear all" onPress={() => clearPins($)} />
        </Box>
        {list.map((pin, i) => pinRow($, e, pin, i + 1, open, false))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = newestFirst(await read($, pins))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text weight="bold">{list.length === 0 ? 'No pins.' : `${list.length} pinned, newest first`}</Text>
          {list.length > 0 && <Button key="clear-all" plain label="clear all" onPress={() => clearPins($)} />}
        </Box>
        {list.map((pin, i) => pinRow($, e, pin, i + 1, null, true))}
      </Box>
    )
  })
}
