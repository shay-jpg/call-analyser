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
  renderShell('<div class="page-header"><h1>Dashboard</h1><button class="btn btn-primary" onclick="navigate(\'new\')">+ New Analysis</button></div><div id="job-list"><div class="spinner"></div></div>');

  try {
    const jobs = await apiJSON('/jobs');
    const container = document.getElementById('job-list');

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
    document.getElementById('job-list').innerHTML = `<p style="color:var(--red)">Failed to load jobs</p>`;
  }
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
      <label>Recording URLs — paste all at once, one per line</label>
      <textarea id="urls" class="urls" placeholder="https://example.com/recording1.wav&#10;https://example.com/recording2.wav&#10;https://example.com/recording3.wav&#10;..."></textarea>
      <div class="url-count" id="url-count">0 URLs detected</div>
    </div>

    <button class="prompt-toggle" id="prompt-toggle" onclick="togglePrompt()">
      ▶ Customize analysis prompt
    </button>

    <div class="prompt-section" id="prompt-section">
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
  const countEl = document.getElementById('url-count');
  const btn = document.getElementById('analyze-btn');

  function updateCount() {
    const count = urlsEl.value.split('\n').filter(u => u.trim().startsWith('http')).length;
    countEl.textContent = `${count} URL${count !== 1 ? 's' : ''} detected`;
    btn.disabled = count === 0;
  }

  urlsEl.addEventListener('input', updateCount);

  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating job...';

    try {
      const body = {
        name: document.getElementById('job-name').value || undefined,
        urls: urlsEl.value,
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

// ─── Results ──────────────────────────────────────────────────────
let currentFilter = null;

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

  try {
    const job = await apiJSON(`/jobs/${jobId}`);
    updateResultsHeader(job);
    updateResultsStats(job);
    renderFilters(jobId);
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
  document.getElementById('results-stats').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="num" style="color:var(--green)">${job.qualified}</div><div class="label">Qualified</div></div>
      <div class="stat"><div class="num" style="color:var(--red)">${job.disqualified}</div><div class="label">Disqualified</div></div>
      <div class="stat"><div class="num" style="color:var(--amber)">${job.callback}</div><div class="label">Callback</div></div>
      <div class="stat"><div class="num" style="color:var(--purple)">${job.dnc}</div><div class="label">DNC</div></div>
      ${job.errors > 0 ? `<div class="stat"><div class="num" style="color:var(--red)">${job.errors}</div><div class="label">Errors</div></div>` : ''}
      <div class="stat"><div class="num">${job.total_urls}</div><div class="label">Total</div></div>
    </div>
  `;
}

function renderFilters(jobId) {
  const filters = [
    { label: 'All', value: null },
    { label: 'Qualified', value: 'Qualified' },
    { label: 'Disqualified', value: 'Disqualified' },
    { label: 'Call Back Later', value: 'Call Back Later' },
    { label: 'DNC', value: 'DNC' }
  ];

  document.getElementById('results-filters').innerHTML = `
    <div class="filters">
      ${filters.map(f => `
        <button class="filter-pill${currentFilter === f.value ? ' active' : ''}"
                onclick="setFilter('${jobId}', ${f.value ? "'" + f.value + "'" : 'null'})">${f.label}</button>
      `).join('')}
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
              <th>Recording</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            ${data.recordings.map((r, i) => {
              const shortUrl = r.url.split('/').filter(Boolean).slice(-2, -1)[0] || '...';
              const idx = (data.page - 1) * 50 + i + 1;
              return `
                <tr onclick="navigate('transcript/${r.id}')">
                  <td>${idx}</td>
                  <td title="${esc(r.url)}">${shortUrl.substring(0, 12)}...</td>
                  <td>${leadBadge(r.lead_status || r.status)}</td>
                  <td title="${esc(r.status_reason || '')}">${esc(r.status_reason || '-')}</td>
                  <td>${esc(r.prospect_name || '-')}</td>
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
  renderFilters(jobId);
  loadRecordings(jobId, 1);
}

function connectSSE(jobId) {
  if (currentSSE) currentSSE.close();

  currentSSE = new EventSource(`/api/jobs/${jobId}/events`);

  currentSSE.onmessage = async (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.type === 'progress') {
        // Refresh job data
        const job = await apiJSON(`/jobs/${jobId}`);
        updateResultsHeader(job);
        updateResultsStats(job);
        loadRecordings(jobId, 1);
      }

      if (data.type === 'complete') {
        const job = await apiJSON(`/jobs/${jobId}`);
        updateResultsHeader(job);
        updateResultsStats(job);
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

function leadBadge(status) {
  const cls = {
    'Qualified': 'badge-qualified',
    'Disqualified': 'badge-disqualified',
    'Call Back Later': 'badge-callback',
    'DNC': 'badge-dnc',
    'error': 'badge-error',
    'pending': 'badge-pending',
    'downloading': 'badge-running',
    'transcribing': 'badge-running',
    'analyzing': 'badge-running'
  }[status] || 'badge-pending';
  return `<span class="badge ${cls}">${status || 'pending'}</span>`;
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
