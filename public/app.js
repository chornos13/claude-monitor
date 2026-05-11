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

            // Parse Output
            const parsedData = parseCswapOutput(data.output);
            
            // Render Native UI
            renderNativeUI(parsedData, outputEl, data.autoAccounts || []);

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

    function parseCswapOutput(text) {
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
                } else if (currentAccount && line.includes('├ 5h:')) {
                    const pctMatch = line.match(/(\d+)%/);
                    currentAccount.quota5h.percent = pctMatch ? parseInt(pctMatch[1]) : 0;
                    currentAccount.quota5h.text = line.replace(/.*├ 5h:\s*\d+%\s*/, '').trim();
                } else if (currentAccount && line.includes('└ 7d:')) {
                    const pctMatch = line.match(/(\d+)%/);
                    currentAccount.quota7d.percent = pctMatch ? parseInt(pctMatch[1]) : 0;
                    currentAccount.quota7d.text = line.replace(/.*└ 7d:\s*\d+%\s*/, '').trim();
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
            data.accounts.forEach(acc => {
                const getStatusColor = (pct) => pct >= 80 ? 'danger' : pct >= 50 ? 'warning' : 'safe';
                const isAuto = autoAccounts.includes(acc.index);
                html += `
                    <div class="account-card ${acc.isActive ? 'active-account' : ''}">
                        <div class="account-header">
                            <span class="account-email">${acc.email}</span>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <button class="btn execute-btn" data-account-index="${acc.index}" title="Execute Test Prompt">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                    <span>Test</span>
                                </button>
                                ${acc.isActive ? '<span class="badge-active">Active</span>' : `<button class="btn switch-btn" data-account-index="${acc.index}">Switch</button>`}
                            </div>
                        </div>
                        <div class="quota-section">
                            <div class="quota-item">
                                <div class="quota-header">
                                    <span>5h Quota</span>
                                    <span>
                                        <strong style="color: var(--text-primary); margin-right: 4px;">${acc.quota5h.percent}%</strong>
                                        <span class="quota-reset">${acc.quota5h.text}</span>
                                    </span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill ${getStatusColor(acc.quota5h.percent)}" style="width: ${acc.quota5h.percent}%"></div>
                                </div>
                            </div>
                            <div class="quota-item">
                                <div class="quota-header">
                                    <span>7d Quota</span>
                                    <span>
                                        <strong style="color: var(--text-primary); margin-right: 4px;">${acc.quota7d.percent}%</strong>
                                        <span class="quota-reset">${acc.quota7d.text}</span>
                                    </span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill ${getStatusColor(acc.quota7d.percent)}" style="width: ${acc.quota7d.percent}%"></div>
                                </div>
                            </div>
                        </div>
                        <div class="toggle-container">
                            <label class="toggle-label">
                                Auto-Activate on Reset
                            </label>
                            <label class="switch">
                                <input type="checkbox" class="auto-toggle-btn" data-account-index="${acc.index}" ${isAuto ? 'checked' : ''}>
                                <span class="slider"></span>
                            </label>
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

    document.getElementById('refresh-logs-btn').addEventListener('click', fetchLogs);
});
