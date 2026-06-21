/**
 * Scheduler Module
 * 
 * Deep module that manages the Auto-Activate timing logic.
 * It hides the complexity of timeout management and date/delay calculations.
 */
class Scheduler {
    constructor(options = {}) {
        this.logger = options.logger || { log: console.log };
        this.onExecute = options.onExecute || (async () => {});
        this.activeTimeouts = new Map(); // Map<accountIndex, Map<timeStr, timeoutId>>
    }

    /**
     * Synchronizes the schedule with the latest account data.
     * Idempotent: Can be called repeatedly with current state.
     */
    sync(accounts, autoAccountIndices) {
        const autoAccountSet = new Set(autoAccountIndices);

        accounts.forEach(acc => {
            if (!autoAccountSet.has(acc.index)) {
                this.clear(acc.index);
                return;
            }

            const quotas = [acc.quota5h, acc.quota7d];
            let scheduled = false;

            quotas.forEach(q => {
                if (q.hasReset) {
                    // Extracts the time from strings like "resets 15:00 in 2h"
                    const timeMatch = q.text.match(/resets\s+(.*?)\s+in/);
                    if (timeMatch) {
                        this._scheduleTask(acc.index, timeMatch[1].trim());
                        scheduled = true;
                    }
                }
            });

            // If no future resets are found but account is not exhausted, schedule immediate
            if (!scheduled && acc.quota7d.percent < 100) {
                this._scheduleTask(acc.index, '__immediate__');
            }
        });
    }

    /**
     * Clears all pending tasks for a specific account.
     */
    clear(accIndex) {
        const timeouts = this.activeTimeouts.get(accIndex);
        // No-op (and no log) unless there are actually pending timers. sync()
        // calls clear() for every non-auto account on each status refresh; an
        // emptied-but-present Map key would otherwise re-log on every refresh.
        if (!timeouts || timeouts.size === 0) return;
        for (const timeoutId of timeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.activeTimeouts.delete(accIndex);
        this.logger.log(`[Scheduler] Cleared all pending tasks for Account ${accIndex}`);
    }

    /**
     * Internal: Schedules a single task with jitter.
     */
    _scheduleTask(accIndex, timeStr) {
        if (!this.activeTimeouts.has(accIndex)) {
            this.activeTimeouts.set(accIndex, new Map());
        }
        const accTimeouts = this.activeTimeouts.get(accIndex);

        if (accTimeouts.has(timeStr)) return;

        const delay = this._calculateDelay(timeStr);
        if (delay === null) return;

        const executeDate = new Date(Date.now() + delay);
        const logMsg = timeStr === '__immediate__' 
            ? `immediate activation in 2s` 
            : `scheduled for auto-activation at ${executeDate.toLocaleString()} (in ~${Math.round(delay/60000)}m)`;
        
        this.logger.log(`[Scheduler] Account ${accIndex} ${logMsg}`);

        const timeoutId = setTimeout(async () => {
            this.logger.log(`[Scheduler] Timeout fired for Account ${accIndex} (${timeStr})`);

            try {
                await this.onExecute(accIndex);
            } catch (err) {
                this.logger.log(`[Scheduler] Task execution failed for Account ${accIndex}: ${err.message}`);
            } finally {
                // Cleanup tracking only AFTER execution. Deleting it earlier
                // lets a concurrent sync() (status poll / 5-min interval) see
                // the slot free and re-schedule the same task mid-flight,
                // double-firing it.
                if (this.activeTimeouts.has(accIndex)) {
                    this.activeTimeouts.get(accIndex).delete(timeStr);
                }
            }
        }, delay);

        accTimeouts.set(timeStr, timeoutId);
    }

    /**
     * Internal: Calculates delay in ms with hardcoded jitter.
     */
    _calculateDelay(timeStr) {
        if (timeStr === '__immediate__') return 2000;

        let targetDate;
        if (timeStr.includes(':') && timeStr.length <= 5) {
            const [hh, mm] = timeStr.split(':').map(Number);
            targetDate = new Date();
            targetDate.setHours(hh, mm, 0, 0);
            if (targetDate.getTime() < Date.now()) {
                targetDate.setDate(targetDate.getDate() + 1);
            }
        } else {
            const year = new Date().getFullYear();
            targetDate = new Date(`${timeStr} ${year}`);
            if (targetDate.getTime() < Date.now()) {
                targetDate.setFullYear(year + 1);
            }
        }

        // Delay = reset time + 1 min + random 0–60s (hardcoded jitter)
        const delay = targetDate.getTime() - Date.now() + 60000 + Math.floor(Math.random() * 60000);
        
        // Ensure delay is valid for setTimeout
        if (delay > 0 && delay < 2147483647) return delay;
        return null;
    }
}

module.exports = Scheduler;
