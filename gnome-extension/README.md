# Claude Usage — GNOME Shell top-bar indicator

Shows the **active** Claude account's **5h quota %** in the GNOME top bar,
read from this project's `GET /api/status` endpoint (`http://localhost:3005`).

![indicator](claude-usage@local/icon.png) `35%` — colored green (<70%) / amber (70–90%) / red (≥90%).
Click it for a dropdown listing every account's `5h / 7d` numbers, **Refresh now**, and **Open Claude Monitor**.

Tested on GNOME Shell 46 (Xorg), GJS 1.80.

## Install

```bash
cp -r "gnome-extension/claude-usage@local" ~/.local/share/gnome-shell/extensions/
# restart GNOME Shell:  Xorg -> Alt+F2, type r, Enter   |   Wayland -> log out/in
gnome-extensions enable claude-usage@local
```

## Config

Edit `claude-usage@local/extension.js`:

- `ACTIVITY_CHECK_SECONDS` — how often to probe for Claude activity (default `6`).
- `THROTTLE_SECONDS` — minimum gap between refreshes (default `300`, i.e. 5 min).
- `ACTIVITY_DIR` — transcript dir watched for activity (default `~/.claude/projects`).
- `ENDPOINT` / `MONITOR_URL` — change if the monitor runs on another host/port.
- `colorFor(pct)` — thresholds and colors.

## When it refreshes

The top-bar label (active account's 5h %) is **activity-driven and decoupled from your
Claude config** — no hooks, no settings changes. Every `ACTIVITY_CHECK_SECONDS` it runs a
cheap `find ... -newermt -quit` probe over `~/.claude/projects`; only when a transcript was
written since the last check does it call `/api/status` (which runs `cswap`) to refresh.
Refreshes are throttled to **at most once per `THROTTLE_SECONDS`**, so bursts of concurrent
activity collapse into a single trailing refresh. There is no fallback timer — if nothing
writes a transcript, nothing runs beyond the probe.

The **full account list** in the dropdown is fetched only when the menu is opened
(or via **Refresh now**) — never on the timer.

## Why the 5-minute throttle

`/api/status` makes `cswap --list` hit the live Anthropic usage API
(`api.anthropic.com/api/oauth/usage`) for **every** account. That endpoint is rate-limited
**per account/token**, and `cswap` only caches results for 15 s — so a fast refresh cadence,
stacked with the dashboard and cswap's own background poll, can trip a 429 (usage then shows
as `—` / `0%` until it clears). A 5-minute throttle keeps this indicator's contribution at
roughly the same cadence as the monitor's own background poll, well clear of the limit.
Lower it only if you understand that trade-off.
