# pin-board

A Claude Code mod that keeps what matters from **background-woken turns** pinned above the prompt.

When Claude is watching a PR, running a Monitor, waiting on subagents or looping with `/loop` / ScheduleWakeup, each wake-up ends with a summary or a question. The transcript scrolls past it and it's easy to miss. pin-board catches those and pins them (in a side pane in fullscreen, above the prompt otherwise) until you dismiss them.

```
📌 Pinned (2) clear all
▸1 10:05 summary   CI is green on all three branches; two reviewers approved…  ↑ jump ✕
▸2 09:41 question  PR #42 got a review: rename the helper or keep it?          ↑ jump ✕
```

## How it decides what to pin

It works in two layers:

1. **Automatic (safety net).** When a turn was started by something other than you (a task notification, a scheduled trigger, another session, a channel, another plugin), its final answer is pinned if it:
   - asks a question: a line ending in `?`, outside code fences; or
   - is at least 280 characters, so it reads as a summary rather than an all-clear.

   Short "nothing new, still watching" answers are skipped. Turns you started yourself are never auto-pinned.
2. **Claude-driven (curated).** Claude gets a `pin` tool (`mcp__pin-board__pin`, with `text` and `kind` set to `question`, `decision` or `fyi`), approved without a permission prompt unless you deny it. Its description is one line, so it costs little on every request. The guidance on *when* to pin is attached only to prompts that come from background events, which is where it matters. When Claude pins during such a turn, the automatic pin for that turn is skipped.

## Where pins show

- **Fullscreen:** a new pin opens a **Pins** pane docked beside the transcript, running from the top of the screen to the bottom, with every pin in full, newest first. The band above the prompt shrinks to one line. If you close the pane, it stays closed until you run `/pins`. The mod opens the pane itself only on a terminal at least 144 columns wide; `/pins` opens it at any width.
- **Elsewhere:** pins show in the band above the prompt, newest first, one line each. ▸ expands a pin to its full text, rendered as Markdown.

Pins never disappear on their own. Pins last for the session and survive a hot reload of the mod. They don't carry over to a new session.

## Keyboard

Pins are numbered newest first, and `/pins` runs at once, even while Claude is working:

| Command | Does |
|---|---|
| `/pins` | Lists the pins, and reopens the side pane in fullscreen |
| `/pins <n>` | Shows pin *n* in full |
| `/pins go <n>` | Scrolls the transcript to where pin *n* came from |
| `/pins done <n>…` | Dismisses pins by number, e.g. `/pins done 1 3` |
| `/pins clear` | Dismisses every pin |

The buttons are also reachable from the keyboard: press `ctrl+x tab` to put focus on the band or pane, then Tab between buttons, Enter to press one, and Esc to go back to the prompt.

## Jumping back to the transcript

**↑ jump** (or `/pins go <n>`) scrolls the transcript to where the pin came from:

- for Claude's pins, the `pin` tool call's row;
- for automatic pins, the turn's last text reply.

It only works in fullscreen, where Claude Code scrolls the transcript itself; on the normal screen your terminal owns the scrollback. Claude Code only moves the transcript when you ask, by a press or a typed command. If it can't move there (for example, the row is folded into a collapsed tool group), a toast says why.

## Install

At the prompt of a terminal session:

```
/plugin install pin-board --marketplace daaain/skills
```

To try it from a clone without installing:

```bash
claude --plugin-dir ./mods/pin-board
```

## Develop

```bash
claude plugin validate mods/pin-board   # what it hooks and calls
claude plugin test mods/pin-board       # unit + integration tests
```

- `hooks/pins.ts` holds the pure logic: origin classification, the question and summary heuristics, previews, and `/pins` argument parsing.
- `hooks/register.tsx` holds the hooks: turn tracking, the `pin` tool and its wake-only guidance, `/pins`, the `AbovePrompt` band and the `Pins` pane.
- `types/index.d.ts` is the `$.state` contract.
