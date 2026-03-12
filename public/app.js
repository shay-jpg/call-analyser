// ─── State ────────────────────────────────────────────────────────
let currentSSE = null;
let defaultPrompt = '';

// ─── API ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (res.status === 401) {
    renderLogin();
    throw new Error('Unauthorized');
  }
  return res;
}

async function apiJSON(path, opts) {
  const res = await api(path, opts);
  return res.json();
}

// ─── Router ───────────────────────────────────────────────────────
function navigate(hash) {
  window.location.hash = hash;
}

function getRoute() {
  const hash = window.location.hash.slice(1) || 'dashboard';
  const parts = hash.split('/');
  return { page: parts[0], id: parts[1] };
}

window.addEventListener('hashchange', route);

async function route() {
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  const { page, id } = getRoute();

  switch (page) {
    case 'login': renderLogin(); break;
    case 'dashboard': await renderDashboard(); break;
    case 'new': await renderNewAnalysis(); break;
    case 'results': await renderResults(id); break;
    case 'transcript': await renderTranscript(id); break;
    default: await renderDashboard();
  }

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('href') === '#' + page);
  });
}

// ─── Check auth & boot ───────────────────────────────────────────
async function boot() {
  try {
    await apiJSON('/jobs');
    // Load default prompt
    const data = await apiJSON('/jobs/default-prompt');
    defaultPrompt = data.prompt;
    route();
  } catch (e) {
    renderLogin();
  }
}

// ─── Shell ────────────────────────────────────────────────────────
function renderShell(content) {
  document.getElementById('app').innerHTML = `
    <nav>
      <div class="logo"><span>Call</span> Analyser</div>
      <a href="#dashboard" class="nav-link">Dashboard</a>
      <a href="#new" class="nav-link">New Analysis</a>
      <div class="spacer"></div>
    </nav>
    <div class="container">${content}</div>
  `;
}

// ─── Login ────────────────────────────────────────────────────────
function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-container">
      <div class="login-box">
        <h1>Call Analyser</h1>
        <p>Enter the team password to continue</p>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="login-pw" placeholder="Enter password" autofocus>
        </div>
        <button class="btn btn-primary" id="login-btn">Sign In</button>
        <div class="login-error" id="login-error"></div>
      </div>
    </div>
  `;

  const pwInput = document.getElementById('login-pw');
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');

  async function doLogin() {
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwInput.value })
      });
      const data = await res.json();
      if (data.ok) {
        const pData = await apiJSON('/jobs/default-prompt');
        defaultPrompt = pData.prompt;
        navigate('dashboard');
      } else {
        err.textContent = data.error || 'Wrong password';
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
    } catch (e) {
      err.textContent = 'Connection error';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  btn.onclick = doLogin;
  pwInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
}

// ─── Dashboard ────────────────────────────────────────────────────
async function renderDashboard() {
  renderShell(`
    <div class="page-header">
      <h1>Overview</h1>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="period-toggle" id="period-toggle">
          <button class="period-btn active" data-days="7">7d</button>
          <button class="period-btn" data-days="30">30d</button>
          <button class="period-btn" data-days="all">All</button>
        </div>
        <button class="btn btn-primary btn-sm" onclick="navigate('new')">+ New Analysis</button>
      </div>
    </div>
    <div id="kpi-panel"><div class="spinner"></div></div>
    <div id="flags-section"></div>
    <div class="section-header"><h2>Recent Jobs</h2></div>
    <div id="job-list"><div class="spinner"></div></div>
  `);

  document.getElementById('period-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.period-btn');
    if (!btn) return;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadKpiPanel(btn.dataset.days);
  });

  await Promise.all([loadKpiPanel('7'), loadRedFlags(), loadJobList()]);
}

async function loadKpiPanel(days) {
  const panel = document.getElementById('kpi-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="spinner"></div>';

  try {
    const stats = await apiJSON(`/jobs/stats?days=${days}`);
    const c = stats.current;
    const p = stats.prev;

    const qualRate = c.total_calls > 0 ? c.qualified / c.total_calls * 100 : 0;
    const dncRate  = c.total_calls > 0 ? c.dnc       / c.total_calls * 100 : 0;
    const prevQual = (p && p.total_calls > 0) ? p.qualified / p.total_calls * 100 : null;
    const prevDnc  = (p && p.total_calls > 0) ? p.dnc       / p.total_calls * 100 : null;

    const pctDiff = (cur, prv) => (!prv || prv === 0) ? null : ((cur - prv) / prv * 100).toFixed(1) + '%';
    const ppDiff  = (cur, prv) => prv === null ? null : (cur - prv).toFixed(1) + 'pp';

    panel.innerHTML = `<div class="kpi-grid">
      ${kpiCard('Total Calls',        fmtNum(c.total_calls),     pctDiff(c.total_calls, p && p.total_calls),   'var(--accent)', false)}
      ${kpiCard('Qualification Rate', qualRate.toFixed(1) + '%', ppDiff(qualRate, prevQual),                   'var(--green)',  false)}
      ${kpiCard('Disqualified',       fmtNum(c.disqualified),    pctDiff(c.disqualified, p && p.disqualified), 'var(--text)',   true)}
      ${kpiCard('Callback',           fmtNum(c.callback),        null,                                          'var(--amber)', false)}
      ${kpiCard('DNC Rate',           dncRate.toFixed(1) + '%',  ppDiff(dncRate, prevDnc),                     'var(--purple)', true)}
      ${kpiCard('Errors',             fmtNum(c.errors),          pctDiff(c.errors, p && p.errors),             'var(--red)',    true)}
    </div>`;
  } catch (e) {
    panel.innerHTML = '<p style="color:var(--red)">Failed to load stats</p>';
  }
}

async function loadRedFlags() {
  const section = document.getElementById('flags-section');
  if (!section) return;

  try {
    const flags = await apiJSON('/recordings/flags?limit=10');
    if (flags.length === 0) { section.innerHTML = ''; return; }

    section.innerHTML = `
      <div class="section-header" style="margin-top:8px">
        <h2>Recent Red Flags <span style="font-size:11px;font-weight:400;color:var(--text-dim);margin-left:6px;text-transform:none;letter-spacing:0">DNC &amp; Errors</span></h2>
      </div>
      <div class="table-wrap" style="margin-bottom:24px">
        <div class="table-scroll">
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Reason</th><th>Recording</th><th>Time</th></tr></thead>
            <tbody>
              ${flags.map(f => `
                <tr>
                  <td><a href="#results/${f.job_id}" style="color:var(--text)">${esc(f.job_name)}</a></td>
                  <td>${leadBadge(f.lead_status || 'error')}</td>
                  <td style="max-width:220px" title="${esc(f.status_reason || '')}">${esc(f.status_reason || '-')}</td>
                  <td><a href="${esc(f.url)}" target="_blank" rel="noopener" class="recording-link">Play</a></td>
                  <td style="color:var(--text-dim);white-space:nowrap">${formatDate(f.finished_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (e) {
    section.innerHTML = '';
  }
}

async function loadJobList() {
  const container = document.getElementById('job-list');
  if (!container) return;

  try {
    const jobs = await apiJSON('/jobs');

    if (jobs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📞</div>
          <h2>No analyses yet</h2>
          <p>Paste your recording URLs and let AI do the work</p>
          <button class="btn btn-primary" onclick="navigate('new')">Start First Analysis</button>
        </div>
      `;
      return;
    }

    container.innerHTML = `<div class="job-grid">${jobs.map(j => {
      const pct = j.total_urls > 0 ? Math.round((j.completed / j.total_urls) * 100) : 0;
      const qualRate = j.total_urls > 0 ? ((j.qualified / j.total_urls) * 100).toFixed(1) : '0.0';
      return `
        <div class="job-card" onclick="navigate('results/${j.id}')">
          <div class="job-card-header">
            <h3>${esc(j.name)}</h3>
            <div style="display:flex;align-items:center;gap:8px">
              ${j.status === 'completed' ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();exportExcel('${j.id}')">Export Excel</button>` : ''}
              ${badge(j.status)}
            </div>
          </div>
          ${j.status === 'running' || j.status === 'pending' ? `
            <div class="progress-text">${j.completed} / ${j.total_urls} recordings (${pct}%)</div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          ` : ''}
          <div class="mini-stats">
            <span>Qualified: <strong style="color:var(--green)">${j.qualified}</strong></span>
            <span>Disqualified: <strong style="color:var(--red)">${j.disqualified}</strong></span>
            <span>Callback: <strong style="color:var(--amber)">${j.callback}</strong></span>
            <span>DNC: <strong style="color:var(--purple)">${j.dnc}</strong></span>
            <span>Total: <strong>${j.total_urls}</strong></span>
            ${j.status === 'completed' ? `<span style="margin-left:auto">Qual. Rate: <strong style="color:var(--green)">${qualRate}%</strong></span>` : ''}
          </div>
          <div class="meta">${formatDate(j.created_at)}${j.finished_at ? ' — Completed ' + formatDate(j.finished_at) : ''}</div>
        </div>
      `;
    }).join('')}</div>`;
  } catch (e) {
    container.innerHTML = '<p style="color:var(--red)">Failed to load jobs</p>';
  }
}

// ─── KPI helpers ───────────────────────────────────────────────────
function fmtNum(n) { return (n || 0).toLocaleString(); }

function kpiCard(label, value, changeTxt, color, invertSentiment) {
  let changeHtml = '';
  if (changeTxt !== null && changeTxt !== undefined) {
    const num = parseFloat(changeTxt);
    let cls = 'kpi-change-neutral';
    let arrow = '→';
    if (!isNaN(num) && Math.abs(num) >= 0.05) {
      const positive = num > 0;
      const isGood = invertSentiment ? !positive : positive;
      cls = isGood ? 'kpi-change-good' : 'kpi-change-bad';
      arrow = positive ? '↑' : '↓';
    }
    const sign = (!isNaN(num) && num > 0) ? '+' : '';
    changeHtml = `<div class="kpi-change ${cls}">${arrow} ${sign}${changeTxt} vs prior</div>`;
  }
  return `<div class="kpi-card">
    <div class="kpi-num" style="color:${color}">${esc(String(value))}</div>
    <div class="kpi-label">${esc(label)}</div>
    ${changeHtml}
  </div>`;
}

// ─── New Analysis ─────────────────────────────────────────────────
async function renderNewAnalysis() {
  renderShell(`
    <div class="page-header"><h1>New Analysis</h1></div>

    <div class="form-group">
      <label>Job Name (optional)</label>
      <input type="text" id="job-name" placeholder="e.g. March 12 Batch">
    </div>

    <div class="form-group">
      <label>Recording URLs — paste anything: one per line, space-separated, from Excel, emails, anywhere</label>
      <textarea id="urls" class="urls" placeholder="Paste your recording URLs here in any format — one per line, space-separated, comma-separated, copied from a spreadsheet... we'll extract them all automatically."></textarea>
      <div id="url-preview"></div>
    </div>

    <button class="prompt-toggle" id="prompt-toggle" onclick="togglePrompt()">
      ▶ Customize analysis prompt
    </button>

    <div class="prompt-section" id="prompt-section">
      <div class="prompt-toolbar">
        <div class="prompt-select-wrap">
          <select id="prompt-select" onchange="loadSavedPrompt()">
            <option value="">— Select a saved prompt —</option>
          </select>
          <button class="btn-icon" id="delete-prompt-btn" title="Delete selected prompt" onclick="deleteSavedPrompt()" style="display:none">🗑</button>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="showSavePrompt()">Save current prompt</button>
        <button class="btn btn-secondary btn-sm" id="optimize-btn" onclick="optimizePrompt()">✨ Optimize with AI</button>
      </div>
      <div id="save-prompt-form" style="display:none" class="save-prompt-form">
        <input type="text" id="prompt-name-input" placeholder="Prompt name (e.g. A&G Insurance)">
        <button class="btn btn-primary btn-sm" onclick="confirmSavePrompt()">Save</button>
        <button class="btn btn-secondary btn-sm" onclick="hideSavePrompt()">Cancel</button>
      </div>
      <div id="optimize-panel" style="display:none" class="optimize-panel"></div>
      <div class="form-group">
        <label>System Prompt — controls how AI analyzes each call</label>
        <textarea id="system-prompt" class="mono" style="min-height:300px">${esc(defaultPrompt)}</textarea>
      </div>
    </div>

    <button class="btn btn-primary" id="analyze-btn" disabled>
      Analyze Recordings
    </button>
    <div id="submit-error" style="color:var(--red);font-size:13px;margin-top:8px"></div>
  `);

  const urlsEl = document.getElementById('urls');
  const previewEl = document.getElementById('url-preview');
  const btn = document.getElementById('analyze-btn');

  function smartExtractUrls(text) {
    const raw = text.match(/https?:\/\/[^\s\t\n\r,"'<>()\[\]{}\\]+/gi) || [];
    // Deduplicate + trim trailing punctuation
    return [...new Set(raw.map(u => u.replace(/[.,;:!?)\]]+$/, '')))];
  }

  function updatePreview() {
    const urls = smartExtractUrls(urlsEl.value);
    const count = urls.length;
    btn.disabled = count === 0;

    if (!urlsEl.value.trim()) {
      previewEl.innerHTML = '';
      return;
    }

    const rawCount = (urlsEl.value.match(/https?:\/\//gi) || []).length;
    const dupes = rawCount - count;

    let html = `<div class="url-preview-card ${count > 0 ? 'has-urls' : 'no-urls'}">`;
    if (count === 0) {
      html += `<div class="url-preview-count url-none">⚠ No URLs detected — make sure links start with https://</div>`;
    } else {
      html += `<div class="url-preview-count">✓ <strong>${count}</strong> recording URL${count !== 1 ? 's' : ''} found`;
      if (dupes > 0) html += ` <span class="url-dupe-badge">${dupes} duplicate${dupes !== 1 ? 's' : ''} removed</span>`;
      html += `</div>`;
      // Show first 3 + last 1 as sample
      const preview = count <= 5 ? urls : [...urls.slice(0, 3), null, urls[urls.length - 1]];
      html += `<div class="url-preview-list">`;
      preview.forEach(u => {
        if (u === null) {
          html += `<div class="url-preview-more">... ${count - 4} more URLs ...</div>`;
        } else {
          const short = u.split('/').slice(-1)[0] || u;
          html += `<div class="url-preview-item" title="${esc(u)}">📎 ${esc(short.length > 60 ? short.substring(0, 60) + '…' : short)}</div>`;
        }
      });
      html += `</div>`;
    }
    html += `</div>`;
    previewEl.innerHTML = html;
  }

  urlsEl.addEventListener('input', updatePreview);
  urlsEl.addEventListener('paste', () => setTimeout(updatePreview, 50));

  // Load saved prompts into dropdown
  loadSavedPromptsList();

  btn.onclick = async () => {
    const urls = smartExtractUrls(urlsEl.value);
    if (urls.length === 0) return;

    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Starting analysis of ${urls.length} recordings...`;

    try {
      const body = {
        name: document.getElementById('job-name').value || undefined,
        urls: urls.join('\n'),
        systemPrompt: document.getElementById('system-prompt')?.value || undefined
      };

      const job = await apiJSON('/jobs', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      navigate(`results/${job.id}`);
    } catch (e) {
      document.getElementById('submit-error').textContent = 'Failed to create job';
      btn.disabled = false;
      btn.textContent = 'Analyze Recordings';
    }
  };
}

function togglePrompt() {
  const section = document.getElementById('prompt-section');
  const toggle = document.getElementById('prompt-toggle');
  const isOpen = section.classList.toggle('open');
  toggle.textContent = (isOpen ? '▼' : '▶') + ' Customize analysis prompt';
}

async function loadSavedPromptsList() {
  try {
    const prompts = await apiJSON('/jobs/prompts/list');
    const select = document.getElementById('prompt-select');
    if (!select) return;
    // Keep first placeholder option, replace the rest
    select.innerHTML = '<option value="">— Select a saved prompt —</option>';
    prompts.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.dataset.content = p.content;
      select.appendChild(opt);
    });
  } catch (e) {}
}

function loadSavedPrompt() {
  const select = document.getElementById('prompt-select');
  const deleteBtn = document.getElementById('delete-prompt-btn');
  const selected = select.options[select.selectedIndex];
  if (!selected || !selected.value) {
    deleteBtn.style.display = 'none';
    return;
  }
  document.getElementById('system-prompt').value = selected.dataset.content;
  deleteBtn.style.display = 'inline-flex';
}

function showSavePrompt() {
  document.getElementById('save-prompt-form').style.display = 'flex';
  document.getElementById('prompt-name-input').focus();
}

function hideSavePrompt() {
  document.getElementById('save-prompt-form').style.display = 'none';
  document.getElementById('prompt-name-input').value = '';
}

async function confirmSavePrompt() {
  const name = document.getElementById('prompt-name-input').value.trim();
  const content = document.getElementById('system-prompt').value;
  if (!name) { document.getElementById('prompt-name-input').focus(); return; }
  try {
    await apiJSON('/jobs/prompts', {
      method: 'POST',
      body: JSON.stringify({ name, content })
    });
    hideSavePrompt();
    await loadSavedPromptsList();
    // Auto-select the newly saved prompt
    const select = document.getElementById('prompt-select');
    for (const opt of select.options) {
      if (opt.textContent === name) { select.value = opt.value; break; }
    }
    document.getElementById('delete-prompt-btn').style.display = 'inline-flex';
  } catch (e) {
    alert('Failed to save prompt');
  }
}

async function deleteSavedPrompt() {
  const select = document.getElementById('prompt-select');
  const id = select.value;
  if (!id) return;
  if (!confirm(`Delete prompt "${select.options[select.selectedIndex].textContent}"?`)) return;
  try {
    await api(`/jobs/prompts/${id}`, { method: 'DELETE' });
    select.value = '';
    document.getElementById('delete-prompt-btn').style.display = 'none';
    await loadSavedPromptsList();
  } catch (e) {
    alert('Failed to delete prompt');
  }
}

async function optimizePrompt() {
  const prompt = document.getElementById('system-prompt')?.value || '';
  const panel = document.getElementById('optimize-panel');
  const btn = document.getElementById('optimize-btn');
  if (!panel || !prompt.trim()) return;

  btn.disabled = true;
  btn.textContent = '⏳ Analyzing...';
  panel.style.display = 'block';
  panel.innerHTML = '<div class="optimize-loading"><span class="spinner"></span> AI is analyzing your prompt for issues...</div>';

  try {
    const data = await apiJSON('/jobs/optimize-prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });

    if (!data.suggestions || data.suggestions.length === 0) {
      panel.innerHTML = '<div class="optimize-empty">✓ Your prompt looks good — no major issues found.</div>';
    } else {
      panel.innerHTML = `
        <div class="optimize-header">
          <strong>✨ ${data.suggestions.length} suggestions to improve your prompt</strong>
          <button class="btn-close-optimize" onclick="document.getElementById('optimize-panel').style.display='none'">✕</button>
        </div>
        ${data.suggestions.map((s, i) => `
          <div class="optimize-card" id="opt-card-${i}">
            <div class="optimize-card-title">${esc(s.title)}</div>
            <div class="optimize-card-issue">${esc(s.issue)}</div>
            <div class="optimize-card-fix"><strong>Suggested fix:</strong> ${esc(s.fix)}</div>
            <div class="optimize-card-actions">
              <button class="btn btn-primary btn-sm" onclick="applyOptimization(${i}, ${JSON.stringify(s.fix).replace(/</g,'&lt;')})">Apply</button>
              <button class="btn btn-secondary btn-sm" onclick="document.getElementById('opt-card-${i}').remove()">Dismiss</button>
            </div>
          </div>
        `).join('')}
      `;
    }
  } catch (e) {
    panel.innerHTML = '<div class="optimize-empty" style="color:var(--red)">Failed to get suggestions. Try again.</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Optimize with AI';
  }
}

function applyOptimization(idx, fix) {
  const textarea = document.getElementById('system-prompt');
  if (!textarea) return;
  textarea.value = textarea.value.trimEnd() + '\n\n' + fix;
  document.getElementById(`opt-card-${idx}`)?.remove();
  // Show a quick confirmation
  const panel = document.getElementById('optimize-panel');
  const confirmation = document.createElement('div');
  confirmation.className = 'optimize-applied';
  confirmation.textContent = '✓ Applied';
  panel.insertBefore(confirmation, panel.firstChild);
  setTimeout(() => confirmation.remove(), 2000);
}

// ─── Results ──────────────────────────────────────────────────────
let currentFilter = null;
let currentBreakdown = [];

async function renderResults(jobId) {
  if (!jobId) return navigate('dashboard');

  renderShell(`
    <a href="#dashboard" class="back-link">← Back to Dashboard</a>
    <div id="results-header"><div class="spinner"></div></div>
    <div id="results-stats"></div>
    <div id="results-filters"></div>
    <div id="results-table"></div>
    <div id="results-pagination"></div>
  `);

  currentFilter = null;
  currentBreakdown = [];

  try {
    const job = await apiJSON(`/jobs/${jobId}`);
    currentBreakdown = job.breakdown || [];
    updateResultsHeader(job);
    updateResultsStats(job);
    renderFilters(jobId, currentBreakdown);
    await loadRecordings(jobId, 1);

    // Connect SSE if job is running
    if (job.status === 'running' || job.status === 'pending') {
      connectSSE(jobId);
    }
  } catch (e) {
    document.getElementById('results-header').innerHTML = `<p style="color:var(--red)">Failed to load job</p>`;
  }
}

function updateResultsHeader(job) {
  const pct = job.total_urls > 0 ? Math.round((job.completed / job.total_urls) * 100) : 0;
  document.getElementById('results-header').innerHTML = `
    <div class="page-header">
      <div>
        <h1>${esc(job.name)} ${badge(job.status)}</h1>
        <div style="font-size:13px;color:var(--text-dim);margin-top:4px">${formatDate(job.created_at)} — ${job.total_urls} recordings</div>
      </div>
      <div class="actions">
        <button class="btn btn-secondary btn-sm" onclick="exportExcel('${job.id}')">Export Excel</button>
        ${job.status === 'running' ? `<button class="btn btn-danger btn-sm" onclick="cancelJob('${job.id}')">Cancel</button>` : ''}
        <button class="btn btn-sm" style="background:var(--surface2);color:var(--red)" onclick="deleteJob('${job.id}')">Delete</button>
      </div>
    </div>
    ${(job.status === 'running' || job.status === 'pending') ? `
      <div class="progress-text">${job.completed} / ${job.total_urls} completed (${pct}%)</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    ` : ''}
  `;
}

function updateResultsStats(job) {
  const breakdown = job.breakdown || [];
  const total = breakdown.reduce((s, b) => s + b.count, 0) || job.total_urls || 1;
  const statCards = breakdown.map(({ lead_status, count }) => {
    const c = statusColor(lead_status);
    const pct = (count / total * 100).toFixed(1);
    return `<div class="stat"><div class="num" style="color:${c}">${count}</div><div class="label">${esc(lead_status)}</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">${pct}%</div></div>`;
  }).join('');

  const donut = renderDonut(breakdown);

  document.getElementById('results-stats').innerHTML = `
    <div class="stats-with-donut">
      <div class="stats">
        ${statCards}
        ${job.errors > 0 ? `<div class="stat"><div class="num" style="color:var(--red)">${job.errors}</div><div class="label">Errors</div></div>` : ''}
        <div class="stat"><div class="num">${job.total_urls}</div><div class="label">Total</div></div>
      </div>
      ${donut ? `<div class="donut-wrap">${donut}${renderDonutLegend(breakdown)}</div>` : ''}
    </div>
  `;
}

// ─── Donut chart ───────────────────────────────────────────────────
function renderDonut(breakdown, size = 140) {
  if (!breakdown || breakdown.length === 0) return '';
  const total = breakdown.reduce((s, b) => s + b.count, 0);
  if (total === 0) return '';

  const cx = size / 2, cy = size / 2;
  const R = size * 0.44, r = size * 0.27;

  function polar(radius, angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  }

  function slicePath(startDeg, endDeg) {
    if (endDeg - startDeg >= 360) endDeg = 359.99;
    const p1 = polar(R, startDeg), p2 = polar(R, endDeg);
    const p3 = polar(r, endDeg),   p4 = polar(r, startDeg);
    const lg = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M${p1.x},${p1.y} A${R},${R} 0 ${lg} 1 ${p2.x},${p2.y} L${p3.x},${p3.y} A${r},${r} 0 ${lg} 0 ${p4.x},${p4.y} Z`;
  }

  const gap = breakdown.length > 1 ? 2 : 0;
  let angle = 0, paths = '';

  for (const b of breakdown) {
    const sweep = (b.count / total) * 360;
    const color = statusColor(b.lead_status);
    if (sweep > gap * 2) {
      paths += `<path d="${slicePath(angle + gap / 2, angle + sweep - gap / 2)}" fill="${color}"/>`;
    }
    angle += sweep;
  }

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">${paths}</svg>`;
}

function renderDonutLegend(breakdown) {
  const total = breakdown.reduce((s, b) => s + b.count, 0);
  if (total === 0) return '';
  return `<div class="donut-legend">${breakdown.map(b => {
    const c = statusColor(b.lead_status);
    const pct = (b.count / total * 100).toFixed(1);
    return `<div class="legend-item">
      <span class="legend-dot" style="background:${c}"></span>
      <span class="legend-label">${esc(b.lead_status)}</span>
      <span class="legend-pct">${pct}%</span>
    </div>`;
  }).join('')}</div>`;
}

function renderFilters(jobId, breakdown) {
  const statusList = (breakdown || []).map(b => b.lead_status);
  document.getElementById('results-filters').innerHTML = `
    <div class="filters">
      <button class="filter-pill${currentFilter === null ? ' active' : ''}"
              onclick="setFilter('${jobId}', null)">All</button>
      ${statusList.map(s => {
        const c = statusColor(s);
        const active = currentFilter === s;
        return `<button class="filter-pill${active ? ' active' : ''}"
                  style="${active ? `background:${c}22;border-color:${c};color:${c}` : ''}"
                  onclick="setFilter('${jobId}', '${s.replace(/'/g,"\\'")}'">${esc(s)}</button>`;
      }).join('')}
    </div>
  `;
}

async function loadRecordings(jobId, page) {
  const params = new URLSearchParams({ jobId, page, limit: 50 });
  if (currentFilter) params.set('status', currentFilter);

  const data = await apiJSON(`/recordings?${params}`);

  if (data.recordings.length === 0) {
    document.getElementById('results-table').innerHTML = `
      <div class="empty-state" style="padding:40px">
        <p>${currentFilter ? 'No recordings with this status' : 'Recordings will appear here as they are processed'}</p>
      </div>
    `;
    document.getElementById('results-pagination').innerHTML = '';
    return;
  }

  document.getElementById('results-table').innerHTML = `
    <div class="table-wrap">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>SID</th>
              <th>Recording</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Name</th>
              <th>Transcript</th>
            </tr>
          </thead>
          <tbody>
            ${data.recordings.map((r, i) => {
              const idx = (data.page - 1) * 50 + i + 1;
              const sid = extractSid(r.url);
              return `
                <tr>
                  <td>${idx}</td>
                  <td class="sid-cell" title="${esc(r.url)}">${esc(sid)}</td>
                  <td><a href="${esc(r.url)}" target="_blank" rel="noopener" class="recording-link" title="${esc(r.url)}">Play</a></td>
                  <td>${leadBadge(r.lead_status || r.status)}</td>
                  <td title="${esc(r.status_reason || '')}">${esc(r.status_reason || '-')}</td>
                  <td>${esc(r.prospect_name || '-')}</td>
                  <td><a href="#transcript/${r.id}" class="transcript-link">View</a></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Pagination
  if (data.pages > 1) {
    let pages = '';
    for (let p = 1; p <= data.pages; p++) {
      pages += `<button class="filter-pill${p === data.page ? ' active' : ''}" onclick="loadRecordings('${jobId}', ${p})">${p}</button>`;
    }
    document.getElementById('results-pagination').innerHTML = `<div class="filters" style="margin-top:16px;justify-content:center">${pages}</div>`;
  } else {
    document.getElementById('results-pagination').innerHTML = '';
  }
}

// Make loadRecordings available globally
window.loadRecordings = loadRecordings;

function setFilter(jobId, value) {
  currentFilter = value;
  renderFilters(jobId, currentBreakdown);
  loadRecordings(jobId, 1);
}

function connectSSE(jobId) {
  if (currentSSE) currentSSE.close();

  currentSSE = new EventSource(`/api/jobs/${jobId}/events`);

  currentSSE.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.type === 'progress') {
        const job = await apiJSON(`/jobs/${jobId}`);
        currentBreakdown = job.breakdown || [];
        updateResultsHeader(job);
        updateResultsStats(job);
        renderFilters(jobId, currentBreakdown);
        loadRecordings(jobId, 1);
      }

      if (data.type === 'complete') {
        const job = await apiJSON(`/jobs/${jobId}`);
        currentBreakdown = job.breakdown || [];
        updateResultsHeader(job);
        updateResultsStats(job);
        renderFilters(jobId, currentBreakdown);
        loadRecordings(jobId, 1);
        if (currentSSE) { currentSSE.close(); currentSSE = null; }
      }
    } catch (err) { /* ignore parse errors from keepalive */ }
  };

  currentSSE.onerror = () => {
    // Auto-reconnect is built into EventSource
  };
}

// ─── Transcript Viewer ────────────────────────────────────────────
async function renderTranscript(recId) {
  if (!recId) return navigate('dashboard');

  renderShell('<div id="transcript-content"><div class="spinner"></div></div>');

  try {
    const rec = await apiJSON(`/recordings/${recId}`);
    const a = rec.analysis || {};

    const boolStr = (v) => v === true ? 'Yes' : v === false ? 'No' : '-';

    document.getElementById('transcript-content').innerHTML = `
      <a href="#results/${rec.job_id}" class="back-link">← Back to Results</a>

      <div class="transcript-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          <h2>Call Analysis ${leadBadge(rec.lead_status || rec.status)}</h2>
          <a href="${esc(rec.url)}" target="_blank" class="btn btn-secondary btn-sm">Listen to Recording</a>
        </div>

        ${a.audit_reasoning ? `<div class="reasoning-box">${esc(a.audit_reasoning)}</div>` : ''}

        <div class="analysis-grid">
          ${field('Status', a.lead_status || '-')}
          ${rec.model_used ? field('Model Used', rec.model_used) : ''}
          ${rec.processing_ms ? field('Processing Time', (rec.processing_ms / 1000).toFixed(1) + 's') : ''}
          ${field('Reason', a.status_reason || '-')}
          ${field('Prospect', a.prospect_name || '-')}
          ${field('Vehicle', a.vehicle_make || '-')}
          ${field('Vehicle Use', a.vehicle_use || '-')}
          ${field('Insurer', a.current_insurer || '-')}
          ${field('Valid License', boolStr(a.has_valid_license))}
          ${field('Income 15k+', boolStr(a.meets_minimum_income))}
          ${field('Consent', boolStr(a.marketing_consent_generate))}
          ${field('Callback Time', a.callback_time || '-')}
          ${field('DNC Flag', a.dnc_flag ? 'YES' : 'No')}
          ${field('Callback Open', boolStr(a.callback_openness))}
        </div>
      </div>

      <div class="transcript-panel">
        <h2>Transcript</h2>
        <div class="transcript-text">${rec.transcript ? esc(rec.transcript) : '<em style="color:var(--text-dim)">No transcript available</em>'}</div>
      </div>

      ${rec.error ? `
        <div class="transcript-panel" style="border-left:3px solid var(--red)">
          <h2 style="color:var(--red)">Error</h2>
          <p style="color:var(--text-dim)">${esc(rec.error)}</p>
        </div>
      ` : ''}
    `;
  } catch (e) {
    document.getElementById('transcript-content').innerHTML = `<p style="color:var(--red)">Failed to load recording</p>`;
  }
}

function field(label, value) {
  return `<div class="analysis-field"><div class="field-label">${label}</div><div class="field-value">${esc(String(value))}</div></div>`;
}

// ─── Actions ──────────────────────────────────────────────────────
async function exportExcel(jobId) {
  window.open(`/api/export/${jobId}`, '_blank');
}

async function cancelJob(jobId) {
  if (!confirm('Cancel this analysis job?')) return;
  await api(`/jobs/${jobId}/cancel`, { method: 'POST' });
  const job = await apiJSON(`/jobs/${jobId}`);
  updateResultsHeader(job);
}

async function deleteJob(jobId) {
  if (!confirm('Delete this job and all its results? This cannot be undone.')) return;
  await api(`/jobs/${jobId}`, { method: 'DELETE' });
  navigate('dashboard');
}

// ─── Helpers ──────────────────────────────────────────────────────
function extractSid(url) {
  if (!url) return '-';
  try {
    // Extract path after last '/' and before '?' or end
    const path = url.split('?')[0];
    const segments = path.split('/').filter(Boolean);
    const filename = segments[segments.length - 1] || '';
    // Remove extension
    const base = filename.replace(/\.[^.]+$/, '');
    // Try to find a UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)
    const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return uuid[0];
    // Try Twilio-style SID (2 uppercase letters + 32 hex chars, e.g. CA3499...)
    const sid = base.match(/[A-Z]{2}[0-9a-f]{32}/i);
    if (sid) return sid[0];
    // Take the first underscore-separated segment if it looks like an ID
    const firstPart = base.split('_')[0];
    if (firstPart && firstPart.length >= 8) return firstPart;
    return base || '-';
  } catch (e) {
    return '-';
  }
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function badge(status) {
  const cls = {
    'pending': 'badge-pending',
    'running': 'badge-running',
    'completed': 'badge-completed',
    'failed': 'badge-failed'
  }[status] || 'badge-pending';
  return `<span class="badge ${cls}">${status}</span>`;
}

// ─── Dynamic status colours ────────────────────────────────────────
const FIXED_STATUS_COLORS = {
  'Qualified':       '#22c55e',
  'Disqualified':    '#ef4444',
  'Call Back Later': '#f59e0b',
  'DNC':             '#8b5cf6',
};
const DYN_PALETTE = ['#06b6d4','#10b981','#f97316','#ec4899','#3b82f6','#14b8a6','#a855f7','#84cc16','#64748b'];

function statusColor(status) {
  if (FIXED_STATUS_COLORS[status]) return FIXED_STATUS_COLORS[status];
  let h = 0;
  for (const c of (status || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return DYN_PALETTE[Math.abs(h) % DYN_PALETTE.length];
}

function leadBadge(status) {
  const processing = ['pending','downloading','transcribing','analyzing'];
  if (!status || processing.includes(status)) return `<span class="badge badge-running">${status || 'pending'}</span>`;
  if (status === 'error') return `<span class="badge badge-error">error</span>`;
  const c = statusColor(status);
  return `<span class="badge" style="background:${c}22;color:${c};border:1px solid ${c}44">${esc(status)}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Global function exports ──────────────────────────────────────
window.navigate = navigate;
window.togglePrompt = togglePrompt;
window.setFilter = setFilter;
window.exportExcel = exportExcel;
window.cancelJob = cancelJob;
window.deleteJob = deleteJob;

// ─── Boot ─────────────────────────────────────────────────────────
boot();
