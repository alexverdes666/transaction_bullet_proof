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

import json
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
    """Build the init script that installs the mock wallet in the PAGE MAIN world.

    Critical detail: in Playwright/Firefox (and Camoufox) `add_init_script` runs in
    an ISOLATED world — globals it defines (like `window.ethereum`) are invisible to
    the page's own scripts, so a real dApp would never see the wallet. To reach the
    page main world we append a <script> element to the DOM (which is shared); its
    body executes in the main world exactly like a page script, so `window.ethereum`
    is where the dApp looks for it.
    """
    provider = (
        PROVIDER_JS.read_text(encoding="utf-8")
        .replace("__RPC__", rpc)
        .replace("__ACCOUNT__", account)
        .replace("__CHAINID__", chain_id_hex)
    )
    # json.dumps safely encodes the provider source as a JS string literal.
    return (
        "(() => {\n"
        "  const s = document.createElement('script');\n"
        f"  s.textContent = {json.dumps(provider)};\n"
        "  (document.head || document.documentElement).appendChild(s);\n"
        "  s.remove();\n"
        "})();"
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


def read_signal(page, name: str):
    """Read a `data-bp-<name>` attribute the dApp sets on <html>.

    The DOM is shared across the browser's JS worlds; window globals set by page
    scripts are NOT reliably visible to the automation driver (Firefox/Camoufox
    isolates page script globals from page.evaluate). So we signal via the DOM.
    """
    return page.evaluate(f"() => document.documentElement.getAttribute('data-bp-{name}')")


def wait_signal(page, name: str, timeout_ms: int = 30000):
    """Poll until `data-bp-<name>` is set; return its value."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        val = read_signal(page, name)
        if val is not None and val != "":
            return val
        time.sleep(0.2)
    raise TimeoutError(f"timed out waiting for data-bp-{name}")


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
            # Surface page-side console + errors for debugging the injected flow.
            page.on("console", lambda m: log(f"PAGE[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: log(f"PAGE ERROR: {e}"))
            # Inject the EIP-1193 provider before any page script executes.
            page.add_init_script(injection)

            log("navigating...")
            page.goto(dapp_url, wait_until="load", timeout=30000)

            # --- Drive the Connect -> Approve -> Swap workflow ----------------
            # Did the injected wallet code run in the page main world?
            log("wallet marker = " + str(read_signal(page, "wallet")))

            click_when_ready(page, "#connect", "Connect Wallet")
            wait_signal(page, "connected")
            # Which provider did the PAGE actually use (injected wallet vs fallback)?
            log("page provider = " + str(read_signal(page, "provider")))

            click_when_ready(page, "#approve", "Approve")
            approved = wait_signal(page, "approved")
            log(f"approve result: {approved}")

            click_when_ready(page, "#swap", "Swap (buy)")
            swapped = wait_signal(page, "swapped")
            tx = read_signal(page, "swaptx")
            log(f"swap result: {swapped}  tx={tx}")

            # A reverted swap is NOT a service failure — it's a finding for the Node
            # diff layer. We only fail hard on infra errors.
            log("workflow complete")
            return 0
    except Exception as exc:  # noqa: BLE001 - top-level guard, report cleanly
        log(f"FATAL: {type(exc).__name__}: {exc}")
        return 6


if __name__ == "__main__":
    sys.exit(main())
