"""Check the environment before running the skill. Prints a readiness report."""

from __future__ import annotations

import shutil
import sys

from provider import get_provider


def _is_auth_failure(error: Exception) -> bool:
    return getattr(getattr(error, "response", None), "status_code", None) in (401, 403)


def main() -> int:
    ok = True
    print("rightmodeler preflight")
    print("-" * 40)

    provider = get_provider()
    config = provider.config
    key = provider.api_key
    where = provider.key_source or "unknown source"
    print(f"[ok] selected provider: {config.name}")
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
            info = provider.account_info()
            if config.name == "openrouter":
                remaining = info.get("limit_remaining")
                print(
                    "[ok] openrouter reachable. key spend limit remaining: "
                    f"{remaining if remaining is not None else 'unlimited/unknown'}"
                )
                if info.get("is_free_tier"):
                    print("[warn] key is free-tier — expect rate limits; avoid for large fleets")
            elif config.name == "vercel-ai-gateway":
                print(
                    f"[ok] vercel-ai-gateway reachable. balance: ${info.get('balance')} "
                    f"total used: ${info.get('total_used')}"
                )
            else:
                readiness = info.get("readiness") or {}
                print(
                    f"[ok] litellm reachable. readiness: {readiness.get('status', 'healthy')} "
                    f"models: {info.get('model_count', 0)}"
                )
        except Exception as e:  # noqa: BLE001
            if _is_auth_failure(e):
                print(f"[MISSING] {config.name} authentication failed: {e}")
                ok = False
            else:
                print(f"[warn] could not reach {config.name} account endpoint: {e}")
        else:
            try:
                catalog = provider.list_models()
                families = {
                    provider.model_family(model.get("id"))
                    for model in catalog
                    if model.get("type") in (None, "language")
                } - {"unknown"}
                if len(families) >= 3:
                    print(f"[ok] catalog has {len(families)} resolvable judge families")
                elif config.name == "litellm":
                    print(
                        f"[warn] litellm catalog has only {len(families)} resolvable model "
                        "families — map judge-capable models in the proxy config or plan "
                        "--judge-model"
                    )
                else:
                    print(
                        f"[MISSING] provider catalog has only {len(families)} resolvable "
                        "model families — a neutral third-family judge is not guaranteed"
                    )
                    ok = False
            except Exception as e:  # noqa: BLE001
                if _is_auth_failure(e):
                    print(f"[MISSING] {config.name} catalog authentication failed: {e}")
                    ok = False
                else:
                    print(f"[warn] could not validate judge models: {e}")

    provider._client.close()

    print("-" * 40)
    print("READY" if ok else "NOT READY — resolve [MISSING] items above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
