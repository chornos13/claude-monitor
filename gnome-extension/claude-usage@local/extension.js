import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ENDPOINT = 'http://localhost:3005/api/status';
const MONITOR_URL = 'http://localhost:3005/';

// Decoupled activity detection: we passively observe Claude Code's own
// transcript writes under ~/.claude/projects. No hooks, no config changes.
const ACTIVITY_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
const ACTIVITY_CHECK_SECONDS = 6;  // cheap probe: any transcript newer than last check?
const THROTTLE_SECONDS = 60;       // refresh cswap at most once per this window

// percent = quota CONSUMED (100 = exhausted), so higher is worse.
function colorFor(pct) {
    if (pct >= 90) return '#f87171'; // red
    if (pct >= 70) return '#fbbf24'; // amber
    return '#4ade80';                // green
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'Claude Usage', false);

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const iconPath = GLib.build_filenamev([extensionPath, 'icon.png']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon.set_style('margin-right: 4px;');
        this._label = new St.Label({text: '…', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._accountsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._accountsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh(true));
        this.menu.addMenuItem(refreshItem);

        // Rebuild the full account list only when the menu is opened.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._refresh(true);
        });

        const openItem = new PopupMenu.PopupMenuItem('Open Claude Monitor');
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(MONITOR_URL, null);
        });
        this.menu.addMenuItem(openItem);
    }

    // updateMenu=false -> only the top-bar (active) label is updated (the 30s timer).
    // updateMenu=true  -> also rebuild the full account list (only when menu opens).
    _refresh(updateMenu = false) {
        try {
            const proc = Gio.Subprocess.new(
                ['curl', '-s', '-m', '5', ENDPOINT],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    this._render(JSON.parse(stdout), updateMenu);
                } catch (e) {
                    this._label.set_text('offline');
                    this._label.set_style('color: #9ca3af;');
                }
            });
        } catch (e) {
            this._label.set_text('err');
        }
    }

    _render(data, updateMenu) {
        const accounts = data?.output?.accounts ?? [];
        // Top bar reflects ONLY the currently active account.
        const active = accounts.find(a => a.isActive);

        if (active) {
            const p5 = active.quota5h?.percent ?? 0;
            this._label.set_text(`${p5}%`);
            this._label.set_style(`color: ${colorFor(p5)}; font-feature-settings: "tnum";`);
        } else {
            this._label.set_text('—');
            this._label.set_style('color: #9ca3af;');
        }

        if (!updateMenu)
            return;

        // Rebuild dropdown: one line per account.
        this._accountsSection.removeAll();
        const header = new PopupMenu.PopupMenuItem('Account          5h / 7d', {reactive: false});
        header.label.set_style('font-weight: 700;');
        this._accountsSection.addMenuItem(header);

        for (const a of accounts) {
            const email = a.email ?? `#${a.index}`;
            const short = email.length > 22 ? email.slice(0, 21) + '…' : email;
            const p5 = a.quota5h?.percent ?? 0;
            const p7 = a.quota7d?.percent ?? 0;
            const mark = a.isActive ? '● ' : '  ';
            const item = new PopupMenu.PopupMenuItem(`${mark}${short}`);
            const stats = new St.Label({
                text: `${p5}% / ${p7}%`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            stats.set_style(`color: ${colorFor(Math.max(p5, p7))};`);
            item.add_child(stats);
            item.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(MONITOR_URL, null);
            });
            this._accountsSection.addMenuItem(item);
        }
    }

    // Returns true if any Claude transcript was written since `sinceEpoch`.
    // `-quit` stops at the first match, so this is cheap even with many files.
    _hasActivitySince(sinceEpoch, cb) {
        try {
            const proc = Gio.Subprocess.new(
                ['find', ACTIVITY_DIR, '-name', '*.jsonl',
                 '-newermt', `@${sinceEpoch}`, '-print', '-quit'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    cb(stdout.trim().length > 0);
                } catch (e) {
                    cb(false);
                }
            });
        } catch (e) {
            cb(false);
        }
    }

    // Throttled label refresh: at most one cswap hit per THROTTLE_SECONDS.
    // A burst of concurrent activity collapses into a single trailing refresh.
    _refreshThrottled() {
        const now = GLib.get_real_time() / 1e6;
        const elapsed = now - this._lastRefresh;

        if (elapsed >= THROTTLE_SECONDS) {
            this._lastRefresh = now;
            this._refresh(false);
        } else if (!this._throttleTimer) {
            // Schedule one catch-up refresh at the end of the current window.
            const wait = Math.ceil(THROTTLE_SECONDS - elapsed);
            this._throttleTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
                this._throttleTimer = null;
                this._lastRefresh = GLib.get_real_time() / 1e6;
                this._refresh(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    startPolling() {
        this._lastCheck = GLib.get_real_time() / 1e6; // epoch seconds
        this._lastRefresh = GLib.get_real_time() / 1e6;
        this._throttleTimer = null;
        this._refresh(false);

        // Activity-driven refresh: probe transcripts; only hit cswap on new activity.
        this._activityTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ACTIVITY_CHECK_SECONDS, () => {
            const since = Math.floor(this._lastCheck);
            this._lastCheck = GLib.get_real_time() / 1e6;
            this._hasActivitySince(since, (active) => {
                if (active)
                    this._refreshThrottled();
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopPolling() {
        if (this._activityTimer) {
            GLib.source_remove(this._activityTimer);
            this._activityTimer = null;
        }
        if (this._throttleTimer) {
            GLib.source_remove(this._throttleTimer);
            this._throttleTimer = null;
        }
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path);
        Main.panel.addToStatusArea('claude-usage', this._indicator);
        this._indicator.startPolling();
    }

    disable() {
        this._indicator?.stopPolling();
        this._indicator?.destroy();
        this._indicator = null;
    }
}
