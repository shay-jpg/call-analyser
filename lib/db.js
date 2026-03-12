const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'call-analyser.db');

let db = null;
let dbReady = null;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Initialize the database (call once at startup, await the result)
async function initDb() {
  if (db) return db;
  if (dbReady) return dbReady;

  dbReady = (async () => {
    ensureDir();
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
    } else {
      db = new SQL.Database();
    }

    return db;
  })();

  db = await dbReady;
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call await initDb() first.');
  return db;
}

function save() {
  if (!db) return;
  ensureDir();
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 5 seconds if there are changes
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    save();
    saveTimer = null;
  }, 5000);
}

function run(sql, params = []) {
  getDb().run(sql, params);
  scheduleSave();
}

function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const row = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const cols = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) {
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function migrate() {
  const d = getDb();
  d.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      total_urls    INTEGER NOT NULL DEFAULT 0,
      completed     INTEGER NOT NULL DEFAULT 0,
      qualified     INTEGER NOT NULL DEFAULT 0,
      disqualified  INTEGER NOT NULL DEFAULT 0,
      callback      INTEGER NOT NULL DEFAULT 0,
      dnc           INTEGER NOT NULL DEFAULT 0,
      errors        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT
    )
  `);

  d.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL,
      url           TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      transcript    TEXT,
      analysis      TEXT,
      lead_status   TEXT,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT,
      UNIQUE(job_id, url)
    )
  `);

  // Create indexes (IF NOT EXISTS not supported for indexes in all sqlite versions, so try/catch)
  try { d.run('CREATE INDEX idx_recordings_job_id ON recordings(job_id)'); } catch (e) {}
  try { d.run('CREATE INDEX idx_recordings_lead_status ON recordings(lead_status)'); } catch (e) {}
  try { d.run('CREATE INDEX idx_recordings_job_status ON recordings(job_id, status)'); } catch (e) {}

  save();
}

// ─── Job functions ───────────────────────────────────────────────

function createJob({ id, name, systemPrompt, urls }) {
  const { v4: uuid } = require('uuid');

  run('INSERT INTO jobs (id, name, system_prompt, total_urls) VALUES (?, ?, ?, ?)',
    [id, name, systemPrompt, urls.length]);

  for (const url of urls) {
    run('INSERT INTO recordings (id, job_id, url) VALUES (?, ?, ?)',
      [uuid(), id, url]);
  }

  save(); // Force immediate save after bulk insert
  return getJob(id);
}

function getJob(id) {
  return get('SELECT * FROM jobs WHERE id = ?', [id]);
}

function listJobs() {
  return all('SELECT * FROM jobs ORDER BY created_at DESC');
}

function updateJobCounters(jobId) {
  const done = get("SELECT COUNT(*) as cnt FROM recordings WHERE job_id = ? AND (status = 'done' OR status = 'error')", [jobId]);
  const qual = get("SELECT COUNT(*) as cnt FROM recordings WHERE job_id = ? AND lead_status = 'Qualified'", [jobId]);
  const disq = get("SELECT COUNT(*) as cnt FROM recordings WHERE job_id = ? AND lead_status = 'Disqualified'", [jobId]);
  const cb = get("SELECT COUNT(*) as cnt FROM recordings WHERE job_id = ? AND lead_status = 'Call Back Later'", [jobId]);
  const dncCount = get("SELECT COUNT(*) as cnt FROM recordings WHERE job_id = ? AND lead_status = 'DNC'", [jobId]);
  const errs = get("SELECT COUNT(*) as cnt FROM recordings WHERE job_id = ? AND status = 'error'", [jobId]);

  run('UPDATE jobs SET completed=?, qualified=?, disqualified=?, callback=?, dnc=?, errors=? WHERE id=?',
    [done.cnt, qual.cnt, disq.cnt, cb.cnt, dncCount.cnt, errs.cnt, jobId]);
}

function setJobStatus(id, status) {
  if (status === 'completed' || status === 'failed') {
    run("UPDATE jobs SET status=?, finished_at=datetime('now') WHERE id=?", [status, id]);
  } else {
    run('UPDATE jobs SET status=? WHERE id=?', [status, id]);
  }
  save();
}

// ─── Recording functions ─────────────────────────────────────────

function getRecording(id) {
  return get('SELECT * FROM recordings WHERE id = ?', [id]);
}

function listRecordingsByJob(jobId, { status, page = 1, limit = 50 } = {}) {
  let where = 'WHERE job_id = ?';
  const params = [jobId];

  if (status) {
    where += ' AND lead_status = ?';
    params.push(status);
  }

  const totalRow = get(`SELECT COUNT(*) as cnt FROM recordings ${where}`, params);
  const total = totalRow ? totalRow.cnt : 0;
  const offset = (page - 1) * limit;

  const recordings = all(
    `SELECT id, url, status, lead_status, analysis, error, finished_at FROM recordings ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const mapped = recordings.map(r => {
    let parsed = {};
    if (r.analysis) {
      try { parsed = JSON.parse(r.analysis); } catch (e) {}
    }
    return {
      id: r.id,
      url: r.url,
      status: r.status,
      lead_status: r.lead_status,
      prospect_name: parsed.prospect_name || null,
      status_reason: parsed.status_reason || r.error || null,
      finished_at: r.finished_at
    };
  });

  return { recordings: mapped, total, page, pages: Math.ceil(total / limit) || 1 };
}

function updateRecording(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  run(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function getPendingRecordings(jobId, limit = 3) {
  return all("SELECT * FROM recordings WHERE job_id = ? AND status = 'pending' LIMIT ?", [jobId, limit]);
}

function getAllRecordingsForExport(jobId) {
  return all('SELECT url, lead_status, analysis, id FROM recordings WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
}

function deleteJob(jobId) {
  run('DELETE FROM recordings WHERE job_id = ?', [jobId]);
  run('DELETE FROM jobs WHERE id = ?', [jobId]);
  save();
}

module.exports = {
  initDb, getDb, migrate, save,
  createJob, getJob, listJobs, updateJobCounters, setJobStatus,
  getRecording, listRecordingsByJob, updateRecording, getPendingRecordings, getAllRecordingsForExport,
  deleteJob
};
