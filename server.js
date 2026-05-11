const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3005;

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
app.get('/api/status', (req, res) => {
    exec('cswap --list', (error, stdout, stderr) => {
        if (error) {
            writeLog(`[Error] Failed to execute cswap: ${error.message}`);
            return res.status(500).json({ error: error.message });
        }
        
        parseAndScheduleCron(stdout);

        res.json({ 
            output: stdout,
            autoAccounts: Array.from(autoAccounts)
        });
    });
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

app.post('/api/switch-account', (req, res) => {
    const { accountIndex } = req.body;
    if (accountIndex === undefined || accountIndex === null) return res.status(400).json({ error: "Missing accountIndex" });

    writeLog(`[API] Manually switching to Account ${accountIndex}...`);
    exec(`cswap --switch-to ${accountIndex}`, (error, stdout, stderr) => {
        if (error) {
            writeLog(`[API] Switch Error: ${error.message}`);
            return res.status(500).json({ error: error.message });
        }
        writeLog(`[API] Switch Success: Switched to Account ${accountIndex}.`);
        broadcastEvent('status-refresh', {});
        res.json({ success: true });
    });
});

app.post('/api/execute-test', (req, res) => {
    const { accountIndex } = req.body;
    if (accountIndex === undefined || accountIndex === null) return res.status(400).json({ error: "Missing accountIndex" });

    executeClaudeTest(accountIndex, 'API', (err, stdout) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, output: stdout });
    });
});

function preCalculateForAccount(accIndex) {
    exec('cswap --list', (err, stdout) => {
        if (err) return;

        const lines = stdout.split('\n');
        let inAccount = false;
        let has5hReset = false;
        let quota7dPercent = 100;
        const resetTimes = [];

        for (const line of lines) {
            const accMatch = line.match(/^\s*(\d+):\s*[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/);
            if (accMatch) {
                inAccount = parseInt(accMatch[1]) === accIndex;
                continue;
            }
            if (!inAccount) continue;

            const resetMatch = line.match(/resets\s+(.*?)\s+in/);
            if (resetMatch) {
                const timeStr = resetMatch[1].trim();
                if (line.includes('├') || line.includes('5h:')) has5hReset = true;
                resetTimes.push({ timeStr, line });
            }
            if (line.includes('7d:') || line.includes('└')) {
                const pctMatch = line.match(/(\d+)%/);
                if (pctMatch) quota7dPercent = parseInt(pctMatch[1]);
            }
        }

        if (!has5hReset && quota7dPercent < 100) {
            writeLog(`[Pre-calc] Account ${accIndex}: 5h quota available NOW — will trigger immediately`);
            return;
        }

        for (const { timeStr } of resetTimes) {
            let targetDate;
            if (timeStr.includes(':') && timeStr.length <= 5) {
                const [hh, mm] = timeStr.split(':').map(Number);
                targetDate = new Date();
                targetDate.setHours(hh, mm, 0, 0);
                if (targetDate.getTime() < Date.now()) targetDate.setDate(targetDate.getDate() + 1);
            } else {
                const year = new Date().getFullYear();
                targetDate = new Date(`${timeStr} ${year}`);
                if (targetDate.getTime() < Date.now()) targetDate.setFullYear(year + 1);
            }
            const fireAt = new Date(targetDate.getTime() + 60000 + 30000); // +1min +~30s avg jitter
            const inMin = Math.round((fireAt - Date.now()) / 60000);
            writeLog(`[Pre-calc] Account ${accIndex}: will trigger at ~${fireAt.toLocaleString()} (in ~${inMin}m) based on reset "${timeStr}"`);
        }
    });
}

function parseAndScheduleCron(output) {
    const lines = output.split('\n');
    let currentAccountIndex = null;
    // Track per-account state within this parse pass
    const accountState = {}; // { index: { has5hReset, has7dReset, quota7dPercent } }

    lines.forEach(line => {
        const accMatch = line.match(/^\s*(\d+):\s*[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/);
        if (accMatch) {
            currentAccountIndex = parseInt(accMatch[1]);
            if (!accountState[currentAccountIndex]) {
                accountState[currentAccountIndex] = { has5hReset: false, has7dReset: false, quota7dPercent: 100 };
            }
        }

        if (currentAccountIndex && autoAccounts.has(currentAccountIndex)) {
            const state = accountState[currentAccountIndex];

            // Check for reset time lines
            const resetMatch = line.match(/resets\s+(.*?)\s+in/);
            if (resetMatch) {
                const timeStr = resetMatch[1].trim();
                if (line.includes('5h:') || line.includes('├')) {
                    state.has5hReset = true;
                    scheduleTask(currentAccountIndex, timeStr);
                } else if (line.includes('7d:') || line.includes('└')) {
                    state.has7dReset = true;
                    scheduleTask(currentAccountIndex, timeStr);
                } else {
                    // Generic reset — schedule it
                    scheduleTask(currentAccountIndex, timeStr);
                }
            }

            // Track 7d quota percentage
            if (line.includes('└ 7d:') || line.includes('7d:')) {
                const pctMatch = line.match(/(\d+)%/);
                if (pctMatch) state.quota7dPercent = parseInt(pctMatch[1]);
            }
        }
    });

    // After parsing all lines: if an account has no 5h reset (quota available now)
    // but 7d quota is not exhausted, schedule an immediate execution
    for (const [idxStr, state] of Object.entries(accountState)) {
        const accIndex = parseInt(idxStr);
        if (!autoAccounts.has(accIndex)) continue;
        if (!state.has5hReset && state.quota7dPercent < 100) {
            writeLog(`[Scheduler] Account ${accIndex}: 5h quota available now, scheduling immediate activation`);
            scheduleTask(accIndex, '__immediate__');
        }
    }
}

/**
 * Helper to switch to an account, run the test prompt, and switch back.
 */
function executeClaudeTest(accIndex, reqSource = 'Scheduler', callback = null) {
    writeLog(`[${reqSource}] Target Account ${accIndex}: starting test execution...`);
    
    // 1. Check list to find currently active account
    exec('cswap --list', (listErr, listOut) => {
        // 2. Check index
        let previousActiveIndex = null;
        if (!listErr) {
            const activeMatch = listOut.match(/^\s*(\d+):\s*\S+.*\(active\)/m);
            if (activeMatch) previousActiveIndex = parseInt(activeMatch[1]);
        }
        writeLog(`[${reqSource}] Active account before: ${previousActiveIndex ?? 'unknown'}`);

        const needsSwitch = previousActiveIndex !== accIndex;
        
        // Helper to run the claude command (Step 4 & 5)
        const runClaude = () => {
            const claudeCmd = `claude -p "1+1=" --model claude-haiku-4-5-20251001 < /dev/null`;
            exec(claudeCmd, (err, stdout, stderr) => {
                // 5. Log the output
                if (err) {
                    writeLog(`[${reqSource}] Claude Error for Account ${accIndex}: ${err.message}`);
                    if (stderr) writeLog(`[${reqSource}] Stderr: ${stderr.trim()}`);
                } else {
                    writeLog(`[${reqSource}] Claude Output for Account ${accIndex}: ${stdout.trim() || '(no output)'}`);
                }
                
                // 6. Refresh list in UI
                broadcastEvent('status-refresh', {});

                // Step 7: Switch back if we displaced a different active account
                if (needsSwitch && previousActiveIndex !== null) {
                    writeLog(`[${reqSource}] Restoring active account to ${previousActiveIndex}...`);
                    exec(`cswap --switch-to ${previousActiveIndex}`, (restoreErr) => {
                        if (restoreErr) {
                            writeLog(`[${reqSource}] Restore Error: ${restoreErr.message}`);
                        } else {
                            writeLog(`[${reqSource}] Restored account ${previousActiveIndex}.`);
                            broadcastEvent('status-refresh', {});
                        }
                        if (callback) callback(err, stdout);
                    });
                } else {
                    if (callback) callback(err, stdout);
                }
            });
        };

        // 3. If not the same index, switch first
        if (needsSwitch) {
            writeLog(`[${reqSource}] Switching to account ${accIndex}...`);
            exec(`cswap --switch-to ${accIndex}`, (switchErr) => {
                if (switchErr) {
                    writeLog(`[${reqSource}] Switch Error: ${switchErr.message}`);
                    if (callback) callback(switchErr);
                    return;
                }
                runClaude();
            });
        } else {
            runClaude();
        }
    });
}

function scheduleTask(accIndex, timeStr) {
    if (!activeTimeouts.has(accIndex)) {
        activeTimeouts.set(accIndex, new Map());
    }
    const accTimeouts = activeTimeouts.get(accIndex);

    if (accTimeouts.has(timeStr)) return;

    let delay;
    if (timeStr === '__immediate__') {
        // 5h quota already available — fire in 2 seconds
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
        // reset time + 1 min + random 0–60s
        delay = targetDate.getTime() - Date.now() + 60000 + Math.floor(Math.random() * 60000);
        if (!(delay > 0 && delay < 2147483647)) return;
        const executeDate = new Date(Date.now() + delay);
        writeLog(`[Scheduler] Account ${accIndex} scheduled for auto-activation at ${executeDate.toLocaleString()} (in ~${Math.round(delay/60000)}m)`);
    }

    const timeoutId = setTimeout(() => {
        writeLog(`[Scheduler] Timeout fired for Account ${accIndex}, enabled=${autoAccounts.has(accIndex)}`);
        if (!autoAccounts.has(accIndex)) {
            if (activeTimeouts.has(accIndex)) activeTimeouts.get(accIndex).delete(timeStr);
            return;
        }

        // Execute the test prompt using the helper
        executeClaudeTest(accIndex, 'Scheduler', () => {
            if (activeTimeouts.has(accIndex)) activeTimeouts.get(accIndex).delete(timeStr);
        });
    }, delay);

    accTimeouts.set(timeStr, timeoutId);
}

setInterval(() => {
    if (autoAccounts.size > 0) {
        exec('cswap --list', (error, stdout) => {
            if (!error) parseAndScheduleCron(stdout);
        });
    }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);

    // Restore persisted auto-accounts and re-schedule their cron jobs
    loadState();
    if (autoAccounts.size > 0) {
        console.log(`[State] Restoring schedules for accounts: [${Array.from(autoAccounts).join(', ')}]`);
        exec('cswap --list', (error, stdout) => {
            if (!error) parseAndScheduleCron(stdout);
        });
    }
});
