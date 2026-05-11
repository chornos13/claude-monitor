const path = require('path');
const fs = require('fs');
const ClaudeInterface = require('./claudeInterface');

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3005;

const claude = new ClaudeInterface({ log: writeLog });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const STATE_FILE = path.join(__dirname, 'state.json');

// Load persisted state (autoAccounts) from disk
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.autoAccounts)) {
                parsed.autoAccounts.forEach(idx => autoAccounts.add(idx));
                console.log(`[State] Loaded autoAccounts: [${parsed.autoAccounts.join(', ')}]`);
            }
        }
    } catch (e) {
        console.error('[State] Failed to load state.json:', e.message);
    }
}

function saveState() {
    const state = { autoAccounts: Array.from(autoAccounts) };
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
        if (err) console.error('[State] Failed to save state.json:', err.message);
    });
}

const autoAccounts = new Set();
const activeTimeouts = new Map();

// SSE clients for real-time log streaming
const sseClients = new Set();

function broadcastEvent(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        client.write(payload);
    }
}
function writeLog(msg) {
    const timestamp = new Date().toISOString();
    const logStr = `[${timestamp}] ${msg}`;
    console.log(logStr);
    fs.appendFile(path.join(__dirname, 'audit.log'), logStr + '\n', (err) => {
        if (err) console.error("Failed to write to audit.log", err);
    });
    // Push to all connected SSE clients
    broadcastEvent('log', logStr);
}

// API endpoint to execute cswap --list
app.get('/api/status', async (req, res) => {
    try {
        const data = await claude.getStatus();
        
        // Schedule auto-activations based on current status
        parseAndScheduleCron(data);

        res.json({ 
            output: data, // Structured data!
            autoAccounts: Array.from(autoAccounts)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// SSE endpoint for real-time log streaming
app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    // Send a heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

// API endpoint to get logs
app.get('/api/logs', (req, res) => {
    const logPath = path.join(__dirname, 'audit.log');
    if (fs.existsSync(logPath)) {
        fs.readFile(logPath, 'utf8', (err, data) => {
            if (err) return res.status(500).json({ error: "Cannot read logs" });
            const lines = data.split('\n').filter(Boolean).slice(-50); // last 50
            res.json({ logs: lines });
        });
    } else {
        res.json({ logs: [] });
    }
});

function clearTimeoutsForAccount(accIndex) {
    if (activeTimeouts.has(accIndex)) {
        const timeouts = activeTimeouts.get(accIndex);
        for (const [timeStr, timeoutId] of timeouts.entries()) {
            clearTimeout(timeoutId);
        }
        timeouts.clear();
        writeLog(`[Scheduler] Cleared pending tasks for Account ${accIndex}`);
    }
}

app.post('/api/toggle-auto', (req, res) => {
    const { accountIndex, enabled } = req.body;
    if (accountIndex === undefined || accountIndex === null) return res.status(400).json({ error: "Missing accountIndex" });
    
    if (enabled) {
        autoAccounts.add(accountIndex);
        saveState();
        writeLog(`[API] Auto-activate enabled for Account ${accountIndex}`);
        preCalculateForAccount(accountIndex);
    } else {
        autoAccounts.delete(accountIndex);
        saveState();
        writeLog(`[API] Auto-activate disabled for Account ${accountIndex}`);
        clearTimeoutsForAccount(accountIndex);
    }
    // NOTE: We do NOT re-parse cswap here to avoid double-scheduling.
    // The frontend will call /api/status after toggle which handles scheduling.
    res.json({ success: true, autoAccounts: Array.from(autoAccounts) });
});

app.post('/api/switch-account', async (req, res) => {
    const { accountIndex } = req.body;
    if (accountIndex === undefined || accountIndex === null) return res.status(400).json({ error: "Missing accountIndex" });

    try {
        writeLog(`[API] Manually switching to Account ${accountIndex}...`);
        await claude.switchToAccount(accountIndex);
        broadcastEvent('status-refresh', {});
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/execute-test', async (req, res) => {
    const { accountIndex } = req.body;
    if (accountIndex === undefined || accountIndex === null) return res.status(400).json({ error: "Missing accountIndex" });

    try {
        const result = await claude.runTestPrompt(accountIndex);
        broadcastEvent('status-refresh', {});
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function preCalculateForAccount(accIndex) {
    try {
        const data = await claude.getStatus();
        const acc = data.accounts.find(a => a.index === accIndex);
        if (!acc) return;

        const quotas = [acc.quota5h, acc.quota7d];
        const hasAvailableNow = quotas.some(q => !q.hasReset && q.percent < 100);

        if (hasAvailableNow) {
            writeLog(`[Pre-calc] Account ${accIndex}: quota available NOW — will trigger immediately`);
            return;
        }

        // Note: The logic for calculating future reset times from text is still simplified here
        // Ideally we'd parse the relative "in 5h" or absolute times more robustly.
    } catch (err) {
        // Silent error for background task
    }
}

function parseAndScheduleCron(data) {
    // If we received a string (old behavior), we should warn or handle, 
    // but the new ClaudeInterface returns structured data.
    if (typeof data === 'string') return; 

    data.accounts.forEach(acc => {
        if (!autoAccounts.has(acc.index)) return;

        const quotas = [acc.quota5h, acc.quota7d];
        let scheduled = false;

        quotas.forEach(q => {
            if (q.hasReset) {
                // Extracts the time from strings like "resets 15:00 in 2h"
                const timeMatch = q.text.match(/resets\s+(.*?)\s+in/);
                if (timeMatch) {
                    scheduleTask(acc.index, timeMatch[1].trim());
                    scheduled = true;
                }
            }
        });

        if (!scheduled && acc.quota7d.percent < 100) {
            writeLog(`[Scheduler] Account ${acc.index}: quota available now, scheduling immediate activation`);
            scheduleTask(acc.index, '__immediate__');
        }
    });
}

/**
 * Helper to switch to an account, run the test prompt, and switch back.
 */
function scheduleTask(accIndex, timeStr) {
    if (!activeTimeouts.has(accIndex)) {
        activeTimeouts.set(accIndex, new Map());
    }
    const accTimeouts = activeTimeouts.get(accIndex);

    if (accTimeouts.has(timeStr)) return;

    let delay;
    if (timeStr === '__immediate__') {
        delay = 2000;
        writeLog(`[Scheduler] Account ${accIndex}: immediate activation in 2s`);
    } else {
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
        delay = targetDate.getTime() - Date.now() + 60000 + Math.floor(Math.random() * 60000);
        if (!(delay > 0 && delay < 2147483647)) return;
        const executeDate = new Date(Date.now() + delay);
        writeLog(`[Scheduler] Account ${accIndex} scheduled for auto-activation at ${executeDate.toLocaleString()} (in ~${Math.round(delay/60000)}m)`);
    }

    const timeoutId = setTimeout(async () => {
        writeLog(`[Scheduler] Timeout fired for Account ${accIndex}, enabled=${autoAccounts.has(accIndex)}`);
        if (!autoAccounts.has(accIndex)) {
            if (activeTimeouts.has(accIndex)) activeTimeouts.get(accIndex).delete(timeStr);
            return;
        }

        try {
            await claude.runTestPrompt(accIndex);
        } catch (err) {
            // Error already logged by ClaudeInterface
        } finally {
            if (activeTimeouts.has(accIndex)) activeTimeouts.get(accIndex).delete(timeStr);
        }
    }, delay);

    accTimeouts.set(timeStr, timeoutId);
}

setInterval(async () => {
    if (autoAccounts.size > 0) {
        try {
            const data = await claude.getStatus();
            parseAndScheduleCron(data);
        } catch (err) {}
    }
}, 5 * 60 * 1000);

app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);

    // Restore persisted auto-accounts and re-schedule their cron jobs
    loadState();
    if (autoAccounts.size > 0) {
        console.log(`[State] Restoring schedules for accounts: [${Array.from(autoAccounts).join(', ')}]`);
        try {
            const data = await claude.getStatus();
            parseAndScheduleCron(data);
        } catch (err) {}
    }
});
