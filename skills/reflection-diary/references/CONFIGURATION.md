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
| `REFLECTION_MAX_WINDOW_LINES` | `400` | Ceiling on digested lines per reflection. Older lines are elided with a marker rather than dropped silently. |

`PreCompact` and `SessionEnd` ignore both the interval and the minimum.

### The reflector

| Variable | Default | Notes |
|---|---|---|
| `REFLECTION_MODEL` | `claude-sonnet-5` | A weaker model gives a weaker judge; this is the main quality lever. |
| `REFLECTION_TIMEOUT` | `150` | Seconds before the reflector is killed. Observed runs take 20–30s. |
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
| `REFLECTION_DISABLED` | `0` | Kill switch. Hooks stay installed and do nothing. |
| `REFLECTION_DEBUG` | `0` | Log every decision to stderr. Visible under `claude --debug`. |
| `REFLECTION_DIARY_ACTIVE` | *(set internally)* | Recursion guard. Do not set by hand. |

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

**Cheap background journal**:

```json
{"env": {
  "REFLECTION_INTERVAL": "900",
  "REFLECTION_MODEL": "claude-haiku-4-5-20251001"
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
| `window too thin` | Fewer than `REFLECTION_MIN_LINES` digested lines. |
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
