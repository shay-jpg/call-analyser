const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../lib/db');
const { DEFAULT_SYSTEM_PROMPT, processJob, cancelJob, addSSEClient, removeSSEClient } = require('../lib/processor');

const router = express.Router();

// List all jobs
router.get('/', (req, res) => {
  const jobs = db.listJobs();
  res.json(jobs);
});

// Get default prompt
router.get('/default-prompt', (req, res) => {
  res.json({ prompt: DEFAULT_SYSTEM_PROMPT });
});

// Create new job
router.post('/', (req, res) => {
  const { name, urls, systemPrompt } = req.body;

  if (!urls || typeof urls !== 'string') {
    return res.status(400).json({ error: 'urls is required (one URL per line)' });
  }

  const urlList = urls.split('\n').map(u => u.trim()).filter(u => u && u.startsWith('http'));

  if (urlList.length === 0) {
    return res.status(400).json({ error: 'No valid URLs found' });
  }

  const jobId = uuid();
  const jobName = name || `Analysis ${new Date().toLocaleDateString('en-ZA')}`;
  const prompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const job = db.createJob({ id: jobId, name: jobName, systemPrompt: prompt, urls: urlList });

  // Start processing in background
  setImmediate(() => {
    processJob(jobId).catch(err => {
      console.error(`[JOB ERR] ${jobId}: ${err.message}`);
      db.setJobStatus(jobId, 'failed');
    });
  });

  res.status(201).json(job);
});

// Get single job
router.get('/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// SSE events for a job
router.get('/:id/events', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial state
  res.write(`data: ${JSON.stringify({ type: 'init', job })}\n\n`);

  addSSEClient(job.id, res);

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    try { res.write(':\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepalive);
    removeSSEClient(job.id, res);
  });
});

// Cancel a job
router.post('/:id/cancel', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  cancelJob(job.id);
  res.json({ ok: true });
});

// Delete a job
router.delete('/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  db.deleteJob(job.id);
  res.json({ ok: true });
});

// ─── Saved Prompts ────────────────────────────────────────────────

// List saved prompts
router.get('/prompts/list', (req, res) => {
  res.json(db.listPrompts());
});

// Save a prompt
router.post('/prompts', (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'name and content required' });
  const prompt = db.createPrompt({ id: uuid(), name: name.trim(), content });
  res.status(201).json(prompt);
});

// Delete a prompt
router.delete('/prompts/:id', (req, res) => {
  db.deletePrompt(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
