document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    const outputEl = document.getElementById('native-output');
    const errorEl = document.getElementById('error');

    // Function to fetch status from backend
    const fetchStatus = async () => {
        // UI State: Loading
        refreshBtn.classList.add('spinning');
        errorEl.classList.add('hidden');

        try {
            const response = await fetch('/api/status');
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch status');
            }

            // Render Native UI
            renderNativeUI(data.output, outputEl, data.autoAccounts || []);

            // Update Last Time
            const now = new Date();
            document.getElementById('last-update').textContent = `Last Updated: ${now.toLocaleTimeString()}`;

            // UI State: Success
            outputEl.classList.remove('hidden');

        } catch (error) {
            console.error('Error fetching cswap status:', error);
            errorEl.querySelector('p').textContent = `Error: ${error.message}`;
            
            // UI State: Error
            outputEl.classList.add('hidden');
            errorEl.classList.remove('hidden');
        } finally {
            refreshBtn.classList.remove('spinning');
        }
    };


    function formatQuotaResetText(quota) {
        if (!quota.resetTimeUTC || !quota.hasReset) return quota.text;
        const MONTHS = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
        const now = new Date();
        let resetUTC;
        const withDate = quota.resetTimeUTC.match(/^(\w{3})\s+(\d+)\s+(\d{1,2}):(\d{2})$/);
        if (withDate) {
            const [, mon, day, h, m] = withDate;
            let year = now.getUTCFullYear();
            resetUTC = new Date(Date.UTC(year, MONTHS[mon], parseInt(day), parseInt(h), parseInt(m)));
            if (resetUTC < now) resetUTC.setUTCFullYear(year + 1);
        } else {
            const [h, m] = quota.resetTimeUTC.split(':').map(Number);
            resetUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
            if (resetUTC < now) resetUTC.setUTCDate(resetUTC.getUTCDate() + 1);
        }
        const localTime = resetUTC.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const diffMs = resetUTC - now;
        const diffD = Math.floor(diffMs / 86400000);
        const diffH = Math.floor((diffMs % 86400000) / 3600000);
        const diffM = Math.floor((diffMs % 3600000) / 60000);
        const relative = diffD > 0 ? `${diffD}d ${diffH}h` : diffH > 0 ? `${diffH}h ${diffM}m` : `${diffM}m`;
        const localDate = resetUTC.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const prefix = withDate ? `${localDate} ` : '';
        return `resets ${prefix}${localTime} in ${relative}`;
    }

    function renderNativeUI(data, container, autoAccounts) {
        let html = '';

        // Accounts Section
        if (data.accounts.length > 0) {
            html += `
                <div class="section-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                    Accounts
                </div>
                <div class="cards-grid">
            `;
            const getStatusColor = (pct) => pct >= 80 ? 'danger' : pct >= 50 ? 'warning' : 'safe';
            const quotaRow = (label, q) => `
                <div class="quota-item">
                    <div class="quota-row">
                        <span class="quota-label">${label}</span>
                        <div class="progress-bar">
                            <div class="progress-fill ${getStatusColor(q.percent)}" style="width: ${q.percent}%"></div>
                        </div>
                        <span class="quota-pct">${q.percent}%</span>
                    </div>
                    <div class="quota-reset">${formatQuotaResetText(q)}</div>
                </div>
            `;
            data.accounts.forEach((acc, i) => {
                const isAuto = autoAccounts.includes(acc.index);
                const keyNum = i + 1;
                html += `
                    <div class="account-card ${acc.isActive ? 'active-account' : ''}">
                        <div class="card-head">
                            ${keyNum <= 9 ? `<span class="account-key" title="Press ${keyNum} to switch to this account">${keyNum}</span>` : ''}
                            <span class="account-email" title="${acc.email}">${acc.email}</span>
                            ${acc.isActive ? '<span class="status-pill"><span class="status-dot"></span>Active</span>' : ''}
                        </div>
                        <div class="quota-section">
                            ${quotaRow('5h', acc.quota5h)}
                            ${quotaRow('7d', acc.quota7d)}
                        </div>
                        <div class="card-foot">
                            <label class="auto-toggle" title="Auto-activate this account when its quota resets">
                                <span class="switch">
                                    <input type="checkbox" class="auto-toggle-btn" data-account-index="${acc.index}" ${isAuto ? 'checked' : ''}>
                                    <span class="slider"></span>
                                </span>
                                <span>Auto</span>
                            </label>
                            <div class="account-actions">
                                <button class="btn execute-btn" data-account-index="${acc.index}" title="${acc.isActive ? 'Press T to test the active account' : 'Run the test prompt'}">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                    <span>Test</span>
                                    ${acc.isActive ? '<kbd class="key-hint">T</kbd>' : ''}
                                </button>
                                ${acc.isActive ? '' : `<button class="btn switch-btn" data-account-index="${acc.index}" title="Press ${keyNum} to switch to this account">Switch</button>`}
                            </div>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        // Instances Section
        if (data.instances.length > 0) {
            html += `
                <div class="section-title" style="margin-top: 1rem;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                    Running Instances
                </div>
                <div class="instance-list">
            `;
            data.instances.forEach(inst => {
                html += `
                    <div class="instance-item">
                        <div class="instance-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                        </div>
                        <div class="instance-details">
                            <div class="instance-name">${inst.name}</div>
                            <div class="instance-path">${inst.path}</div>
                        </div>
                        <div class="instance-sessions">${inst.sessions}</div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        container.innerHTML = html || '<p style="color:var(--text-secondary)">No data available.</p>';

        // Add event listeners for toggles
        container.querySelectorAll('.auto-toggle-btn').forEach(btn => {
            btn.addEventListener('change', async (e) => {
                const isChecked = e.target.checked;
                const accIndex = parseInt(e.target.dataset.accountIndex);
                try {
                    const res = await fetch('/api/toggle-auto', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ accountIndex: accIndex, enabled: isChecked })
                    });
                    if (!res.ok) throw new Error('Failed to toggle');
                } catch(err) {
                    console.error(err);
                    e.target.checked = !isChecked; // Revert visually on error
                    alert('Error toggling auto-activate. Check console.');
                }
            });
        });

        // Add event listeners for switch buttons
        container.querySelectorAll('.switch-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const accIndex = parseInt(e.target.dataset.accountIndex);
                const originalText = e.target.textContent;
                
                try {
                    e.target.disabled = true;
                    e.target.textContent = 'Switching...';
                    
                    const res = await fetch('/api/switch-account', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ accountIndex: accIndex })
                    });
                    
                    if (!res.ok) {
                        const errorData = await res.json();
                        throw new Error(errorData.error || 'Failed to switch account');
                    }
                    
                    // The SSE stream will trigger a refresh via 'status-refresh' event
                } catch(err) {
                    console.error(err);
                    alert(`Error switching account: ${err.message}`);
                    e.target.disabled = false;
                    e.target.textContent = originalText;
                }
            });
        });

        // Add event listeners for execute buttons
        container.querySelectorAll('.execute-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const targetBtn = e.currentTarget;
                const accIndex = parseInt(targetBtn.dataset.accountIndex);
                const originalContent = targetBtn.innerHTML;
                
                try {
                    targetBtn.disabled = true;
                    targetBtn.classList.add('running');
                    targetBtn.querySelector('span').textContent = 'Running...';
                    
                    const res = await fetch('/api/execute-test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ accountIndex: accIndex })
                    });
                    
                    if (!res.ok) {
                        const errorData = await res.json();
                        throw new Error(errorData.error || 'Failed to execute test');
                    }
                    
                } catch(err) {
                    console.error(err);
                    alert(`Error executing test: ${err.message}`);
                } finally {
                    targetBtn.disabled = false;
                    targetBtn.classList.remove('running');
                    targetBtn.innerHTML = originalContent;
                }
            });
        });
    }

    // Real-time log streaming via SSE
    const auditOutput = document.getElementById('audit-output');
    const auditTerminal = document.querySelector('.audit-terminal');

    const fetchLogs = async () => {
        const refreshLogsBtn = document.getElementById('refresh-logs-btn');
        try {
            refreshLogsBtn.textContent = 'Refreshing...';
            const res = await fetch('/api/logs');
            const data = await res.json();
            auditOutput.textContent = data.logs && data.logs.length > 0
                ? data.logs.join('\n')
                : 'No logs yet...';
            requestAnimationFrame(() => {
                if (auditTerminal) auditTerminal.scrollTop = auditTerminal.scrollHeight;
            });
        } catch (err) {
            auditOutput.textContent = 'Failed to load logs.';
        } finally {
            document.getElementById('refresh-logs-btn').textContent = 'Refresh Logs';
        }
    };

    // Subscribe to real-time log stream
    const setupLogStream = () => {
        const evtSource = new EventSource('/api/logs/stream');

        // Real-time log lines
        evtSource.addEventListener('log', (e) => {
            const line = JSON.parse(e.data);
            if (auditOutput.textContent === 'No logs yet...' || auditOutput.textContent === 'Loading logs...') {
                auditOutput.textContent = line;
            } else {
                auditOutput.textContent += '\n' + line;
            }
            requestAnimationFrame(() => {
                if (auditTerminal) auditTerminal.scrollTop = auditTerminal.scrollHeight;
            });
        });

        evtSource.addEventListener('logs-cleared', () => {
            auditOutput.textContent = 'No logs yet...';
        });

        // Server triggered status refresh (after cron execution)
        evtSource.addEventListener('status-refresh', () => {
            fetchStatus();
        });

        evtSource.onerror = () => {
            evtSource.close();
            setTimeout(setupLogStream, 3000);
        };
    };

    // Initial fetch
    fetchStatus();
    fetchLogs().then(() => setupLogStream());

    // Event listener for refresh button
    refreshBtn.addEventListener('click', () => {
        fetchStatus();
        fetchLogs();
    });

    // Keyboard shortcuts: "R" refreshes status, "1"-"9" switch to the matching
    // account card, "T" runs the Test prompt on the active account.
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            fetchStatus();
            fetchLogs();
            return;
        }

        if (e.key === 't' || e.key === 'T') {
            const btn = document.querySelector('.active-account .execute-btn');
            if (btn && !btn.disabled) {
                e.preventDefault();
                btn.click();
            }
            return;
        }

        if (e.key >= '1' && e.key <= '9') {
            const card = document.querySelectorAll('.account-card')[parseInt(e.key) - 1];
            const btn = card && card.querySelector('.switch-btn');
            if (btn && !btn.disabled) {
                e.preventDefault();
                btn.click();
            }
        }
    });

    document.getElementById('refresh-logs-btn').addEventListener('click', fetchLogs);

    document.getElementById('clear-logs-btn').addEventListener('click', async () => {
        await fetch('/api/logs', { method: 'DELETE' });
        auditOutput.textContent = 'No logs yet...';
    });
});
