export type PinKind = 'question' | 'decision' | 'fyi' | 'summary'

export type Pin = {
  id: string
  kind: PinKind
  text: string
  // 'claude' when the model pinned it with the tool, 'auto' when a background turn's answer was caught.
  source: 'claude' | 'auto'
  // Epoch milliseconds from $.clock.now().
  at: number
  // The id Claude updates or removes it by (`p1`, `p2`, ...); only on pins Claude made.
  claudeId?: string
  anchor?: PinAnchor
}

// Where a jump scrolls the transcript: a row by its id, and which edge of the screen it lands on.
// `start` for a reply the pin quotes (read from its top); `end` for the pin call itself, so
// what led up to it shows above.
export type PinAnchor = { row: string; block: 'start' | 'end' }

declare module 'claude-code' {
  interface PluginState {
    'pin-board': { pins: Pin[]; expanded: string | null; seq: number }
  }
}
