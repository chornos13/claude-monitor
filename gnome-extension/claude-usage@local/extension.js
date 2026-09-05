import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Fully decoupled from cswap / the Anthropic usage API: this extension ONLY
// reads cswap's local files. It never runs cswap and never triggers a fetch,
// so it cannot contribute to usage-API rate limiting. The numbers are as fresh
// as whatever last legitimately ran `cswap --list` (its monitor's own poll,
// a manual list, or opening the dashboard) wrote to the cache.
const HOME = GLib.get_home_dir();
const SWAP_DIR = GLib.build_filenamev([HOME, '.local', 'share', 'claude-swap']);
const CACHE_FILE = GLib.build_filenamev([SWAP_DIR, 'cache', 'usage.json']);   // per-account 5h/7d %
const SEQUENCE_FILE = GLib.build_filenamev([SWAP_DIR, 'sequence.json']);       // activeAccountNumber + emails
const MONITOR_URL = 'http://localhost:3005/';

// percent = quota CONSUMED (100 = exhausted), so higher is worse.
function colorFor(pct) {
    if (pct >= 90) return '#f87171'; // red
    if (pct >= 70) return '#fbbf24'; // amber
    return '#4ade80';                // green
}

function readJson(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok)
            return null;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) {
        return null;
    }
}

function ageText(tsSeconds) {
    if (!tsSeconds)
        return 'unknown';
    const secs = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
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

        const openItem = new PopupMenu.PopupMenuItem('Open Claude Monitor');
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(MONITOR_URL, null);
        });
        this.menu.addMenuItem(openItem);

        // Rebuild the full account list only when the menu is opened (free: local read).
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuildMenu();
        });
    }

    // Reads the two local files. Returns {activeNum, accounts:[{num,email}], usage, ts} or null.
    _read() {
        const seq = readJson(SEQUENCE_FILE);
        const cache = readJson(CACHE_FILE);
        if (!seq)
            return null;
        const accounts = (seq.sequence ?? []).map((num) => ({
            num: String(num),
            email: seq.accounts?.[String(num)]?.email ?? `#${num}`,
        }));
        return {
            activeNum: String(seq.activeAccountNumber ?? ''),
            accounts,
            usage: cache?.data ?? {},
            ts: cache?.timestamp ?? 0,
        };
    }

    // Top bar: active account's 5h % only.
    _renderLabel() {
        const data = this._read();
        if (!data) {
            this._label.set_text('—');
            this._label.set_style('color: #9ca3af;');
            return;
        }
        const u = data.usage[data.activeNum];
        const pct = u?.five_hour?.pct;
        if (pct === undefined || pct === null) {
            // Active account has no cached usage yet (stale / fetch failed).
            this._label.set_text('—');
            this._label.set_style('color: #9ca3af;');
        } else {
            const p = Math.round(pct);
            this._label.set_text(`${p}%`);
            this._label.set_style(`color: ${colorFor(p)}; font-feature-settings: "tnum";`);
        }
    }

    _rebuildMenu() {
        this._accountsSection.removeAll();
        const data = this._read();

        if (!data) {
            this._accountsSection.addMenuItem(
                new PopupMenu.PopupMenuItem('cswap data not found', {reactive: false}));
            return;
        }

        const header = new PopupMenu.PopupMenuItem('Account          5h / 7d', {reactive: false});
        header.label.set_style('font-weight: 700;');
        this._accountsSection.addMenuItem(header);

        for (const a of data.accounts) {
            const u = data.usage[a.num];
            const p5 = u?.five_hour?.pct;
            const p7 = u?.seven_day?.pct;
            const isActive = a.num === data.activeNum;
            const email = a.email.length > 22 ? a.email.slice(0, 21) + '…' : a.email;
            const mark = isActive ? '● ' : '  ';

            const item = new PopupMenu.PopupMenuItem(`${mark}${email}`);
            const txt = (p5 === undefined || p5 === null)
                ? '—'
                : `${Math.round(p5)}% / ${p7 === undefined || p7 === null ? '—' : Math.round(p7) + '%'}`;
            const stats = new St.Label({text: txt, y_align: Clutter.ActorAlign.CENTER});
            const c = (p5 === undefined || p5 === null)
                ? '#9ca3af'
                : colorFor(Math.max(p5, p7 ?? 0));
            stats.set_style(`color: ${c};`);
            item.add_child(stats);
            item.connect('activate', () => Gio.AppInfo.launch_default_for_uri(MONITOR_URL, null));
            this._accountsSection.addMenuItem(item);
        }

        const foot = new PopupMenu.PopupMenuItem(`updated ${ageText(data.ts)}`, {reactive: false});
        foot.label.set_style('font-size: 0.85em; color: #9ca3af;');
        this._accountsSection.addMenuItem(foot);
    }

    // Watch the directories (survives in-place writes and atomic replaces alike).
    startWatching() {
        this._renderLabel();

        this._monitors = [];
        for (const dir of [GLib.path_get_dirname(CACHE_FILE), SWAP_DIR]) {
            try {
                const m = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
                m.connect('changed', (_m, file) => {
                    const name = file?.get_basename();
                    if (name === 'usage.json' || name === 'sequence.json')
                        this._renderLabel();
                });
                this._monitors.push(m);
            } catch (e) {
                // ignore — a missing dir just means no live updates until it exists
            }
        }
    }

    stopWatching() {
        for (const m of this._monitors ?? [])
            m.cancel();
        this._monitors = null;
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path);
        Main.panel.addToStatusArea('claude-usage', this._indicator);
        this._indicator.startWatching();
    }

    disable() {
        this._indicator?.stopWatching();
        this._indicator?.destroy();
        this._indicator = null;
    }
}
