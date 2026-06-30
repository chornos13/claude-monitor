const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const execAsync = promisify(exec);

/**
 * ClaudeInterface Module
 *
 * Deep module that encapsulates interaction with cswap and claude CLI tools.
 * It provides a high-leverage interface for listing accounts, switching,
 * and executing commands.
 */
class ClaudeInterface {
    constructor(logger, options = {}) {
        this.logger = logger || { log: console.log };
        // Injectable command runner (defaults to the real promisified exec).
        // Tests pass a fake to assert the issued command sequence without
        // touching cswap/claude. Seam: domain logic vs the external CLI.
        this._exec = options.exec || execAsync;
        // Serializes EVERY active-account mutation. cswap --switch-to rewrites
        // the single shared ~/.claude.json + ~/.claude/.credentials.json, so
        // manual switches AND the switch->run->restore of a test must own the
        // active account exclusively or they clobber each other.
        this._lock = Promise.resolve();
    }

    /**
     * Internal: Runs fn with exclusive access to the active-account state.
     * Tasks queue on a promise chain; a rejection in one task does not break
     * the chain for the next.
     */
    _withLock(fn) {
        const result = this._lock.then(() => fn());
        this._lock = result.then(() => {}, () => {});
        return result;
    }

    /**
     * Fetches the current status of all accounts and instances.
     * Deep interface: Returns structured data, hides raw CLI output and regex.
     */
    async getStatus() {
        try {
            const { stdout } = await this._exec('cswap --list');
            return this._parseStatus(stdout);
        } catch (error) {
            this.logger.log(`[ClaudeInterface] Failed to get status: ${error.message}`);
            throw error;
        }
    }

    /**
     * Switches to the target account. Serialized against all other
     * active-account mutations.
     */
    async switchToAccount(index) {
        return this._withLock(() => this._switchToAccountUnlocked(index));
    }

    /**
     * Internal: performs the switch without acquiring the lock. Callers that
     * already hold the lock (e.g. runTestPrompt) use this to avoid deadlock.
     */
    async _switchToAccountUnlocked(index) {
        try {
            this.logger.log(`[ClaudeInterface] Switching to account ${index}...`);
            await this._exec(`cswap --switch-to ${index}`);
            this.logger.log(`[ClaudeInterface] Successfully switched to account ${index}.`);
        } catch (error) {
            this.logger.log(`[ClaudeInterface] Switch Error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deep Function: Runs a test prompt on the target account WITHOUT ever
     * moving the host's active account or losing a credential.
     *
     * Two hazards this navigates, both rooted in one fact: a Claude OAuth
     * refresh token is single-use. The test forces `claude` to refresh the
     * (always-stale, since tests fire at quota-reset windows) access token,
     * which ROTATES the refresh token server-side and kills the old one.
     *
     *   1. Lost token. A sandbox holding a *copy* of the creds captures the
     *      rotated token, then deletes it with the sandbox — leaving the store
     *      and host ~/.claude with a dead token. (Regression in 2628b74: the
     *      active account went invalid on every auto-run.)
     *   2. Hijack. Switching the host's active account in place points the
     *      shared ~/.claude at the target, so a `claude` running in the
     *      background re-reads it and starts spending the WRONG account.
     *
     * Resolution, by case:
     *   - target is NOT active: isolate only CLAUDE_CONFIG_DIR to a throwaway
     *     dir (cswap/claude honour it), but keep the REAL account store. The
     *     switch writes creds into the sandbox, never host ~/.claude — no
     *     hijack. The closing switch-away makes cswap save the target's rotated
     *     token back into the real store — no lost token. Verified: cswap
     *     honours CLAUDE_CONFIG_DIR and persists on switch-away.
     *   - target IS active: run in place against host ~/.claude, no switch, no
     *     sandbox. It is the same account, so the rotation just updates the
     *     live token the host session already uses — no hijack, no loss.
     *
     * Serialized under the lock so the store's active pointer is never
     * observed half-switched by a concurrent run.
     */
    async runTestPrompt(targetIndex) {
        return this._withLock(() => this._runTestPromptUnlocked(targetIndex));
    }

    async _runTestPromptUnlocked(targetIndex) {
        this.logger.log(`[ClaudeInterface] Starting test execution for account ${targetIndex}...`);

        const status = await this.getStatus();
        const activeAccount = status.accounts.find(a => a.isActive);
        const previousActiveIndex = activeAccount ? activeAccount.index : null;
        this.logger.log(`[ClaudeInterface] Active account before: ${previousActiveIndex ?? 'unknown'}`);

        const isActiveTarget = previousActiveIndex === targetIndex;

        // Active target runs in place (env unchanged). Non-active target runs
        // against a sandbox config dir so the switch never touches host
        // ~/.claude; the real store is left in place so the rotation persists.
        let sandbox = null;
        let env;
        if (isActiveTarget) {
            env = undefined; // inherit process env — operate on live ~/.claude
        } else {
            sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cswap-test-'));
            const configDir = path.join(sandbox, 'config');
            await fs.mkdir(configDir, { recursive: true });
            env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
        }

        try {
            if (!isActiveTarget) {
                this.logger.log(`[ClaudeInterface] Switching (sandboxed) to account ${targetIndex}...`);
                await this._exec(`cswap --switch-to ${targetIndex}`, { env });
            }

            const claudeCmd = `claude -p "1+1=" --model claude-sonnet-4-6 < /dev/null`;
            this.logger.log(`[ClaudeInterface] Executing claude command for account ${targetIndex}...`);
            const { stdout, stderr } = await this._exec(claudeCmd, { env });

            const result = stdout.trim() || '(no output)';
            this.logger.log(`[ClaudeInterface] Claude Output for account ${targetIndex}: ${result}`);
            if (stderr) this.logger.log(`[ClaudeInterface] Claude Stderr: ${stderr.trim()}`);

            return { success: true, output: result };
        } catch (error) {
            this.logger.log(`[ClaudeInterface] Execution Error for account ${targetIndex}: ${error.message}`);
            throw error;
        } finally {
            // Switch-away inside the sandbox: this is what makes cswap save the
            // target's freshly-rotated token back into the real store. The host
            // pointer was never moved, so nothing on the host needs restoring.
            if (!isActiveTarget && previousActiveIndex !== null) {
                this.logger.log(`[ClaudeInterface] Persisting rotated creds (sandbox switch-away to ${previousActiveIndex})...`);
                try {
                    await this._exec(`cswap --switch-to ${previousActiveIndex}`, { env });
                } catch (restoreErr) {
                    // Don't mask the primary result/error.
                    this.logger.log(`[ClaudeInterface] Persist Error: ${restoreErr.message}`);
                }
            }
            if (sandbox) await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * Internal parsing logic.
     * Locality: Concentrates all regex and string splitting here.
     */
    _parseStatus(text) {
        const result = { accounts: [], instances: [] };
        let currentSection = '';
        let currentAccount = null;

        const lines = text.split('\n');
        for (let line of lines) {
            if (line.startsWith('Accounts:')) {
                currentSection = 'accounts';
                continue;
            } else if (line.startsWith('Running instances:')) {
                currentSection = 'instances';
                continue;
            }

            if (currentSection === 'accounts') {
                const accMatch = line.match(/^\s*(\d+):\s*([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
                if (accMatch) {
                    if (currentAccount) result.accounts.push(currentAccount);
                    currentAccount = {
                        index: parseInt(accMatch[1]),
                        email: accMatch[2],
                        isActive: line.includes('(active)'),
                        quota5h: { percent: 0, text: '' },
                        quota7d: { percent: 0, text: '' }
                    };
                } else if (currentAccount && (line.includes('├ 5h:') || line.includes('5h:'))) {
                    const pctMatch = line.match(/(\d+)%/);
                    currentAccount.quota5h.percent = pctMatch ? parseInt(pctMatch[1]) : 0;
                    currentAccount.quota5h.text = line.replace(/.*5h:\s*\d+%\s*/, '').trim();
                    currentAccount.quota5h.hasReset = line.includes('resets');
                    const time5h = currentAccount.quota5h.text.match(/resets\s+(\d{1,2}:\d{2})/);
                    currentAccount.quota5h.resetTimeUTC = time5h ? time5h[1] : null;
                } else if (currentAccount && (line.includes('└ 7d:') || line.includes('7d:'))) {
                    const pctMatch = line.match(/(\d+)%/);
                    currentAccount.quota7d.percent = pctMatch ? parseInt(pctMatch[1]) : 0;
                    currentAccount.quota7d.text = line.replace(/.*7d:\s*\d+%\s*/, '').trim();
                    currentAccount.quota7d.hasReset = line.includes('resets');
                    const time7d = currentAccount.quota7d.text.match(/resets\s+((?:\w{3}\s+\d+\s+)?\d{1,2}:\d{2})/);
                    currentAccount.quota7d.resetTimeUTC = time7d ? time7d[1] : null;
                }
            } else if (currentSection === 'instances') {
                const instMatch = line.match(/^\s*●\s*(.+?)\s+~?\/([^\s]+)\s+\((.+)\)/);
                if (instMatch) {
                    result.instances.push({
                        name: instMatch[1].trim(),
                        path: '~/' + instMatch[2].trim(),
                        sessions: instMatch[3].trim()
                    });
                }
            }
        }
        if (currentAccount) result.accounts.push(currentAccount);
        return result;
    }
}

module.exports = ClaudeInterface;
