import { describe, it, expect } from 'vitest';
const Scheduler = require('./scheduler');

// Auto-activate schedules ONLY on a real quota reset. An account with no
// pending reset must arm nothing (the old __immediate__ fallback busy-looped).
const noReset = {
    index: 0,
    quota5h: { hasReset: false, text: '', percent: 50 },
    quota7d: { hasReset: false, text: '', percent: 50 },
};
const withReset = {
    index: 1,
    quota5h: { hasReset: true, text: 'resets 23:59 in 2h', percent: 100 },
    quota7d: { hasReset: false, text: '', percent: 80 },
};

describe('Scheduler.sync', () => {
    it('schedules only on real resets and never busy-loops', async () => {
        let runs = 0;
        const sched = new Scheduler({
            logger: { log: () => {} },
            onExecute: async () => { runs++; },
        });

        sched.sync([noReset, withReset], [0, 1]);

        expect(sched.activeTimeouts.has(0)).toBe(false);
        expect(sched.activeTimeouts.get(1)?.size).toBe(1);

        // Repeated syncs (status polls) must not pile up or fire early.
        sched.sync([noReset, withReset], [0, 1]);
        await new Promise(r => setTimeout(r, 300));
        expect(sched.activeTimeouts.get(1).size).toBe(1);
        expect(runs).toBe(0);

        sched.clear(0);
        sched.clear(1);
    });
});
