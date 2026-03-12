const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../lib/db');

const router = express.Router();

const FONT_MAIN = 'Calibri';
const COLOR_HEADER_BG = 'FF1E293B';
const COLOR_HEADER_TEXT = 'FFFFFFFF';
const COLOR_LIGHT_ROW = 'FFF8FAFC';
const COLOR_WHITE = 'FFFFFFFF';
const COLOR_BORDER = 'FFE2E8F0';

const STATUS_COLORS = {
  'Qualified':       { bg: 'FFDCFCE7', text: 'FF166534' },
  'Disqualified':    { bg: 'FFFEE2E2', text: 'FF991B1B' },
  'Call Back Later':  { bg: 'FFFEF3C7', text: 'FF92400E' },
  'DNC':             { bg: 'FFEDE9FE', text: 'FF5B21B6' }
};

function thinBorder() {
  return {
    top:    { style: 'thin', color: { argb: COLOR_BORDER } },
    bottom: { style: 'thin', color: { argb: COLOR_BORDER } },
    left:   { style: 'thin', color: { argb: COLOR_BORDER } },
    right:  { style: 'thin', color: { argb: COLOR_BORDER } }
  };
}

router.get('/:jobId', async (req, res) => {
  const job = db.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const recordings = db.getAllRecordingsForExport(req.params.jobId);
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Call Analyser';
  workbook.created = new Date();

  // ══════════════════════════════════════════════════════════════
  // SHEET 1: Summary
  // ══════════════════════════════════════════════════════════════
  const summary = workbook.addWorksheet('Summary', {
    properties: { tabColor: { argb: 'FF3B82F6' } }
  });

  summary.columns = [
    { width: 28 }, { width: 22 }
  ];

  // Title
  summary.mergeCells('A1:B1');
  const titleCell = summary.getCell('A1');
  titleCell.value = 'Call Analysis Report';
  titleCell.font = { name: FONT_MAIN, size: 18, bold: true, color: { argb: 'FF0F172A' } };
  titleCell.alignment = { vertical: 'middle' };
  summary.getRow(1).height = 36;

  // Subtitle
  summary.mergeCells('A2:B2');
  const subCell = summary.getCell('A2');
  subCell.value = job.name;
  subCell.font = { name: FONT_MAIN, size: 12, color: { argb: 'FF64748B' } };

  // Date
  summary.mergeCells('A3:B3');
  summary.getCell('A3').value = `Generated: ${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  summary.getCell('A3').font = { name: FONT_MAIN, size: 10, color: { argb: 'FF94A3B8' } };

  // Spacer
  summary.getRow(4).height = 8;

  // Stats section
  const statsData = [
    ['Total Recordings', job.total_urls],
    ['Qualified', job.qualified],
    ['Disqualified', job.disqualified],
    ['Call Back Later', job.callback],
    ['DNC (Do Not Call)', job.dnc],
    ['Errors', job.errors],
  ];

  const statsLabels = {
    'Qualified': STATUS_COLORS['Qualified'],
    'Disqualified': STATUS_COLORS['Disqualified'],
    'Call Back Later': STATUS_COLORS['Call Back Later'],
    'DNC (Do Not Call)': STATUS_COLORS['DNC'],
  };

  let row = 5;
  // Stats header
  const statsHeaderRow = summary.getRow(row);
  summary.getCell(`A${row}`).value = 'Metric';
  summary.getCell(`B${row}`).value = 'Count';
  for (const col of ['A', 'B']) {
    const c = summary.getCell(`${col}${row}`);
    c.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: COLOR_HEADER_TEXT } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { vertical: 'middle', horizontal: col === 'B' ? 'center' : 'left' };
    c.border = thinBorder();
  }
  statsHeaderRow.height = 26;
  row++;

  for (const [label, value] of statsData) {
    const r = summary.getRow(row);
    const cellA = summary.getCell(`A${row}`);
    const cellB = summary.getCell(`B${row}`);

    cellA.value = label;
    cellB.value = value;
    cellA.font = { name: FONT_MAIN, size: 11 };
    cellB.font = { name: FONT_MAIN, size: 11, bold: true };
    cellB.alignment = { horizontal: 'center' };

    // Color status rows
    const sc = statsLabels[label];
    if (sc) {
      cellA.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
      cellB.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
      cellA.font = { name: FONT_MAIN, size: 11, color: { argb: sc.text } };
      cellB.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: sc.text } };
    } else if (label === 'Total Recordings') {
      cellB.font = { name: FONT_MAIN, size: 12, bold: true };
    }

    cellA.border = thinBorder();
    cellB.border = thinBorder();
    r.height = 24;
    row++;
  }

  // Qualification rate
  row += 1;
  summary.mergeCells(`A${row}:B${row}`);
  const qualRate = job.total_urls > 0 ? ((job.qualified / job.total_urls) * 100).toFixed(1) : '0.0';
  summary.getCell(`A${row}`).value = `Qualification Rate: ${qualRate}%`;
  summary.getCell(`A${row}`).font = { name: FONT_MAIN, size: 13, bold: true, color: { argb: 'FF0F172A' } };

  // ══════════════════════════════════════════════════════════════
  // SHEET 2: All Results
  // ══════════════════════════════════════════════════════════════
  const sheet = workbook.addWorksheet('Results', {
    properties: { tabColor: { argb: 'FF22C55E' } },
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const columns = [
    { header: '#',               key: 'num',        width: 6  },
    { header: 'Status',          key: 'status',     width: 16 },
    { header: 'Prospect Name',   key: 'name',       width: 22 },
    { header: 'Reason',          key: 'reason',     width: 42 },
    { header: 'Vehicle',         key: 'vehicle',    width: 22 },
    { header: 'Vehicle Use',     key: 'use',        width: 14 },
    { header: 'Current Insurer', key: 'insurer',    width: 20 },
    { header: 'Valid License',   key: 'license',    width: 14 },
    { header: 'Income ≥R15k',   key: 'income',     width: 14 },
    { header: 'Consent',         key: 'consent',    width: 12 },
    { header: 'DNC Flag',        key: 'dnc_flag',   width: 10 },
    { header: 'Callback Time',   key: 'callback',   width: 20 },
    { header: 'Recording URL',   key: 'url',        width: 40 },
    { header: 'Transcript',      key: 'transcript',  width: 32 },
  ];

  sheet.columns = columns;

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.height = 30;
  headerRow.eachCell((cell) => {
    cell.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: COLOR_HEADER_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  });

  // Data rows
  recordings.forEach((rec, i) => {
    let a = {};
    if (rec.analysis) {
      try { a = JSON.parse(rec.analysis); } catch (e) {}
    }

    const boolStr = (v) => v === true ? 'Yes' : v === false ? 'No' : '-';
    const transcriptUrl = `${baseUrl}/#transcript/${rec.id}`;

    const dataRow = sheet.addRow({
      num: i + 1,
      status: rec.lead_status || '-',
      name: a.prospect_name || '-',
      reason: a.status_reason || '-',
      vehicle: a.vehicle_make || '-',
      use: a.vehicle_use || '-',
      insurer: a.current_insurer || '-',
      license: boolStr(a.has_valid_license),
      income: boolStr(a.meets_minimum_income),
      consent: boolStr(a.marketing_consent_generate),
      dnc_flag: a.dnc_flag ? 'YES' : 'No',
      callback: a.callback_time || '-',
      url: rec.url,
      transcript: transcriptUrl
    });

    const rowNum = dataRow.number;
    const isOdd = i % 2 === 0;
    const bgColor = isOdd ? COLOR_WHITE : COLOR_LIGHT_ROW;

    dataRow.height = 22;
    dataRow.eachCell((cell, colNum) => {
      cell.font = { name: FONT_MAIN, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
      cell.border = thinBorder();
      cell.alignment = { vertical: 'middle' };
    });

    // Center alignment for specific columns
    ['num', 'license', 'income', 'consent', 'dnc_flag', 'use'].forEach(key => {
      const col = columns.findIndex(c => c.key === key) + 1;
      if (col > 0) dataRow.getCell(col).alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Status cell — colored badge style
    const statusCell = dataRow.getCell('status');
    const sc = STATUS_COLORS[rec.lead_status];
    if (sc) {
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
      statusCell.font = { name: FONT_MAIN, size: 10, bold: true, color: { argb: sc.text } };
    }
    statusCell.alignment = { vertical: 'middle', horizontal: 'center' };

    // DNC flag — red if YES
    if (a.dnc_flag) {
      dataRow.getCell('dnc_flag').font = { name: FONT_MAIN, size: 10, bold: true, color: { argb: 'FFDC2626' } };
    }

    // Make Recording URL a clickable hyperlink
    const urlCell = dataRow.getCell('url');
    urlCell.value = { text: 'Play Recording', hyperlink: rec.url };
    urlCell.font = { name: FONT_MAIN, size: 10, color: { argb: 'FF2563EB' }, underline: true };

    // Make Transcript a clickable hyperlink
    const transcriptCell = dataRow.getCell('transcript');
    transcriptCell.value = { text: 'View Transcript', hyperlink: transcriptUrl };
    transcriptCell.font = { name: FONT_MAIN, size: 10, color: { argb: 'FF2563EB' }, underline: true };
  });

  // Auto-filter on all columns
  sheet.autoFilter = { from: 'A1', to: `N${recordings.length + 1}` };

  // ══════════════════════════════════════════════════════════════
  // SHEET 3: Qualified Only
  // ══════════════════════════════════════════════════════════════
  const qualified = recordings.filter(r => r.lead_status === 'Qualified');
  if (qualified.length > 0) {
    const qSheet = workbook.addWorksheet('Qualified Leads', {
      properties: { tabColor: { argb: 'FF22C55E' } },
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    const qCols = [
      { header: '#',               key: 'num',      width: 6  },
      { header: 'Prospect Name',   key: 'name',     width: 24 },
      { header: 'Vehicle',         key: 'vehicle',  width: 24 },
      { header: 'Vehicle Use',     key: 'use',      width: 14 },
      { header: 'Current Insurer', key: 'insurer',  width: 22 },
      { header: 'Reason',          key: 'reason',   width: 40 },
      { header: 'Recording',       key: 'url',      width: 36 },
      { header: 'Transcript',      key: 'transcript', width: 30 },
    ];

    qSheet.columns = qCols;

    const qHeaderRow = qSheet.getRow(1);
    qHeaderRow.height = 30;
    qHeaderRow.eachCell((cell) => {
      cell.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: COLOR_HEADER_TEXT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder();
    });

    qualified.forEach((rec, i) => {
      let a = {};
      try { a = JSON.parse(rec.analysis); } catch (e) {}

      const r = qSheet.addRow({
        num: i + 1,
        name: a.prospect_name || '-',
        vehicle: a.vehicle_make || '-',
        use: a.vehicle_use || '-',
        insurer: a.current_insurer || '-',
        reason: a.status_reason || '-',
        url: rec.url,
        transcript: `${baseUrl}/#transcript/${rec.id}`
      });

      r.height = 22;
      const bg = i % 2 === 0 ? 'FFDCFCE7' : 'FFF0FDF4';
      r.eachCell(cell => {
        cell.font = { name: FONT_MAIN, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.border = thinBorder();
        cell.alignment = { vertical: 'middle' };
      });

      // Hyperlinks
      const urlCell = r.getCell('url');
      urlCell.value = { text: 'Play Recording', hyperlink: rec.url };
      urlCell.font = { name: FONT_MAIN, size: 10, color: { argb: 'FF166534' }, underline: true };

      const tCell = r.getCell('transcript');
      tCell.value = { text: 'View Transcript', hyperlink: `${baseUrl}/#transcript/${rec.id}` };
      tCell.font = { name: FONT_MAIN, size: 10, color: { argb: 'FF166534' }, underline: true };
    });
  }

  // ══════════════════════════════════════════════════════════════
  // SHEET 4: Callbacks
  // ══════════════════════════════════════════════════════════════
  const callbacks = recordings.filter(r => r.lead_status === 'Call Back Later');
  if (callbacks.length > 0) {
    const cbSheet = workbook.addWorksheet('Callbacks', {
      properties: { tabColor: { argb: 'FFF59E0B' } },
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    const cbCols = [
      { header: '#',             key: 'num',      width: 6  },
      { header: 'Prospect Name', key: 'name',     width: 24 },
      { header: 'Callback Time', key: 'callback', width: 24 },
      { header: 'Reason',        key: 'reason',   width: 44 },
      { header: 'Recording',     key: 'url',      width: 36 },
      { header: 'Transcript',    key: 'transcript', width: 30 },
    ];

    cbSheet.columns = cbCols;

    const cbHeaderRow = cbSheet.getRow(1);
    cbHeaderRow.height = 30;
    cbHeaderRow.eachCell((cell) => {
      cell.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: COLOR_HEADER_TEXT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92400E' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder();
    });

    callbacks.forEach((rec, i) => {
      let a = {};
      try { a = JSON.parse(rec.analysis); } catch (e) {}

      const r = cbSheet.addRow({
        num: i + 1,
        name: a.prospect_name || '-',
        callback: a.callback_time || '-',
        reason: a.status_reason || '-',
        url: rec.url,
        transcript: `${baseUrl}/#transcript/${rec.id}`
      });

      r.height = 22;
      const bg = i % 2 === 0 ? 'FFFEF3C7' : 'FFFFFBEB';
      r.eachCell(cell => {
        cell.font = { name: FONT_MAIN, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.border = thinBorder();
        cell.alignment = { vertical: 'middle' };
      });

      const urlCell = r.getCell('url');
      urlCell.value = { text: 'Play Recording', hyperlink: rec.url };
      urlCell.font = { name: FONT_MAIN, size: 10, color: { argb: 'FF92400E' }, underline: true };

      const tCell = r.getCell('transcript');
      tCell.value = { text: 'View Transcript', hyperlink: `${baseUrl}/#transcript/${rec.id}` };
      tCell.font = { name: FONT_MAIN, size: 10, color: { argb: 'FF92400E' }, underline: true };
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Send file
  // ══════════════════════════════════════════════════════════════
  const datePart = new Date().toISOString().split('T')[0];
  const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '-');
  const filename = `Call-Analysis-${safeName}-${datePart}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
