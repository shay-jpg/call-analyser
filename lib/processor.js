require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk').default;
const db = require('./db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const CONCURRENCY = 3;

// Active jobs map for cancellation
const activeJobs = new Map();
// SSE clients per job
const sseClients = new Map();

const DEFAULT_SYSTEM_PROMPT = `You are an IRON-CLAD QA AUDITOR for the Auto & General insurance campaign.

CAMPAIGN CONTEXT:
- Outbound sales calls for Auto & General car insurance (South Africa)
- Agents qualify leads based on strict criteria
- You audit the transcript for compliance and lead qualification

KILL SWITCHES (immediate disqualification from "Qualified"):
1. DROPPED CALL: If the call is under 30 seconds of actual conversation or clearly dropped/disconnected → status: "Disqualified", reason: "Dropped call / no conversation"
2. VOICEMAIL: If the agent reaches voicemail/answering machine → status: "Disqualified", reason: "Voicemail"
3. HOSTILE / DNC: If prospect is hostile, abusive, or explicitly says "don't call me again" / "remove my number" → status: "DNC", dnc_flag: true

DATA EXTRACTION RULES (STRICT - no assumptions):
- Extract ONLY what is explicitly stated in the transcript
- If a field is not mentioned, use null (never guess)
- Vehicle use must be explicitly stated as "personal", "business", or "both"
- Income must be explicitly stated or confirmed (not inferred)
- License validity must be explicitly confirmed
- Marketing consent must be explicitly given (yes/no)
- Current insurer must be explicitly named

LEAD STATUS LOGIC:
- "Qualified" requires ALL of:
  1. Vehicle use is "personal" or "both" (not purely business)
  2. Has valid driver's license (explicitly confirmed)
  3. Monthly income >= R15,000 (explicitly stated/confirmed)
  4. Current insurer is NOT a partner (partners: Auto & General, Budget Insurance, Dial Direct, First for Women, 1st for Women)
  5. Marketing consent given

- "Call Back Later" if:
  - Prospect is busy/unavailable but willing to be called back
  - Prospect asks to be called at specific time
  - Conversation started but prospect couldn't continue

- "DNC" (Do Not Call) if:
  - Prospect explicitly requests removal from call list
  - Prospect is hostile/abusive
  - dnc_flag must be true

- "Disqualified" for all other cases:
  - Fails any qualification criteria
  - Dropped call / no conversation
  - Voicemail
  - Missing critical information that can't be obtained

OUTPUT FORMAT: Return ONLY valid JSON (no markdown, no backticks, no extra text):
{
  "audit_reasoning": "Brief explanation of your assessment",
  "lead_status": "Qualified|Disqualified|Call Back Later|DNC",
  "status_reason": "Short reason for the status",
  "prospect_name": "Name or null",
  "vehicle_make": "Make/model or null",
  "vehicle_use": "personal|business|both|null",
  "current_insurer": "Insurer name or null",
  "has_valid_license": true|false|null,
  "meets_minimum_income": true|false|null,
  "callback_openness": true|false|null,
  "callback_time": "Requested time or null",
  "marketing_consent_generate": true|false|null,
  "dnc_flag": false
}`;

// ─── SSE helpers ──────────────────────────────────────────────────

function addSSEClient(jobId, res) {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);
}

function removeSSEClient(jobId, res) {
  const clients = sseClients.get(jobId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(jobId);
  }
}

function emitProgress(jobId, data) {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (e) { /* client disconnected */ }
  }
}

// ─── Core processing functions ───────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function transcribeAudio(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const response = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: fileStream,
    response_format: 'text',
  });
  return response;
}

async function analyzeTranscript(transcript, recordingUrl, systemPrompt) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Analyze this call recording transcript and provide your QA audit assessment.\n\nRecording URL: ${recordingUrl}\n\nTRANSCRIPT:\n${transcript}`
      }
    ],
    system: systemPrompt,
  });

  const text = msg.content[0].text.trim();
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`  [WARN] Failed to parse JSON response:\n${text.substring(0, 200)}`);
    return {
      audit_reasoning: text.substring(0, 500),
      lead_status: 'Disqualified',
      status_reason: 'Failed to parse AI response',
      prospect_name: null, vehicle_make: null, vehicle_use: null,
      current_insurer: null, has_valid_license: null,
      meets_minimum_income: null, callback_openness: null,
      callback_time: null, marketing_consent_generate: null, dnc_flag: false
    };
  }
}

// ─── Process a single recording ──────────────────────────────────

async function processOneRecording(rec, systemPrompt) {
  const wavPath = path.join(TEMP_DIR, `${rec.id}.wav`);

  // Download
  try {
    db.updateRecording(rec.id, { status: 'downloading' });
    emitProgress(rec.job_id, { type: 'status', recordingId: rec.id, status: 'downloading' });
    await downloadFile(rec.url, wavPath);
  } catch (err) {
    db.updateRecording(rec.id, {
      status: 'error',
      error: `Download failed: ${err.message}`,
      finished_at: new Date().toISOString()
    });
    return;
  }

  // Transcribe
  try {
    db.updateRecording(rec.id, { status: 'transcribing' });
    emitProgress(rec.job_id, { type: 'status', recordingId: rec.id, status: 'transcribing' });
    const transcript = await transcribeAudio(wavPath);
    db.updateRecording(rec.id, { status: 'analyzing', transcript });
  } catch (err) {
    db.updateRecording(rec.id, {
      status: 'error',
      error: `Transcription failed: ${err.message}`,
      finished_at: new Date().toISOString()
    });
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
    return;
  }

  // Clean up WAV
  if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

  // Analyze
  try {
    emitProgress(rec.job_id, { type: 'status', recordingId: rec.id, status: 'analyzing' });
    const updated = db.getRecording(rec.id);
    const analysis = await analyzeTranscript(updated.transcript, rec.url, systemPrompt);
    db.updateRecording(rec.id, {
      status: 'done',
      analysis: JSON.stringify(analysis),
      lead_status: analysis.lead_status || 'Disqualified',
      finished_at: new Date().toISOString()
    });
  } catch (err) {
    db.updateRecording(rec.id, {
      status: 'error',
      error: `Analysis failed: ${err.message}`,
      finished_at: new Date().toISOString()
    });
  }
}

// ─── Process entire job ──────────────────────────────────────────

async function processJob(jobId) {
  const job = db.getJob(jobId);
  if (!job) return;

  activeJobs.set(jobId, { cancel: false });
  db.setJobStatus(jobId, 'running');

  console.log(`[JOB ${jobId}] Starting — ${job.total_urls} recordings`);

  while (true) {
    // Check for cancellation
    if (activeJobs.get(jobId)?.cancel) {
      console.log(`[JOB ${jobId}] Cancelled`);
      db.setJobStatus(jobId, 'failed');
      break;
    }

    const batch = db.getPendingRecordings(jobId, CONCURRENCY);
    if (batch.length === 0) break;

    await Promise.all(
      batch.map(rec => processOneRecording(rec, job.system_prompt))
    );

    // Update counters and emit
    db.updateJobCounters(jobId);
    const updated = db.getJob(jobId);
    emitProgress(jobId, {
      type: 'progress',
      completed: updated.completed,
      total: updated.total_urls,
      qualified: updated.qualified,
      disqualified: updated.disqualified,
      callback: updated.callback,
      dnc: updated.dnc,
      errors: updated.errors
    });
  }

  // Finalize
  db.updateJobCounters(jobId);
  const finalJob = db.getJob(jobId);
  if (finalJob.status === 'running') {
    db.setJobStatus(jobId, 'completed');
  }

  emitProgress(jobId, { type: 'complete', jobId });
  activeJobs.delete(jobId);
  console.log(`[JOB ${jobId}] Finished — ${finalJob.completed}/${finalJob.total_urls}`);
}

function cancelJob(jobId) {
  const entry = activeJobs.get(jobId);
  if (entry) entry.cancel = true;
}

function resumeInterruptedJobs() {
  const { all } = require('./db');
  // We can't import all directly at top level since db uses the same pattern
  // But db.js exports it, and by the time this runs, db is initialized
  const running = require('./db');
  const jobs = running.listJobs().filter(j => j.status === 'running');
  for (const job of jobs) {
    console.log(`[RESUME] Resuming job ${job.id}`);
    processJob(job.id).catch(err => console.error(`[RESUME ERR] ${err.message}`));
  }
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  processJob, cancelJob, resumeInterruptedJobs,
  addSSEClient, removeSSEClient, emitProgress
};
