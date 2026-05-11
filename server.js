const path = require('path');
const fs = require('fs');
const ClaudeInterface = require('./claudeInterface');
const Scheduler = require('./scheduler');

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3005;

const claude = new ClaudeInterface({ log: writeLog });
const scheduler = new Scheduler({ 
    logger: writeLog, 
    onExecute: async (index) => {
        await claude.runTestPrompt(index);
        broadcastEvent('status-refresh', {});
    }
});

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
        
        // 1. Sync scheduler with new status
        scheduler.sync(data.accounts, Array.from(autoAccounts));

        res.json({ 
            output: data,
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


app.post('/api/toggle-auto', (req, res) => {
    const { accountIndex, enabled } = req.body;
    if (accountIndex === undefined || accountIndex === null) return res.status(400).json({ error: "Missing accountIndex" });
    
    if (enabled) {
        autoAccounts.add(accountIndex);
        saveState();
        writeLog(`[API] Auto-activate enabled for Account ${accountIndex}`);
        // Trigger a sync
        claude.getStatus().then(data => scheduler.sync(data.accounts, Array.from(autoAccounts)));
    } else {
        autoAccounts.delete(accountIndex);
        saveState();
        writeLog(`[API] Auto-activate disabled for Account ${accountIndex}`);
        scheduler.clear(accountIndex);
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


setInterval(async () => {
    if (autoAccounts.size > 0) {
        try {
            const data = await claude.getStatus();
            scheduler.sync(data.accounts, Array.from(autoAccounts));
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
            scheduler.sync(data.accounts, Array.from(autoAccounts));
        } catch (err) {}
    }
});
