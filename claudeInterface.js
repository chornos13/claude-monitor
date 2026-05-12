const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

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
     * Switches to the target account.
     */
    async switchToAccount(index) {
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
     * Deep Function: Runs a test prompt on the target account.
     * It automatically handles:
     * 1. Identifying the active account.
     * 2. Switching to the target account (if necessary).
     * 3. Executing the prompt.
     * 4. Restoring the original account.
     */
    async runTestPrompt(targetIndex) {
        this.logger.log(`[ClaudeInterface] Starting test execution for account ${targetIndex}...`);
        
        // 1. Check list to find currently active account
        const status = await this.getStatus();
        const activeAccount = status.accounts.find(a => a.isActive);
        const previousActiveIndex = activeAccount ? activeAccount.index : null;
        
        this.logger.log(`[ClaudeInterface] Active account before: ${previousActiveIndex ?? 'unknown'}`);

        const needsSwitch = previousActiveIndex !== targetIndex;

        try {
            // 2. Switch if not the same index
            if (needsSwitch) {
                await this.switchToAccount(targetIndex);
            }

            // 3. Run claude
            const claudeCmd = `claude -p "1+1=" --model claude-haiku-4-5-20251001 < /dev/null`;
            this.logger.log(`[ClaudeInterface] Executing claude command for account ${targetIndex}...`);
            const { stdout, stderr } = await execAsync(claudeCmd);
            
            const result = stdout.trim() || '(no output)';
            this.logger.log(`[ClaudeInterface] Claude Output for account ${targetIndex}: ${result}`);
            if (stderr) this.logger.log(`[ClaudeInterface] Claude Stderr: ${stderr.trim()}`);

            return { success: true, output: result };

        } catch (error) {
            this.logger.log(`[ClaudeInterface] Execution Error for account ${targetIndex}: ${error.message}`);
            throw error;
        } finally {
            // 4. Restore active account if we displaced a different one
            if (needsSwitch && previousActiveIndex !== null) {
                this.logger.log(`[ClaudeInterface] Restoring active account to ${previousActiveIndex}...`);
                try {
                    await this.switchToAccount(previousActiveIndex);
                    this.logger.log(`[ClaudeInterface] Restored account ${previousActiveIndex}.`);
                } catch (restoreErr) {
                    this.logger.log(`[ClaudeInterface] Restore Error: ${restoreErr.message}`);
                    // We don't throw here to avoid masking the primary result/error
                }
            }
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
