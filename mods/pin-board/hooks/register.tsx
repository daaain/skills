import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin, PinAnchor, PinKind } from '../types'
import {
  autoPinFor,
  boardsToPrune,
  cellWidth,
  findQuoted,
  fitTo,
  isBackgroundOrigin,
  parsePinsCommand,
  preview,
  repliesFromTranscript,
  replyWindow,
  textOf,
} from './pins'

const PIN_TOOL = 'mcp__pin-board__pin'
const PANE = 'pins'
const MAX_PINS = 50
// Recent replies kept for matching a pin's quote; older questions fall back to the pin's own call.
const MAX_REPLIES = 200
// Boards of this many recent sessions stay in the store, for resuming them.
const MAX_BOARDS = 50
const BOARD_PREFIX = 'board:'
// $.fs.read takes a file up to 4 MiB.
const MAX_WHOLE_READ = 4 * 1024 * 1024

const pins = atom({ plugin: 'pin-board', key: 'pins' } as const, [])
const expanded = atom({ plugin: 'pin-board', key: 'expanded' } as const, null)
// The last `p<n>` id handed to Claude, in state so a hot reload never hands one out twice.
const seq = atom({ plugin: 'pin-board', key: 'seq' } as const, 0)
// Which session the board belongs to, and its transcript; in state so a hot reload keeps both.
const session = atom({ plugin: 'pin-board', key: 'session' } as const, null)

// Each wide by default, so no terminal draws one a cell short.
const KIND_EMOJI: Record<PinKind, string> = {
  question: '❓',
  decision: '🔀',
  fyi: '💡',
  summary: '📝',
}
const EMOJI_CELLS = 2
// What a band row's buttons take on its right: a gap, `↑ jump` and a gap where it shows, and `✕`.
const JUMP_CELLS = 7
const DISMISS_CELLS = 2

// Sent on every request, so it stays one sentence; the wake guidance rides on background prompts only,
// and how to update a pin is in each call's result.
const TOOL_DESCRIPTION =
  "Pin a one- or two-line note above the user's prompt so it isn't lost when the transcript scrolls, such as questions of yours the user hasn't answered yet."

const WAKE_CONTEXT = [
  'pin-board: this turn was started by a background event, not by the user typing.',
  `If something here needs the user's input or attention, call ${PIN_TOOL} with the question`,
  'or finding itself in one or two lines; it stays visible above their prompt. Skip routine',
  "all-clear updates. If you don't pin, a question or long summary in your final answer is pinned for you.",
].join(' ')

// A standing instruction, so it lives in the system prompt (cached) rather than in every turn.
const NUMBERING_HINT =
  'pin-board: when you ask the user several questions in one message, number them (1., 2., ...) so they can answer by number; pin any they leave unanswered.'

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
  replies: { uuid: string; text: string }[]
  isFullscreen: boolean
  isPaneClosedByPerson: boolean
  wakeTurns: Set<string>
  pinnedByClaude: Set<string>
}

const fresh = (): Live => ({
  pendingWake: false,
  currentTurn: undefined,
  lastTextRow: undefined,
  replies: [],
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

type Board = { pins: Pin[]; seq: number; savedAt: number }

const isBoard = (value: unknown): value is Board =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as Board).pins) &&
  typeof (value as Board).seq === 'number' &&
  typeof (value as Board).savedAt === 'number'

// Writes the board under its session, so `claude --resume` brings it back.
const saveBoard = async ($: EngineInterface) => {
  const id = (await read($, session))?.id ?? (await $.session.id())
  const board: Board = { pins: await read($, pins), seq: await read($, seq), savedAt: await $.clock.now() }
  await $.store.set(`${BOARD_PREFIX}${id}`, board)
}

// Every change to the pins goes through here, so the store never lags behind.
const changePins = async ($: EngineInterface, change: (list: Pin[]) => Pin[]) => {
  const changed = await update($, pins, change)
  await saveBoard($)
  return changed
}

// Rebuilds the reply index that quotes match against, from the whole transcript: grep streams
// just the reply lines, whatever the file's size. Without grep, a file small enough is read whole.
const restoreReplies = async ($: EngineInterface, transcriptPath: string) => {
  try {
    const window = replyWindow(MAX_REPLIES)
    for await (const piece of $.process.spawn({ argv: ['grep', '-F', '"type":"assistant"', transcriptPath] })) {
      if (piece.stream === 'stdout') window.push(piece.text)
    }
    live.replies = window.end()
    if (live.replies.length > 0) return
  } catch {
    // No grep here: try reading the file whole.
  }

  try {
    if ((await $.fs.stat(transcriptPath)).size <= MAX_WHOLE_READ) {
      live.replies = repliesFromTranscript(await $.fs.read(transcriptPath), false).slice(-MAX_REPLIES)
    }
  } catch {
    // No transcript yet, or one the mod can't read: quotes fall back to the pin call.
  }
}

const pruneBoards = async ($: EngineInterface) => {
  const keys = (await $.store.keys()).filter(key => key.startsWith(BOARD_PREFIX))
  if (keys.length <= MAX_BOARDS) return

  const boards = await Promise.all(
    keys.map(async key => {
      const board = await $.store.get(key)
      return { key, savedAt: isBoard(board) ? board.savedAt : 0 }
    }),
  )
  for (const key of boardsToPrune(boards, MAX_BOARDS)) await $.store.delete(key)
}

// Moves the board to the session now running: a resume brings its pins back, a new session or
// a /clear starts empty, and the board left behind stays stored under its own id.
const joinSession = async ($: EngineInterface, id: string, transcriptPath: string) => {
  if ((await read($, session))?.id === id) return

  const stored = await $.store.get(`${BOARD_PREFIX}${id}`)
  const board = isBoard(stored) ? stored : undefined
  await update($, session, () => ({ id, transcriptPath }))
  await update($, pins, () => board?.pins ?? [])
  await update($, seq, () => board?.seq ?? 0)
  await update($, expanded, () => null)
  live = { ...fresh(), isFullscreen: live.isFullscreen }

  await restoreReplies($, transcriptPath)
  if (board !== undefined && board.pins.length > 0) await openPane($, false)
  else if ((await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE })
  await pruneBoards($)
}

const addPin = async ($: EngineInterface, fields: Omit<Pin, 'id' | 'at'>) => {
  const at = await $.clock.now()
  const pin: Pin = { ...fields, id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at }
  await changePins($, list => [...list, pin].slice(-MAX_PINS))
  await openPane($, false)
}

const removePins = async ($: EngineInterface, ids: ReadonlySet<string>) => {
  const left = await changePins($, list => list.filter(pin => !ids.has(pin.id)))
  if (left.length === 0 && (await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
  }
}

const clearPins = async ($: EngineInterface) => removePins($, new Set((await read($, pins)).map(pin => pin.id)))

// A quoted earlier reply, read from its top; else the pin call itself at the screen's foot,
// so the questions and the person's answer that led to it show above.
const anchorFor = (quote: string | undefined, toolUseId: string): PinAnchor => {
  const row = quote === undefined ? undefined : findQuoted(live.replies, quote)
  return row === undefined ? { row: toolUseId, block: 'end' } : { row, block: 'start' }
}

// Scrolls the transcript to where the pin came from; answers why not, or undefined once it moved.
// Only works in answer to the person's own press or command, and only where the transcript scrolls.
const jumpTo = async ($: EngineInterface, pin: Pin): Promise<string | undefined> => {
  if (pin.anchor === undefined) return 'That pin has no place in the transcript to jump to.'

  try {
    const moved = await $.ui.scroll({ to: { requestId: pin.anchor.row }, block: pin.anchor.block })
    return moved.deny === undefined ? undefined : `Couldn't scroll there: ${moved.deny}`
  } catch (error) {
    return `Couldn't scroll there: ${error instanceof Error ? error.message : String(error)}`
  }
}

type RenderSite = Parameters<EngineInterface['ui']['resolve']>[0]

// One pin's row: number, time, kind and, in the band, a preview cut to the `columns` left, all of
// it one button that expands the pin; then its own buttons. `isFull` shows the whole text below.
const pinRow = ($: EngineInterface, e: RenderSite, pin: Pin, n: number, open: string | null, isFull: boolean, columns: number) => {
  const { Box, Button, Markdown, Text } = $.ui.resolve(e)
  const isOpen = isFull || open === pin.id
  const hasJump = live.isFullscreen && pin.anchor !== undefined
  const toggle = () => update($, expanded, current => (current === pin.id ? null : pin.id))
  const dismiss = () => removePins($, new Set([pin.id]))
  const jump = async () => {
    const why = await jumpTo($, pin)
    if (why !== undefined) $.ui.toast(`pin-board: ${why}`)
  }

  const head = `${isFull ? '' : isOpen ? '▾' : '▸'}${n} ${clockTime(pin.at)}`
  const room = columns - cellWidth(head) - 1 - EMOJI_CELLS - 1 - (hasJump ? JUMP_CELLS : 0) - DISMISS_CELLS
  const lead = isFull ? (
    <Box flexShrink={0}>
      <Text dimColor>{head}</Text>
      <Text> {KIND_EMOJI[pin.kind]}</Text>
    </Box>
  ) : (
    <Button key={`toggle:${pin.id}`} plain onPress={toggle}>
      <Text dimColor>{head}</Text>
      {` ${KIND_EMOJI[pin.kind]} ${fitTo(preview(pin.text), room)}`}
    </Button>
  )

  return (
    <Box key={`pin:${pin.id}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        {lead}
        <Box flexDirection="row" flexShrink={0} gap={1}>
          {hasJump && <Button key={`jump:${pin.id}`} plain label="↑ jump" onPress={jump} />}
          <Button key={`dismiss:${pin.id}`} plain label="✕" onPress={dismiss} />
        </Box>
      </Box>
      {isOpen && (
        <Box paddingLeft={2} marginBottom={isFull ? 1 : 0}>
          <Markdown text={pin.text} />
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  live = fresh()

  if (options.numberQuestions !== false) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      return { ...composed, sections: [...composed.sections, { id: 'pin-board', text: NUMBERING_HINT, scope: 'session' }] }
    })
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'pin',
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'What the user needs to see, in one or two lines. Empty with `replaces` removes that pin.',
          },
          kind: { type: 'string', enum: ['question', 'decision', 'fyi'], description: 'Defaults to fyi.' },
          quote: {
            type: 'string',
            description: "A short exact excerpt of your earlier message this is about, so the pin's jump goes there.",
          },
          replaces: { type: 'string', description: 'The id (`p1`) of your earlier pin to update or, with empty text, remove.' },
        },
        required: ['text'],
      },
    })
    await $.command.register({
      name: 'pins',
      description: 'List, show, jump to or dismiss pinned notes',
      argumentHint: '[<n> | go <n> | done <n>… | clear]',
    })

    // After a hot reload the board is still in $.state, but the reply index went with the module.
    const current = await read($, session)
    if (current !== null) await restoreReplies($, current.transcriptPath)

    return next(e)
  })

  // Startup, resume, /clear and fork each start a session: the board follows its id.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    await joinSession($, e.session_id, e.transcript_path)
    return done
  })

  // Safety nets for a session the mod saw no start of (installed or enabled mid-session, or
  // switched mid-process): the person's next prompt, early enough for Claude's pins that turn,
  // and the end of any turn.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const done = await next(e)
    await joinSession($, e.session_id, e.transcript_path)
    return done
  })

  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    await joinSession($, e.session_id, e.transcript_path)
    return done
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

  // Indexes the main loop's text replies: the rows a pin's quote and an automatic pin jump back to.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const isReply = e.door === 'response' && e.agentId === undefined && e.message.role === 'assistant'
    const text = isReply ? textOf(e.message.content) : ''

    if (stored.uuid !== undefined && text.trim() !== '') {
      live.lastTextRow = stored.uuid
      live.replies = [...live.replies, { uuid: stored.uuid, text }].slice(-MAX_REPLIES)
    }

    return stored
  })

  on('tool.call', { tool: PIN_TOOL }, async ($, e) => {
    const input = e as unknown as { text?: unknown; kind?: unknown; quote?: unknown; replaces?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const kind = isPinKind(input.kind) ? input.kind : undefined
    const quote = typeof input.quote === 'string' && input.quote.trim() !== '' ? input.quote : undefined
    const replaces = typeof input.replaces === 'string' && input.replaces.trim() !== '' ? input.replaces.trim() : undefined
    const existing = replaces === undefined ? undefined : (await read($, pins)).find(pin => pin.claudeId === replaces)

    if (text === '') {
      if (replaces === undefined) return { deny: 'pin needs a non-empty `text`, or `replaces` to remove a pin.' }
      if (existing !== undefined) await removePins($, new Set([existing.id]))
      return { result: existing === undefined ? `${replaces} was already gone.` : `Removed ${replaces}.` }
    }

    const anchor = anchorFor(quote, e.tool_use_id)
    const isQuoteMissed = quote !== undefined && anchor.block === 'end'
    const missed = isQuoteMissed ? " The quote didn't match any of your recent replies, so its jump goes to this call instead." : ''
    if (e.agentId === undefined && live.currentTurn !== undefined) live.pinnedByClaude.add(live.currentTurn)

    if (existing !== undefined) {
      // An update stays where the questions were asked unless it quotes somewhere new.
      const kept = quote === undefined || isQuoteMissed ? (existing.anchor ?? anchor) : anchor
      await changePins($, list =>
        list.map(pin => (pin.id === existing.id ? { ...pin, text, kind: kind ?? pin.kind, anchor: kept } : pin)),
      )
      return { result: `Updated ${replaces}.${missed}` }
    }

    const claudeId = `p${await update($, seq, n => n + 1)}`
    await addPin($, { kind: kind ?? 'fyi', text, source: 'claude', claudeId, anchor })
    const gone = replaces === undefined ? '' : `${replaces} was already dismissed, so this is a new pin. `

    return {
      result: `${gone}Pinned as ${claudeId}. To update it later, call pin with replaces: "${claudeId}" and the new text; with empty text to remove it.${missed}`,
    }
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
      const anchor: PinAnchor | undefined = live.lastTextRow === undefined ? undefined : { row: live.lastTextRow, block: 'start' }
      if (auto !== null) await addPin($, { ...auto, source: 'auto', anchor })
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
          {live.isFullscreen && <Button key="open-pane" plain label="open side pane" onPress={() => openPane($, true)} />}
        </Box>
        {list.map((pin, i) => pinRow($, e, pin, i + 1, open, false, e.props.bodyColumns))}
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
        {list.map((pin, i) => pinRow($, e, pin, i + 1, null, true, e.props.bodyColumns))}
      </Box>
    )
  })
}
