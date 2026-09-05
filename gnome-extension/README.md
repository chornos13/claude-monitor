# Claude Usage — GNOME Shell top-bar indicator

Shows the **active** Claude account's **5h quota %** in the GNOME top bar.

![indicator](claude-usage@local/icon.png) `35%` — colored green (<70%) / amber (70–90%) / red (≥90%).
Click it for a dropdown listing every account's `5h / 7d` numbers, when the data was last
updated, and **Open Claude Monitor**.

Tested on GNOME Shell 46 (Xorg), GJS 1.80.

## How it reads data — fully decoupled, zero API calls

This extension is a **passive reader of cswap's own local files**. It does **not** run
`cswap`, does **not** call the monitor's `/api/status`, and does **not** touch the Anthropic
usage API — so it **cannot contribute to usage-API rate limiting**. It reads:

- `~/.local/share/claude-swap/sequence.json` → `activeAccountNumber` + account emails
- `~/.local/share/claude-swap/cache/usage.json` → each account's cached `5h` / `7d` %

The numbers are as fresh as whatever **legitimately** last ran `cswap --list` (its monitor's
own background poll, a manual `cswap` invocation, or opening the dashboard) wrote to the cache.
An active account with no cached number yet (stale, or a failed/rate-limited fetch) shows `—`.

> **Why this design:** an earlier version polled `/api/status`, which makes `cswap` hit the
> live Anthropic usage API for every account on each refresh. Any cadence faster than cswap's
> internal 15 s cache — combined with the dashboard and cswap's own poll — produced enough
> `oauth/usage` traffic to get rate-limited. Reading the cache removes that entirely.

## Updates

- The top-bar label updates **instantly** via a `Gio` directory watch on
  `~/.local/share/claude-swap/` — whenever `usage.json` or `sequence.json` changes, it re-reads.
- The dropdown list is rebuilt when the menu is opened (a free local read).
- There are **no timers and no network calls** in this extension.

## Install

```bash
cp -r "gnome-extension/claude-usage@local" ~/.local/share/gnome-shell/extensions/
# restart GNOME Shell:  Xorg -> Alt+F2, type r, Enter   |   Wayland -> log out/in
gnome-extensions enable claude-usage@local
```

## Config

Edit `claude-usage@local/extension.js`:

- `CACHE_FILE` / `SEQUENCE_FILE` — cswap file locations (default `~/.local/share/claude-swap/…`).
- `MONITOR_URL` — dashboard URL opened from the menu.
- `colorFor(pct)` — thresholds and colors.
