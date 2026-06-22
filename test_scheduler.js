// Regression check: auto-activate schedules ONLY on a real quota reset.
// An account with no pending reset must arm nothing (the old __immediate__
// fallback busy-looped here). Run: node test_scheduler.js
const assert = require('assert');
const Scheduler = require('./scheduler');

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

(async () => {
    let runs = 0;
    const sched = new Scheduler({
        logger: { log: () => {} },
        onExecute: async () => { runs++; },
    });

    sched.sync([noReset, withReset], [0, 1]);

    // No-reset account: nothing armed. Reset account: one timer armed.
    assert.strictEqual(sched.activeTimeouts.has(0), false, 'no-reset account must not be scheduled');
    assert.strictEqual(sched.activeTimeouts.get(1)?.size, 1, 'reset account must arm exactly one timer');

    // Repeated syncs (status polls) must not pile up or fire anything early.
    sched.sync([noReset, withReset], [0, 1]);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(sched.activeTimeouts.get(1).size, 1, 'duplicate sync must not double-arm');
    assert.strictEqual(runs, 0, 'nothing should fire immediately');

    sched.clear(0); sched.clear(1);
    console.log('ok: schedules only on real resets, no busy-loop');
})();
