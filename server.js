require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { initDb, migrate, purgeOldRecordings } = require('./lib/db');
const { authMiddleware, loginHandler } = require('./lib/auth');
const { resumeInterruptedJobs, cleanupOrphanedTempFiles } = require('./lib/processor');

const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS) || 30;

function runMaintenance() {
  cleanupOrphanedTempFiles();
  purgeOldRecordings(RETENTION_DAYS);
}

async function start() {
  // Initialize database first
  await initDb();
  migrate();

  const app = express();

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Static frontend
  app.use(express.static(path.join(__dirname, 'public')));

  // Auth
  app.post('/api/login', loginHandler);
  app.use('/api', authMiddleware);

  // API routes
  app.use('/api/jobs', require('./routes/api-jobs'));
  app.use('/api/recordings', require('./routes/api-recordings'));
  app.use('/api/export', require('./routes/api-export'));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(` Call Analyser — Live on http://localhost:${PORT}`);
    console.log(`═══════════════════════════════════════════════════\n`);

    // Resume any interrupted jobs
    resumeInterruptedJobs();

    // Run maintenance immediately, then every 24h
    runMaintenance();
    setInterval(runMaintenance, 24 * 60 * 60 * 1000);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
