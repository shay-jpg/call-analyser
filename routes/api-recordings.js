const express = require('express');
const db = require('../lib/db');

const router = express.Router();

// Recent red flags — DNC + error recordings across all jobs
router.get('/flags', (req, res) => {
  const flags = db.getRecentFlags(req.query.limit);
  const result = flags.map(r => {
    let status_reason = r.error || null;
    if (r.analysis) {
      try { status_reason = JSON.parse(r.analysis).status_reason || status_reason; } catch (e) {}
    }
    return { id: r.id, job_id: r.job_id, job_name: r.job_name, url: r.url, lead_status: r.lead_status, status_reason, finished_at: r.finished_at };
  });
  res.json(result);
});

// List recordings for a job (paginated, filterable)
router.get('/', (req, res) => {
  const { jobId, status, page = 1, limit = 50 } = req.query;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const result = db.listRecordingsByJob(jobId, {
    status: status || null,
    page: parseInt(page),
    limit: parseInt(limit)
  });
  res.json(result);
});

// Get single recording (full detail with transcript + analysis)
router.get('/:id', (req, res) => {
  const rec = db.getRecording(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });

  let analysis = null;
  if (rec.analysis) {
    try { analysis = JSON.parse(rec.analysis); } catch (e) {}
  }

  res.json({
    ...rec,
    analysis
  });
});

module.exports = router;
