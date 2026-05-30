#!/usr/bin/env python3
"""
Python / Camoufox headless browser service.

Launches a hardened, anti-fingerprinting browser that mimics a realistic retail
user, injects a mock EIP-1193 wallet provider connected to the local Anvil fork,
navigates to a (mock or real) dApp, and drives the Approve -> Swap workflow so
the Node layer can capture and diff the resulting on-chain state.

Configuration is passed by the orchestrator via environment variables:

    SANDBOX_DAPP_URL   full dApp URL (mock dApp already carries query params)
    SANDBOX_RPC        local Anvil JSON-RPC endpoint (http://127.0.0.1:8545)
    SANDBOX_ACCOUNT    the unlocked fork account to act as
    SANDBOX_TOKEN      target token contract address
    SANDBOX_ROUTER     DEX router address
    SANDBOX_WETH       WETH address
    SANDBOX_BUY_WEI    hex wei amount to spend on the buy
    SANDBOX_HEADLESS   "1" (default) or "0"

Exit code 0 == the Approve + Swap workflow was driven successfully.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROVIDER_JS = HERE / "eip1193_provider.js"


def log(msg: str) -> None:
    print(f"[camoufox] {msg}", flush=True)


def env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        log(f"FATAL: missing required env var {name}")
        sys.exit(2)
    return val


def build_injection(rpc: str, account: str, chain_id_hex: str) -> str:
    """Load the provider shim and substitute connection placeholders."""
    js = PROVIDER_JS.read_text(encoding="utf-8")
    return (
        js.replace("__RPC__", rpc)
        .replace("__ACCOUNT__", account)
        .replace("__CHAINID__", chain_id_hex)
    )


def chain_id_hex() -> str:
    cid = os.environ.get("CHAIN_ID", "1")
    try:
        return hex(int(cid))
    except ValueError:
        return "0x1"


def click_when_ready(page, selector: str, label: str, timeout_ms: int = 15000) -> None:
    """Wait for a button to be enabled, then click it like a human would."""
    log(f"locating '{label}' button ({selector})")
    btn = page.locator(selector)
    btn.wait_for(state="visible", timeout=timeout_ms)
    # Wait until the button is not disabled (the dApp enables it after connect).
    deadline = time.time() + timeout_ms / 1000
    while btn.is_disabled():
        if time.time() > deadline:
            raise TimeoutError(f"'{label}' button never became enabled")
        time.sleep(0.2)
    btn.click()
    log(f"clicked '{label}'")


def wait_flag(page, flag: str, timeout_ms: int = 30000) -> bool:
    """Poll a window.__SANDBOX_* boolean the dApp sets after each step."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        val = page.evaluate(f"() => window.{flag}")
        if val is True:
            return True
        if val is False:
            return False  # explicit failure signalled by the page
        time.sleep(0.25)
    raise TimeoutError(f"timed out waiting for window.{flag}")


def main() -> int:
    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        log("FATAL: camoufox is not installed.")
        log("Install it with:")
        log("    pip install -r python/requirements.txt")
        log("    python -m camoufox fetch")
        return 4

    dapp_url = env("SANDBOX_DAPP_URL")
    rpc = env("SANDBOX_RPC", "http://127.0.0.1:8545")
    account = env("SANDBOX_ACCOUNT")
    headless = os.environ.get("SANDBOX_HEADLESS", "1") != "0"

    injection = build_injection(rpc, account, chain_id_hex())

    log(f"target dApp : {dapp_url}")
    log(f"fork RPC    : {rpc}")
    log(f"acting as   : {account}")
    log(f"headless    : {headless}")

    # Anti-fingerprinting profile matching a realistic retail desktop user.
    # Camoufox rotates a coherent fingerprint (canvas, WebGL, fonts, navigator,
    # screen) so the dApp's bot-detection cannot trivially flag automation.
    camoufox_opts = dict(
        headless=headless,
        humanize=True,            # human-like cursor movement + timing
        os=["windows"],           # coherent Windows desktop persona
        locale="en-US",
        # geoip=True,             # align timezone/locale to the exit IP (needs geoip extra)
        block_webrtc=True,        # avoid leaking the real local IP
    )

    try:
        with Camoufox(**camoufox_opts) as browser:
            page = browser.new_page()
            # Inject the EIP-1193 provider before any page script executes.
            page.add_init_script(injection)

            log("navigating...")
            page.goto(dapp_url, wait_until="load", timeout=30000)

            # --- Drive the Connect -> Approve -> Swap workflow ----------------
            click_when_ready(page, "#connect", "Connect Wallet")
            if not wait_flag(page, "__SANDBOX_CONNECTED"):
                log("ERROR: wallet did not connect")
                return 5

            click_when_ready(page, "#approve", "Approve")
            approved = wait_flag(page, "__SANDBOX_APPROVED")
            log(f"approve result: {approved}")

            click_when_ready(page, "#swap", "Swap (buy)")
            swapped = wait_flag(page, "__SANDBOX_SWAPPED")
            tx = page.evaluate("() => window.__SANDBOX_SWAP_TX || null")
            log(f"swap result: {swapped}  tx={tx}")

            # A reverted swap is NOT a service failure — it is a finding the Node
            # diff layer will interpret. We only fail hard on infra errors.
            log("workflow complete")
            return 0
    except Exception as exc:  # noqa: BLE001 - top-level guard, report cleanly
        log(f"FATAL: {type(exc).__name__}: {exc}")
        return 6


if __name__ == "__main__":
    sys.exit(main())
