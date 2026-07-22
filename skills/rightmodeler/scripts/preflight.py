"""Check the environment before running the skill. Prints a readiness report."""

from __future__ import annotations

import shutil
import sys

from common import require_provider, resolve_env_var
from provider import get_provider


def main() -> int:
    ok = True
    print("rightmodeler preflight")
    print("-" * 40)

    config, key = require_provider()
    _, source = resolve_env_var(config.env_key)
    where = "environment" if source == "environment" else source
    print(f"[ok] {config.env_key} loaded from {where} (…{key[-4:]})")
    for url in config.docs:
        print(f"[info] provider docs: {url}")

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
            orr = get_provider(config.name)
            info = orr.account_info()
            rem = info.get("limit_remaining")
            print(
                f"[ok] {config.name} reachable. credits remaining: "
                f"{rem if rem is not None else 'unlimited/unknown'}"
            )
            if info.get("is_free_tier"):
                print("[warn] key is free-tier — expect rate limits; avoid for large fleets")
        except Exception as e:  # noqa: BLE001
            print(f"[warn] could not reach {config.name} account endpoint: {e}")
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
                            f"[MISSING] judge model not in provider catalog: {j} — "
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
