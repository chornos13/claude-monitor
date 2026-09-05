# Claude Usage — GNOME Shell top-bar indicator

Shows the **active** Claude account's **5h quota %** in the GNOME top bar,
polled from this project's `GET /api/status` endpoint (`http://localhost:3005`).

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
- `THROTTLE_SECONDS` — minimum gap between `cswap` refreshes; bursts of concurrent
  activity collapse into one trailing refresh (default `30`). Raise this if it refreshes
  too fast.
- `ACTIVITY_DIR` — transcript dir watched for activity (default `~/.claude/projects`).
- `ENDPOINT` / `MONITOR_URL` — change if the monitor runs on another host/port.
- `colorFor(pct)` — thresholds and colors.

## When it refreshes

The top-bar label (active account's 5h %) is **activity-driven and decoupled** —
it does not modify your Claude config or hooks. Every `ACTIVITY_CHECK_SECONDS` it runs
a cheap `find ... -newermt -quit` probe over `~/.claude/projects`; only when a transcript
was written since the last check does it call `cswap` (via `/api/status`) to refresh.
So `cswap` is invoked on real activity, not on a blind timer. The refresh is throttled to
at most once per `THROTTLE_SECONDS`, so bursts of concurrent activity collapse into a
single trailing refresh instead of hammering `cswap`. There is no fallback timer — if
nothing writes a transcript, nothing runs beyond the probe.

The **full account list** in the dropdown is fetched only when the menu is opened
(or via **Refresh now**) — never on the timers.
