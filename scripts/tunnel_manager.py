"""
SONIQ public tunnel manager.

Keeps the yt-dlp API (server.py on :5001) and a Cloudflare quick tunnel alive.
Whenever cloudflared prints a new trycloudflare URL, it updates the GitHub
secret VITE_SONIQ_API_URL and retriggers the Pages deploy so the live site
always points at the current tunnel.

Run:  python scripts/tunnel_manager.py
"""

import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
REPO = "DaClinto/soniq-app"
API_PORT = 5001
API_HEALTH = f"http://127.0.0.1:{API_PORT}/api/status"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def api_online() -> bool:
    try:
        urllib.request.urlopen(API_HEALTH, timeout=3)
        return True
    except Exception:
        return False


def ensure_api() -> subprocess.Popen | None:
    if api_online():
        log("API already running on :5001")
        return None
    log("Starting server.py ...")
    return subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=BASE_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def update_github(url: str) -> None:
    log(f"New tunnel URL: {url} — updating GitHub secret + rebuild")
    subprocess.run(
        ["gh", "secret", "set", "VITE_SONIQ_API_URL", "--body", url, "--repo", REPO],
        check=False,
    )
    subprocess.run(
        ["gh", "workflow", "run", "deploy.yml", "--repo", REPO, "--ref", "master"],
        check=False,
    )


def run_tunnel(last_url: str | None) -> str | None:
    """Run cloudflared until it exits; return the last seen tunnel URL."""
    log("Starting cloudflared quick tunnel ...")
    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{API_PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    url = last_url
    assert proc.stdout is not None
    for line in proc.stdout:
        m = URL_RE.search(line)
        if m and m.group(0) != url:
            url = m.group(0)
            update_github(url)
        if "Registered tunnel connection" in line:
            log("Tunnel connected")
        if "error" in line.lower() and "failed" in line.lower():
            log(f"cloudflared: {line.strip()}")
    proc.wait()
    return url


def main() -> None:
    log("SONIQ tunnel manager starting")
    api_proc = ensure_api()
    last_url: str | None = None

    while True:
        # Restart the API if it died and we own the process.
        if api_proc and api_proc.poll() is not None:
            log("server.py exited — restarting")
            api_proc = ensure_api()
        if not api_online():
            log("API unreachable — restarting server.py")
            if api_proc:
                api_proc.terminate()
            api_proc = subprocess.Popen(
                [sys.executable, "server.py"],
                cwd=BASE_DIR,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        try:
            last_url = run_tunnel(last_url)
        except FileNotFoundError:
            log("cloudflared not found on PATH — install it and restart")
            time.sleep(30)
            continue
        except Exception as exc:  # noqa: BLE001
            log(f"tunnel error: {exc}")

        log("cloudflared exited — restarting in 5s")
        time.sleep(5)


if __name__ == "__main__":
    main()
