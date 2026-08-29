#!/usr/bin/env python3
"""Read back reflection diaries.

  review.py                 recent entries across all projects
  review.py --alerts        only concern and alert entries
  review.py --project .     one project
  review.py --sessions      one line per session, newest first
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reflect import DIARY_HOME, project_slug  # noqa: E402

ENTRY = re.compile(r"^## (?=\d{2}:\d{2} · entry )", re.MULTILINE)
FLAGGED = ("🛑", "⚠")


def diaries(project: str | None) -> list[Path]:
    root = DIARY_HOME
    if project:
        root = root / project_slug(project)
    if not root.exists():
        return []
    found = [p for p in root.rglob("*.md") if p.name != "ALERTS.md"]
    return sorted(found, key=lambda p: p.stat().st_mtime, reverse=True)


def entries(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    chunks = ENTRY.split(text)
    return [("## " + c).rstrip() for c in chunks[1:]]


def read_ledger(diary: Path) -> list[dict]:
    ledger = diary.parent / (diary.stem + ".usage.jsonl")
    rows = []
    try:
        for line in ledger.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    except OSError:
        pass
    return rows


def session_tokens(diary: Path) -> dict | None:
    """Token totals for the observed session, read from its own transcript."""
    state = diary.parent / (diary.stem + ".state.json")
    try:
        transcript = Path(json.loads(state.read_text(encoding="utf-8"))["transcript"])
    except (OSError, ValueError, KeyError):
        return None

    totals = {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "turns": 0}
    try:
        with transcript.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") != "assistant":
                    continue
                use = (entry.get("message") or {}).get("usage") or {}
                totals["turns"] += 1
                totals["input"] += use.get("input_tokens", 0)
                totals["cache_write"] += use.get("cache_creation_input_tokens", 0)
                totals["cache_read"] += use.get("cache_read_input_tokens", 0)
                totals["output"] += use.get("output_tokens", 0)
    except OSError:
        return None
    return totals


def report_cost(found: list[Path]) -> int:
    """What the observer cost, and how much of it rode the cache."""
    grand = {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0,
             "cost_usd": 0.0, "calls": 0, "failed": 0, "api_ms": 0}

    for diary in found:
        rows = read_ledger(diary)
        if not rows:
            continue
        agg = {k: sum(r.get(k, 0) for r in rows)
               for k in ("input", "cache_write", "cache_read", "output", "api_ms")}
        cost = sum(r.get("cost_usd", 0) or 0 for r in rows)
        failed = sum(1 for r in rows if not r.get("ok", True))

        billed_in = agg["input"] + agg["cache_write"] + agg["cache_read"]
        hit = (agg["cache_read"] / billed_in * 100) if billed_in else 0.0

        print(f"\n{diary.parent.name}/{diary.stem}")
        print(f"  reflections     {len(rows)}"
              + (f"  ({failed} produced no verdict)" if failed else ""))
        print(f"  cost            ${cost:.4f}   (${cost / len(rows):.4f} per reflection)")
        print(f"  cache hit rate  {hit:.1f}% of billed input tokens")
        print(f"  tokens          {agg['cache_read']:,} cached read · "
              f"{agg['cache_write']:,} cache write · {agg['input']:,} fresh in · "
              f"{agg['output']:,} out")
        print(f"  median latency  {sorted(r.get('api_ms', 0) for r in rows)[len(rows) // 2] / 1000:.1f}s")

        session = session_tokens(diary)
        if session and session["turns"]:
            s_in = session["input"] + session["cache_write"] + session["cache_read"]
            if s_in:
                print(f"  observed session {session['turns']} turns · {s_in:,} input tokens · "
                      f"{session['output']:,} out")
                print(f"  input overhead  {billed_in / s_in * 100:.2f}% "
                      f"({billed_in:,} / {s_in:,} input tokens)")

        for key in agg:
            grand[key] += agg[key]
        grand["cost_usd"] += cost
        grand["calls"] += len(rows)
        grand["failed"] += failed

    if not grand["calls"]:
        print("No usage recorded yet. The ledger fills as reflections run.")
        return 1

    billed = grand["input"] + grand["cache_write"] + grand["cache_read"]
    print(f"\n{'-' * 60}")
    print(f"TOTAL  {grand['calls']} reflections · ${grand['cost_usd']:.4f} · "
          f"{grand['cache_read'] / billed * 100:.1f}% cached")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", help="path of the observed project")
    ap.add_argument("--alerts", action="store_true", help="only flagged entries")
    ap.add_argument("--sessions", action="store_true", help="one line per session")
    ap.add_argument("--cost", action="store_true",
                    help="token, cache and cost accounting for the observer")
    ap.add_argument("-n", type=int, default=12, help="entries to show (default 12)")
    args = ap.parse_args()

    found = diaries(args.project)
    if not found:
        print(f"No diaries under {DIARY_HOME}", file=sys.stderr)
        return 1

    if args.cost:
        return report_cost(found)

    if args.sessions:
        for path in found:
            items = entries(path)
            flags = sum(1 for e in items if any(f in e for f in FLAGGED))
            mark = f"  {flags} flagged" if flags else ""
            label = f"{path.parent.name}/{path.stem}"
            print(f"{label:<44} {len(items):>3} entries{mark}")
        return 0

    shown = 0
    for path in found:
        items = entries(path)
        if args.alerts:
            items = [e for e in items if any(f in e for f in FLAGGED)]
        if not items:
            continue
        print(f"\n{'=' * 72}\n{path}\n{'=' * 72}")
        for entry in items[-args.n:]:
            print(entry + "\n")
            shown += 1
            if shown >= args.n:
                return 0
    if not shown:
        print("Nothing to show." + (" No flagged entries." if args.alerts else ""))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Piping into `head` is the normal way to read this.
        sys.stderr.close()
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
