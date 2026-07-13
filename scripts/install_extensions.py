#!/usr/bin/env python3
"""Registers every extension in this repo with Pi's global settings.json.

Convention: any top-level directory in this repo containing an `index.ts`
file is treated as one extension (same convention Pi itself uses for
directory-style extensions).

Idempotent and add-only:
  - Only adds entries missing from settings.json's "extensions" array.
  - Never removes or reorders existing entries.
  - If an existing entry points under this repo but no longer matches a
    discovered extension, prints a warning instead of deleting it.

Safe to rerun any time (after cloning on a new machine, or after adding a
new extension folder).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SETTINGS_PATH = Path.home() / ".pi" / "agent" / "settings.json"


def discover_extensions() -> list[Path]:
    return sorted(
        child / "index.ts"
        for child in REPO_ROOT.iterdir()
        if child.is_dir() and not child.name.startswith(".") and (child / "index.ts").is_file()
    )


def to_settings_path(path: Path) -> str:
    """Render an absolute path as a ~/-relative string when possible, so
    settings.json stays portable across machines with the same $HOME layout."""
    home = Path.home()
    try:
        return f"~/{path.relative_to(home)}"
    except ValueError:
        return str(path)


def load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return {}
    content = SETTINGS_PATH.read_text(encoding="utf-8").strip()
    return json.loads(content) if content else {}


def save_settings(settings: dict) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    discovered = discover_extensions()
    if not discovered:
        print(f"No extensions found under {REPO_ROOT} (looked for */index.ts).")
        return 0

    settings = load_settings()
    extensions: list[str] = list(settings.get("extensions", []))
    discovered_paths = {to_settings_path(p) for p in discovered}

    added = []
    for path in discovered:
        entry = to_settings_path(path)
        if entry not in extensions:
            extensions.append(entry)
            added.append(entry)

    repo_prefix = to_settings_path(REPO_ROOT)
    stale = [entry for entry in extensions if entry.startswith(repo_prefix) and entry not in discovered_paths]

    settings["extensions"] = extensions
    save_settings(settings)

    print(f"Settings file: {SETTINGS_PATH}")
    if added:
        print("Added:")
        for entry in added:
            print(f"  + {entry}")
    else:
        print("Nothing to add (already up to date).")

    if stale:
        print("\nWarning: found existing settings.json entries under this repo")
        print("that no longer match a discovered extension (not removed automatically):")
        for entry in stale:
            print(f"  ? {entry}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
