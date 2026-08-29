#!/usr/bin/env python3
"""Read back reflection diaries.

  review.py                 recent entries across all projects
  review.py --alerts        only concern and alert entries
  review.py --project .     one project
  review.py --sessions      one line per session, newest first
"""

from __future__ import annotations

import argparse
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", help="path of the observed project")
    ap.add_argument("--alerts", action="store_true", help="only flagged entries")
    ap.add_argument("--sessions", action="store_true", help="one line per session")
    ap.add_argument("-n", type=int, default=12, help="entries to show (default 12)")
    args = ap.parse_args()

    found = diaries(args.project)
    if not found:
        print(f"No diaries under {DIARY_HOME}", file=sys.stderr)
        return 1

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
