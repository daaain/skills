export type PinKind = 'question' | 'decision' | 'fyi' | 'summary'

export type Pin = {
  id: string
  kind: PinKind
  text: string
  // 'claude' when the model pinned it with the tool, 'auto' when a background turn's answer was caught.
  source: 'claude' | 'auto'
  // Epoch milliseconds from $.clock.now().
  at: number
  // The transcript row to scroll to: the pin tool's tool_use_id, or the answer message's uuid.
  anchor?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pin-board': { pins: Pin[]; expanded: string | null }
  }
}
