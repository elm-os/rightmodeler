"""Check the environment before running the skill. Prints a readiness report."""

from __future__ import annotations

import shutil
import sys

from common import resolve_openrouter_key


def main() -> int:
    ok = True
    print("rightmodeler preflight")
    print("-" * 40)

    key, source = resolve_openrouter_key()
    if key:
        where = "environment" if source == "environment" else source
        print(f"[ok] OPENROUTER_API_KEY loaded from {where} (…{key[-4:]})")
    else:
        print(
            "[MISSING] OPENROUTER_API_KEY — add `OPENROUTER_API_KEY=...` to your "
            "project root `.env` or export it in this session"
        )
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

            orr = OpenRouter(key)
            info = orr.key_info()
            rem = info.get("limit_remaining")
            print(
                f"[ok] OpenRouter reachable. credits remaining: {rem if rem is not None else 'unlimited/unknown'}"
            )
            if info.get("is_free_tier"):
                print("[warn] key is free-tier — expect rate limits; avoid for large fleets")
        except Exception as e:  # noqa: BLE001
            print(f"[warn] could not reach OpenRouter /key: {e}")
        else:
            # judge IDs go stale as catalogs rotate; a missing judge silently fails
            # every candidate it would have scored
            try:
                from judge import DEFAULT_JUDGES

                ids = {m["id"] for m in orr.list_models()}
                for j in DEFAULT_JUDGES:
                    if j in ids:
                        print(f"[ok] judge model in catalog: {j}")
                    else:
                        print(
                            f"[MISSING] judge model not in OpenRouter catalog: {j} — "
                            "update DEFAULT_JUDGES in judge.py"
                        )
                        ok = False
            except Exception as e:  # noqa: BLE001
                print(f"[warn] could not validate judge models: {e}")

    print("-" * 40)
    print("READY" if ok else "NOT READY — resolve [MISSING] items above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
