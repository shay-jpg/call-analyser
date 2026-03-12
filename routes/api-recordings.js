const express = require('express');
const db = require('../lib/db');

const router = express.Router();

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
