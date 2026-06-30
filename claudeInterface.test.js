import { describe, it, expect, vi } from 'vitest';
const ClaudeInterface = require('./claudeInterface');

// A cswap --list payload _parseStatus can read. Marks `activeIndex` active.
function listOutput(activeIndex) {
    const row = (i, email) =>
        `  ${i}: ${email}${i === activeIndex ? ' (active)' : ''}`;
    return [
        'Accounts:',
        row(1, 'one@example.com'),
        row(4, 'four@example.com'),
        row(5, 'five@example.com'),
    ].join('\n');
}

// Fake exec: records {cmd, env} for every call, answers --list with a chosen
// active account and the claude prompt with a stubbed result (or throws).
function makeExec(activeIndex, { claudeThrows = false } = {}) {
    const calls = [];
    const exec = vi.fn(async (cmd, opts) => {
        calls.push({ cmd, env: opts?.env });
        if (cmd === 'cswap --list') return { stdout: listOutput(activeIndex), stderr: '' };
        if (cmd.startsWith('cswap --switch-to')) return { stdout: '', stderr: '' };
        if (cmd.startsWith('claude ')) {
            if (claudeThrows) throw new Error('Command failed: claude ... (credential invalid)');
            return { stdout: '2\n', stderr: '' };
        }
        throw new Error(`unexpected command: ${cmd}`);
    });
    return { exec, calls };
}

const silent = { log: () => {} };
const cmds = calls => calls.map(c => c.cmd);
const CLAUDE = 'claude -p "1+1=" --model claude-sonnet-4-6 < /dev/null';

describe('runTestPrompt — non-active target (sandboxed)', () => {
    // Regression guard for the 2628b74 sandbox bug AND the hijack it tried to
    // fix. A non-active test must: (a) never move host ~/.claude — every
    // cswap/claude call carries a sandbox CLAUDE_CONFIG_DIR; (b) switch AWAY
    // afterwards so cswap persists the rotated single-use token to the store.
    it('isolates the config dir and switches away to persist the rotation', async () => {
        const { exec, calls } = makeExec(4);
        const iface = new ClaudeInterface(silent, { exec });

        const res = await iface.runTestPrompt(5);

        expect(res).toEqual({ success: true, output: '2' });
        expect(cmds(calls)).toEqual([
            'cswap --list',
            'cswap --switch-to 5',
            CLAUDE,
            'cswap --switch-to 4', // switch-away: persists 5's rotated token
        ]);

        // Host isolation: the switch + run + switch-away all carry a sandbox
        // CLAUDE_CONFIG_DIR, so host ~/.claude is never written. (--list reads
        // the real store, so it is left un-sandboxed.)
        const sandboxed = calls.filter(c => c.cmd !== 'cswap --list');
        expect(sandboxed.length).toBe(3);
        for (const c of sandboxed) {
            expect(c.env?.CLAUDE_CONFIG_DIR, c.cmd).toBeTruthy();
        }
        // All three share ONE sandbox dir.
        const dirs = new Set(sandboxed.map(c => c.env.CLAUDE_CONFIG_DIR));
        expect(dirs.size).toBe(1);
    });

    it('still switches away (persists) when the claude run fails', async () => {
        const { exec, calls } = makeExec(4, { claudeThrows: true });
        const iface = new ClaudeInterface(silent, { exec });

        await expect(iface.runTestPrompt(5)).rejects.toThrow();

        // The persist switch-away must fire from finally, after the run.
        expect(cmds(calls)).toContain('cswap --switch-to 4');
        expect(cmds(calls).indexOf(CLAUDE)).toBeLessThan(
            cmds(calls).indexOf('cswap --switch-to 4'),
        );
    });
});

describe('runTestPrompt — active target (in place)', () => {
    // The active account's live token is in use by host sessions; testing it
    // from a sandbox copy could rotate that shared token and break them. So we
    // run in place: no switch (no hijack) and the rotation lands on the same
    // account's live creds (no loss).
    it('runs in place with no switch and no sandbox env', async () => {
        const { exec, calls } = makeExec(5);
        const iface = new ClaudeInterface(silent, { exec });

        await iface.runTestPrompt(5);

        expect(cmds(calls)).toEqual(['cswap --list', CLAUDE]);
        // No sandbox: claude runs against the inherited (live) environment.
        const claudeCall = calls.find(c => c.cmd === CLAUDE);
        expect(claudeCall.env).toBeUndefined();
    });
});

describe('runTestPrompt — concurrency', () => {
    it('serializes runs so two never interleave their cswap switches', async () => {
        const { exec, calls } = makeExec(1);
        const iface = new ClaudeInterface(silent, { exec });

        await Promise.all([iface.runTestPrompt(4), iface.runTestPrompt(5)]);

        // Each non-active run is a contiguous switch->run->switch-away block;
        // the second run's first switch comes only after the first fully ends.
        const switches = cmds(calls).filter(c => c.startsWith('cswap --switch-to'));
        expect(switches).toEqual([
            'cswap --switch-to 4',
            'cswap --switch-to 1',
            'cswap --switch-to 5',
            'cswap --switch-to 1',
        ]);
    });
});
