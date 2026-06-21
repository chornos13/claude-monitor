const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const execAsync = promisify(exec);

// The cswap account store ($XDG_DATA_HOME/claude-swap, default ~/.local/share).
const STORE_PARENT = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const STORE_DIR = path.join(STORE_PARENT, 'claude-swap');

/**
 * ClaudeInterface Module
 * 
 * Deep module that encapsulates interaction with cswap and claude CLI tools.
 * It provides a high-leverage interface for listing accounts, switching,
 * and executing commands.
 */
class ClaudeInterface {
    constructor(logger) {
        this.logger = logger || { log: console.log };
        // Serializes manual switchToAccount calls, which mutate the global
        // active account (cswap --switch-to writes the single ~/.claude.json).
        // Tests don't use this — they run sandboxed (see runTestPrompt).
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
            const { stdout } = await execAsync('cswap --list');
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
     * Internal: performs the switch without acquiring the lock.
     */
    async _switchToAccountUnlocked(index) {
        try {
            this.logger.log(`[ClaudeInterface] Switching to account ${index}...`);
            await execAsync(`cswap --switch-to ${index}`);
            this.logger.log(`[ClaudeInterface] Successfully switched to account ${index}.`);
        } catch (error) {
            this.logger.log(`[ClaudeInterface] Switch Error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deep Function: Runs a test prompt on the target account in a fully
     * isolated sandbox, so it NEVER touches the host's live credentials.
     *
     * The leak it prevents: `cswap --switch-to` rewrites the shared
     * ~/.claude.json + ~/.claude/.credentials.json (and the store's
     * activeAccountNumber). With the host home bind-mounted, that hijacks the
     * account under any live `claude` terminal/extension session.
     *
     * Isolation: cswap and claude both honour CLAUDE_CONFIG_DIR for the
     * config/credentials they write/read, and XDG_DATA_HOME for the account
     * store. We point both at a throwaway temp dir holding a private copy of
     * the store. The switch and run happen entirely inside it; the host's
     * files and the shared store are untouched. No switch/restore, no lock —
     * each test is self-contained, so concurrent tests can't collide.
     */
    async runTestPrompt(targetIndex) {
        this.logger.log(`[ClaudeInterface] Starting isolated test for account ${targetIndex}...`);
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cswap-test-'));
        const env = {
            ...process.env,
            CLAUDE_CONFIG_DIR: path.join(sandbox, 'config'),
            XDG_DATA_HOME: path.join(sandbox, 'data'),
        };
        try {
            await fs.mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
            // Private copy of the account store so the switch's bookkeeping
            // (activeAccountNumber) stays inside the sandbox too.
            await fs.cp(STORE_DIR, path.join(env.XDG_DATA_HOME, 'claude-swap'), { recursive: true });

            await execAsync(`cswap --switch-to ${targetIndex}`, { env });

            const claudeCmd = `claude -p "1+1=" --model claude-sonnet-4-6 < /dev/null`;
            this.logger.log(`[ClaudeInterface] Executing claude command for account ${targetIndex}...`);
            const { stdout, stderr } = await execAsync(claudeCmd, { env });

            const result = stdout.trim() || '(no output)';
            this.logger.log(`[ClaudeInterface] Claude Output for account ${targetIndex}: ${result}`);
            if (stderr) this.logger.log(`[ClaudeInterface] Claude Stderr: ${stderr.trim()}`);

            return { success: true, output: result };
        } catch (error) {
            this.logger.log(`[ClaudeInterface] Execution Error for account ${targetIndex}: ${error.message}`);
            throw error;
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
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
