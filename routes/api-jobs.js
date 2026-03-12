const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../lib/db');
const { DEFAULT_SYSTEM_PROMPT, processJob, cancelJob, addSSEClient, removeSSEClient } = require('../lib/processor');
const Anthropic = require('@anthropic-ai/sdk').default;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// Aggregate stats with optional date range
router.get('/stats', (req, res) => {
  const { days } = req.query;
  const d = (days && days !== 'all') ? parseInt(days) : null;
  if (d !== null && (isNaN(d) || d <= 0)) return res.status(400).json({ error: 'Invalid days parameter' });
  res.json(db.getAggregateStats(d));
});

// Create new job
router.post('/', (req, res) => {
  const { name, urls, systemPrompt } = req.body;

  if (!urls || typeof urls !== 'string') {
    return res.status(400).json({ error: 'urls is required (one URL per line)' });
  }

  // Smart extraction: find all http/https URLs regardless of separator (spaces, newlines, tabs, commas, etc.)
  const rawMatches = urls.match(/https?:\/\/[^\s\t\n\r,"'<>()\[\]{}\\]+/gi) || [];
  const urlList = [...new Set(rawMatches.map(u => u.replace(/[.,;:!?)]+$/, '')))]; // dedupe + trim trailing punctuation

  if (urlList.length === 0) {
    return res.status(400).json({ error: 'No valid URLs found. Make sure URLs start with http:// or https://' });
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

// Get single job (includes dynamic status breakdown)
router.get('/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const breakdown = db.getJobStatusBreakdown(req.params.id);
  res.json({ ...job, breakdown });
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

// Optimize a prompt using AI
router.post('/optimize-prompt', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || prompt.trim().length < 20) {
    return res.status(400).json({ error: 'Prompt too short to optimize' });
  }

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `You are an expert at writing system prompts for AI-powered call analysis systems.
Your job is to analyze a system prompt and give 3-5 specific, actionable improvement suggestions.

Key things to check:
1. Are qualification criteria UNAMBIGUOUS? Vague criteria cause inconsistent results.
2. Does it guard against over-analysis? Advanced AI models can be overly strict — the prompt should be explicit about borderline cases.
3. Are all edge cases covered? (short calls, language barriers, partial info)
4. Is the OUTPUT FORMAT crystal clear with no room for interpretation?
5. Are there contradictions or conflicting rules?

Return ONLY a JSON array, no markdown, no extra text:
[
  {
    "title": "5-8 word title of the issue",
    "issue": "1-2 sentences: what's the problem and why it causes inconsistency",
    "fix": "The exact text or instruction to add/change in the prompt"
  }
]`,
      messages: [{
        role: 'user',
        content: `Analyze this call analysis system prompt and suggest improvements:\n\n---\n${prompt.substring(0, 4000)}\n---`
      }]
    });

    const text = msg.content[0].text.trim();
    const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const suggestions = JSON.parse(cleaned);
    res.json({ suggestions });
  } catch (err) {
    console.error('[OPTIMIZE] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

module.exports = router;
