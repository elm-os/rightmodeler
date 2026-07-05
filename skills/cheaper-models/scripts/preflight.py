"""Check the environment before running the skill. Prints a readiness report."""

from __future__ import annotations

import os
import shutil
import sys


def main() -> int:
    ok = True
    print("cheaper-models preflight")
    print("-" * 40)

    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        print(f"[ok] OPENROUTER_API_KEY set (…{key[-4:]})")
    else:
        print("[MISSING] OPENROUTER_API_KEY — export it or run `! export OPENROUTER_API_KEY=...`")
        ok = False

    print(f"[info] python {sys.version.split()[0]}")

    for mod in ("httpx", "rich", "textual"):
        try:
            __import__(mod)
            print(f"[ok] {mod} importable")
        except ImportError:
            print(f"[MISSING] {mod} — pip install -r requirements.txt")
            ok = False

    print(
        f"[info] git: {'found' if shutil.which('git') else 'NOT FOUND (needed for sandboxed E2E replay)'}"
    )
    print(
        f"[info] docker: {'found' if shutil.which('docker') else 'absent (optional, stronger sandbox)'}"
    )

    # live credit check
    if key:
        try:
            from openrouter import OpenRouter

            info = OpenRouter(key).key_info()
            rem = info.get("limit_remaining")
            print(
                f"[ok] OpenRouter reachable. credits remaining: {rem if rem is not None else 'unlimited/unknown'}"
            )
            if info.get("is_free_tier"):
                print("[warn] key is free-tier — expect rate limits; avoid for large fleets")
        except Exception as e:  # noqa: BLE001
            print(f"[warn] could not reach OpenRouter /key: {e}")

    print("-" * 40)
    print("READY" if ok else "NOT READY — resolve [MISSING] items above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
