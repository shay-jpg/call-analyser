require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk').default;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TEMP_DIR = path.join(__dirname, 'temp');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
const RESULTS_FILE = path.join(__dirname, 'results.json');
const REPORT_FILE = path.join(__dirname, 'report.html');
const RECORDINGS_FILE = path.join(__dirname, 'recordings.txt');

const CONCURRENCY = 3; // parallel downloads/transcriptions

const QA_SYSTEM_PROMPT = `You are an IRON-CLAD QA AUDITOR for the Auto & General insurance campaign.

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

// ─── Helpers ────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
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

async function analyzeTranscript(transcript, recordingUrl) {
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Analyze this call recording transcript and provide your QA audit assessment.\n\nRecording URL: ${recordingUrl}\n\nTRANSCRIPT:\n${transcript}`
      }
    ],
    system: QA_SYSTEM_PROMPT,
  });

  const text = msg.content[0].text.trim();
  // Strip markdown fences if present
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`  [WARN] Failed to parse JSON response, raw text:\n${text.substring(0, 200)}`);
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

function generateHTML(results) {
  const statusColors = {
    'Qualified': '#22c55e',
    'Disqualified': '#ef4444',
    'Call Back Later': '#f59e0b',
    'DNC': '#8b5cf6'
  };

  const rows = results.map((r, i) => {
    const color = statusColors[r.analysis.lead_status] || '#6b7280';
    const shortUrl = r.url.split('/').pop().replace('_mixed.wav', '');
    const transcriptFile = r.transcriptFile ? path.basename(r.transcriptFile) : '';
    return `
      <tr>
        <td>${i + 1}</td>
        <td><a href="${r.url}" target="_blank" title="${r.url}">${shortUrl}</a></td>
        <td style="color:${color};font-weight:bold">${r.analysis.lead_status}</td>
        <td>${r.analysis.status_reason || ''}</td>
        <td>${r.analysis.prospect_name || '-'}</td>
        <td>${r.analysis.vehicle_make || '-'}</td>
        <td>${r.analysis.vehicle_use || '-'}</td>
        <td>${r.analysis.current_insurer || '-'}</td>
        <td>${r.analysis.has_valid_license === null ? '-' : r.analysis.has_valid_license ? 'Yes' : 'No'}</td>
        <td>${r.analysis.meets_minimum_income === null ? '-' : r.analysis.meets_minimum_income ? 'Yes' : 'No'}</td>
        <td>${r.analysis.marketing_consent_generate === null ? '-' : r.analysis.marketing_consent_generate ? 'Yes' : 'No'}</td>
        <td>${r.analysis.callback_time || '-'}</td>
        <td>${transcriptFile ? `<a href="transcripts/${transcriptFile}" target="_blank">View</a>` : '-'}</td>
      </tr>`;
  }).join('\n');

  const qualified = results.filter(r => r.analysis.lead_status === 'Qualified').length;
  const disqualified = results.filter(r => r.analysis.lead_status === 'Disqualified').length;
  const callback = results.filter(r => r.analysis.lead_status === 'Call Back Later').length;
  const dnc = results.filter(r => r.analysis.lead_status === 'DNC').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Call Analyser Report — Auto &amp; General Campaign</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 28px; margin-bottom: 8px; color: #f1f5f9; }
  .subtitle { color: #94a3b8; margin-bottom: 24px; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { padding: 16px 24px; border-radius: 12px; background: #1e293b; min-width: 140px; }
  .stat .num { font-size: 32px; font-weight: bold; }
  .stat .label { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #334155; padding: 12px 10px; text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; position: sticky; top: 0; }
  td { padding: 10px; border-bottom: 1px solid #334155; font-size: 13px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: #1a2744; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .scroll { overflow-x: auto; border-radius: 12px; }
</style>
</head>
<body>
<h1>Call Analyser Report</h1>
<p class="subtitle">Auto &amp; General Insurance Campaign — ${new Date().toLocaleDateString('en-ZA')} — ${results.length} recordings analysed</p>

<div class="stats">
  <div class="stat"><div class="num" style="color:#22c55e">${qualified}</div><div class="label">Qualified</div></div>
  <div class="stat"><div class="num" style="color:#ef4444">${disqualified}</div><div class="label">Disqualified</div></div>
  <div class="stat"><div class="num" style="color:#f59e0b">${callback}</div><div class="label">Call Back Later</div></div>
  <div class="stat"><div class="num" style="color:#8b5cf6">${dnc}</div><div class="label">DNC</div></div>
  <div class="stat"><div class="num" style="color:#f1f5f9">${results.length}</div><div class="label">Total</div></div>
</div>

<div class="scroll">
<table>
<thead>
<tr>
  <th>#</th><th>Recording</th><th>Status</th><th>Reason</th><th>Name</th><th>Vehicle</th><th>Use</th><th>Insurer</th><th>License</th><th>Income 15k+</th><th>Consent</th><th>Callback</th><th>Transcript</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────

async function processRecording(url, index, total) {
  const id = url.split('/').filter(Boolean).slice(-2, -1)[0] || `recording_${index}`;
  const wavPath = path.join(TEMP_DIR, `${id}.wav`);
  const txtPath = path.join(TRANSCRIPTS_DIR, `${id}.txt`);

  console.log(`[${index + 1}/${total}] Processing ${id}...`);

  // Check if we already have a transcript (resume support)
  let transcript;
  if (fs.existsSync(txtPath)) {
    console.log(`  [CACHE] Transcript exists, skipping download + transcription`);
    transcript = fs.readFileSync(txtPath, 'utf-8');
  } else {
    // Download
    try {
      console.log(`  [DL] Downloading...`);
      await downloadFile(url, wavPath);
      const stats = fs.statSync(wavPath);
      console.log(`  [DL] Downloaded ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    } catch (err) {
      console.error(`  [ERR] Download failed: ${err.message}`);
      return { url, transcriptFile: null, analysis: {
        audit_reasoning: `Download failed: ${err.message}`,
        lead_status: 'Disqualified', status_reason: 'Download failed',
        prospect_name: null, vehicle_make: null, vehicle_use: null,
        current_insurer: null, has_valid_license: null,
        meets_minimum_income: null, callback_openness: null,
        callback_time: null, marketing_consent_generate: null, dnc_flag: false
      }};
    }

    // Transcribe
    try {
      console.log(`  [TR] Transcribing via Whisper...`);
      transcript = await transcribeAudio(wavPath);
      fs.writeFileSync(txtPath, transcript, 'utf-8');
      console.log(`  [TR] Transcript: ${transcript.length} chars`);
    } catch (err) {
      console.error(`  [ERR] Transcription failed: ${err.message}`);
      // Clean up wav
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      return { url, transcriptFile: null, analysis: {
        audit_reasoning: `Transcription failed: ${err.message}`,
        lead_status: 'Disqualified', status_reason: 'Transcription failed',
        prospect_name: null, vehicle_make: null, vehicle_use: null,
        current_insurer: null, has_valid_license: null,
        meets_minimum_income: null, callback_openness: null,
        callback_time: null, marketing_consent_generate: null, dnc_flag: false
      }};
    }

    // Clean up wav to save disk space
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
  }

  // Analyze via Claude
  try {
    console.log(`  [AI] Analyzing via Opus 4.6...`);
    const analysis = await analyzeTranscript(transcript, url);
    console.log(`  [AI] → ${analysis.lead_status}: ${analysis.status_reason}`);
    return { url, transcriptFile: txtPath, analysis };
  } catch (err) {
    console.error(`  [ERR] Analysis failed: ${err.message}`);
    return { url, transcriptFile: txtPath, analysis: {
      audit_reasoning: `Analysis failed: ${err.message}`,
      lead_status: 'Disqualified', status_reason: 'Analysis failed',
      prospect_name: null, vehicle_make: null, vehicle_use: null,
      current_insurer: null, has_valid_license: null,
      meets_minimum_income: null, callback_openness: null,
      callback_time: null, marketing_consent_generate: null, dnc_flag: false
    }};
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Call Analyser — Auto & General Campaign');
  console.log(' Whisper Transcription + Claude Opus 4.6 QA Audit');
  console.log('═══════════════════════════════════════════════════\n');

  // Create dirs
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  // Read URLs
  const urls = fs.readFileSync(RECORDINGS_FILE, 'utf-8')
    .split('\n')
    .map(u => u.trim())
    .filter(u => u && u.startsWith('http'));

  console.log(`Found ${urls.length} recordings to process\n`);

  // Load existing results for resume support
  let results = [];
  const processedUrls = new Set();
  if (fs.existsSync(RESULTS_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
      if (Array.isArray(existing)) {
        results = existing;
        existing.forEach(r => processedUrls.add(r.url));
        console.log(`Resuming — ${results.length} already processed\n`);
      }
    } catch (e) { /* start fresh */ }
  }

  const remaining = urls.filter(u => !processedUrls.has(u));
  console.log(`${remaining.length} recordings remaining\n`);

  // Process in batches of CONCURRENCY
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((url, j) => processRecording(url, results.length + j, urls.length))
    );
    results.push(...batchResults);

    // Save intermediate results after each batch
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  }

  // Generate report
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' Generating HTML Report...');
  console.log('═══════════════════════════════════════════════════\n');

  const html = generateHTML(results);
  fs.writeFileSync(REPORT_FILE, html);

  // Summary
  const qualified = results.filter(r => r.analysis.lead_status === 'Qualified').length;
  const disqualified = results.filter(r => r.analysis.lead_status === 'Disqualified').length;
  const callback = results.filter(r => r.analysis.lead_status === 'Call Back Later').length;
  const dnc = results.filter(r => r.analysis.lead_status === 'DNC').length;

  console.log(`RESULTS SUMMARY:`);
  console.log(`  Qualified:       ${qualified}`);
  console.log(`  Disqualified:    ${disqualified}`);
  console.log(`  Call Back Later:  ${callback}`);
  console.log(`  DNC:             ${dnc}`);
  console.log(`  TOTAL:           ${results.length}`);
  console.log(`\n  Report: ${REPORT_FILE}`);
  console.log(`  Results: ${RESULTS_FILE}`);
  console.log(`  Transcripts: ${TRANSCRIPTS_DIR}/`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
