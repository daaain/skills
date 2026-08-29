# Configuration

Every setting is an environment variable, so it can go anywhere Claude Code
reads environment from.

## Where to put settings

Per project, in `.claude/settings.json`:

```json
{
  "env": {
    "REFLECTION_INTERVAL": "180",
    "REFLECTION_WAKE_ON_ALERT": "1"
  }
}
```

Globally, in `~/.claude/settings.json` under the same `env` key, or exported
from your shell profile.

## All variables

### Cadence

| Variable | Default | Notes |
|---|---|---|
| `REFLECTION_INTERVAL` | `300` | Seconds between reflections. Below ~120 you are paying for windows too thin to show a shape. |
| `REFLECTION_MIN_LINES` | `4` | Skip the model call when the window has fewer digested lines than this. The clock still advances. |
| `REFLECTION_MIN_TURNS` | `2` | Skip the model call when fewer assistant turns than this have elapsed. Turns are the better unit — one turn with forty tool calls is one decision, not forty. |
| `REFLECTION_MAX_WINDOW_LINES` | `400` | Ceiling on digested lines per reflection. Older lines are elided with a marker rather than dropped silently. |

`PreCompact` and `SessionEnd` ignore both the interval and the minimum.

### The reflector

| Variable | Default | Notes |
|---|---|---|
| `REFLECTION_MODEL` | `claude-sonnet-5` | A weaker model gives a weaker judge; this is the main quality lever. |
| `REFLECTION_TIMEOUT` | `150` | Seconds before the reflector is killed. Observed runs take 15–30s. |
| `REFLECTION_EFFORT` | *(unset)* | `low`…`max`, or `match` to inherit the observed session's own effort level from the hook payload. `low` cuts thinking tokens, the second-largest cost line. See the caveat below. |
| `REFLECTION_BARE` | `0` | Use `--bare`. Faster start, but **requires `ANTHROPIC_API_KEY`** — bare mode reads neither OAuth credentials nor the keychain. |
| `REFLECTION_INCLUDE_THINKING` | `1` | Include thinking text when present. Currently a no-op: Claude Code does not persist it. |

### Storage

| Variable | Default | Notes |
|---|---|---|
| `REFLECTION_DIARY_HOME` | `~/.claude/reflection-diary` | Refuses to run if this resolves inside the observed project. |

Layout:

```
~/.claude/reflection-diary/
├── ALERTS.md                        # every concern and alert, all projects
└── <project>-<hash>/
    ├── <session-id>.md              # the diary
    └── <session-id>.state.json      # cursor, last run, entry count
```

### Escalation

| Variable | Default | Notes |
|---|---|---|
| `REFLECTION_WAKE_ON_ALERT` | `0` | Exit 2 on `alert` under `asyncRewake`, waking the main agent. |
| `REFLECTION_ALERT_CMD` | *(unset)* | Shell command run on `concern` and above. |

Without `REFLECTION_ALERT_CMD` the script falls back to `osascript` on macOS
or `notify-send` on Linux, and does nothing if neither exists. `ALERTS.md` is
always written.

The command receives:

| Variable | Contents |
|---|---|
| `REFLECTION_SEVERITY` | `concern` or `alert` |
| `REFLECTION_SUMMARY` | The note to operator, or the headline |
| `REFLECTION_KINDS` | Comma-separated concern kinds |
| `REFLECTION_SESSION` | Session id |
| `REFLECTION_PROJECT` | Observed project path |
| `REFLECTION_DIARY` | Path to the diary file |

Slack example:

```bash
export REFLECTION_ALERT_CMD='curl -s -X POST "$SLACK_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "[$REFLECTION_SEVERITY] $REFLECTION_PROJECT" \
             --arg s "$REFLECTION_SUMMARY" \
             "{text: (\$t + \"\\n\" + \$s)}")"'
```

### Truncation

Tool traffic is most of a transcript and most of it is noise at this altitude.

| Variable | Default |
|---|---|
| `REFLECTION_TRUNC_TOOL_INPUT` | `220` |
| `REFLECTION_TRUNC_TOOL_RESULT` | `260` |
| `REFLECTION_TRUNC_THINKING` | `500` |
| `REFLECTION_TRUNC_TEXT` | `900` |

Human turns are clipped at 2000 characters and never below that: they are the
only authority on intent.

### Operations

| Variable | Default | Notes |
|---|---|---|
| `REFLECTION_EXTRA_DENY` | *(unset)* | Comma-separated extra tool names to deny the reflector, for environments with custom tools. |
| `REFLECTION_DISABLED` | `0` | Kill switch. Hooks stay installed and do nothing. |
| `REFLECTION_DEBUG` | `0` | Log every decision to stderr. Visible under `claude --debug`. |
| `REFLECTION_DIARY_ACTIVE` | *(set internally)* | Recursion guard. Do not set by hand. |

## Cost accounting

Every reflection appends a row to `<session>.usage.jsonl`:

```json
{"ts": "...", "event": "Stop", "entry": 2, "window_lines": 10, "turns": 6,
 "ok": true, "model": "claude-sonnet-5", "input": 2, "cache_write": 12094,
 "cache_read": 33925, "output": 1300, "thinking": 797, "cost_usd": 0.073422,
 "api_ms": 16259, "prompt_chars": 14328}
```

`review.py --cost` aggregates it, and — because the state file records the
observed session's transcript path — compares against that session's own token
totals to give a real overhead percentage.

### Where the money actually goes

Measured on Sonnet 5 with a ten-line window:

| Component | Tokens | Share of cost |
|---|---|---|
| Harness (system prompt), cached read | ~4,300 | ~5% |
| Rubric + digest, written to 1h cache every call | ~4,000 | ~40% |
| Output, including thinking | ~2,200 | ~55% |

(Before every tool was denied by name, the harness was ~34,000 tokens and the
whole call cost $0.077 rather than $0.041. Removing the tool definitions cut
input tokens by 80% and made output the dominant term.)

The counter-intuitive part: the 34k of Claude Code harness you cannot get rid
of is *cheap*, because it is a stable prefix that caches at ~$0.20/MTok. The
expensive part is the small, varying tail, because it is written to cache at
2× input price on every call and never read back — no two reflections share a
prompt.

Practical consequences:

- **A shorter interval is not proportionally more expensive.** Half the
  interval means half the window, so the dominant cache-write term barely
  moves. Don't stretch the interval purely to save money.
- **`REFLECTION_EFFORT=low` is a real saving** — output is ~18% of the bill and
  most of it is thinking tokens.
- **`REFLECTION_MODEL` matters most**, since every term above scales with the
  model's input and output price.

### Getting the harness out of the prompt

Already done: denying every tool by name drops the prefix from 41,515 to
8,516 tokens. What remains is the Claude Code system prompt itself.

`--bare` (`REFLECTION_BARE=1`) would trim further but needs
`ANTHROPIC_API_KEY` — bare mode reads neither OAuth credentials nor the
keychain, so on a subscription it fails with an authentication error.
`--system-prompt` with `--exclude-dynamic-system-prompt-sections` saves a few
percent more and costs you the default system prompt; rarely worth it now.

### Inheriting the parent's effort

The hook payload carries the observed session's effort level:

```json
{"hook_event_name": "Stop", "effort": {"level": "high"}, ...}
```

`REFLECTION_EFFORT=match` passes it through, on the theory that a session
thinking hard is one worth watching closely. An unrecognised or absent level
falls back to the CLI default rather than guessing.

The catch is that **every effort change starts a new cache namespace.** A
measured example: switching a warm Sonnet 5 reflector from its default to
`low` turned a call that would have read ~34k cached tokens into one that
wrote 79,369 — $0.355 instead of ~$0.07. So `match` costs one cold start each
time the observed session changes effort (`/effort`, or a mode switch). If the
session's effort is stable, `match` is free; if someone rides the effort
control, pin a fixed level instead.

The chosen level is recorded per row in the usage ledger, so the cost of a
switch is visible after the fact.

### Verifying the cache is working

`cache hit rate` in `--cost` is `cache_read / (cache_read + cache_write +
input)`. Expect roughly 70–75% steady state. If it collapses toward zero,
something is invalidating the prefix — most likely a changed
`REFLECTION_MODEL` or `REFLECTION_EFFORT`, or a gap longer than the cache TTL.

## Thinking

The reflector cannot read the observed agent's reasoning: Claude Code writes a
thinking block's `signature` to the transcript but leaves `thinking` empty.

Settings that control thinking in the observed session:

| Setting | Where | Effect |
|---|---|---|
| `alwaysThinkingEnabled` | `settings.json` | Extended thinking on or off for every session. |
| `showThinkingSummaries` | `settings.json` | Show summaries rather than a collapsed stub. |
| `MAX_THINKING_TOKENS` | env var | `0` disables; a positive value enables even where thinking is off. Takes precedence over the setting. |
| `--thinking disabled` | CLI flag | Per-run override. |

These govern whether thinking *happens* and whether the UI *displays* it.
Whether any of them causes the text to be **persisted to the JSONL** is a
separate question, and on the version tested here it was empty regardless.
Check your own with:

```bash
jq -r 'select(.type=="assistant") | .message.content[]?
  | select(.type=="thinking") | (.thinking|length)' \
  ~/.claude/projects/<slug>/<session>.jsonl | sort -u
```

All zeros means the text is not persisted and `REFLECTION_INCLUDE_THINKING`
has nothing to work with. A non-zero length means it is available, and the
digest will start including it (truncated to
`REFLECTION_TRUNC_THINKING`) with no other change.

## Recipes

**Unattended / overnight runs** — tighter cadence, wake on alert:

```json
{"env": {
  "REFLECTION_INTERVAL": "180",
  "REFLECTION_WAKE_ON_ALERT": "1",
  "REFLECTION_ALERT_CMD": "/usr/local/bin/page-me.sh"
}}
```

**Building an eval corpus** — dense labels, never interrupt:

```json
{"env": {
  "REFLECTION_INTERVAL": "120",
  "REFLECTION_MIN_LINES": "2",
  "REFLECTION_WAKE_ON_ALERT": "0"
}}
```

**Cheap background journal** — model and effort are the levers that matter,
not the interval:

```json
{"env": {
  "REFLECTION_INTERVAL": "600",
  "REFLECTION_MODEL": "claude-haiku-4-5",
  "REFLECTION_EFFORT": "low"
}}
```

## Troubleshooting

Turn on debugging first — it names the reason for every early exit:

```bash
REFLECTION_DEBUG=1 claude --debug
```

| Symptom | Cause |
|---|---|
| `throttled (Ns < Ms)` | Normal. This is the mechanism working. |
| `window too thin (N lines, M turns)` | Below `REFLECTION_MIN_LINES` or `REFLECTION_MIN_TURNS`. |
| `re-entrant invocation` | The reflector's own child tried to reflect. Guard working. |
| `another reflection in flight` | Lock held. Stale locks break after 15 minutes. |
| `claude executable not on PATH` | Hooks run with a minimal environment; use an absolute path or fix `PATH`. |
| `reflector exit 1` with auth errors | `REFLECTION_BARE=1` without `ANTHROPIC_API_KEY`. |
| `refusing to write inside the project` | `REFLECTION_DIARY_HOME` resolves inside the repo. Move it. |
| No entries and no debug output at all | Hook not registered — check `/hooks` and run `/reload-plugins`. |

To verify the pipeline by hand against a real transcript:

```bash
jq -nc --arg t ~/.claude/projects/<slug>/<session>.jsonl \
  '{hook_event_name:"Stop", session_id:"manual",
    transcript_path:$t, cwd:"'"$PWD"'"}' \
| REFLECTION_INTERVAL=0 REFLECTION_DEBUG=1 \
  python3 scripts/reflect.py
```
