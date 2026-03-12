const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../lib/db');

const router = express.Router();

function extractSid(url) {
  if (!url) return '-';
  try {
    const path = url.split('?')[0];
    const segments = path.split('/').filter(Boolean);
    const filename = segments[segments.length - 1] || '';
    const base = filename.replace(/\.[^.]+$/, '');
    const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return uuid[0];
    const sid = base.match(/[A-Z]{2}[0-9a-f]{32}/i);
    if (sid) return sid[0];
    const firstPart = base.split('_')[0];
    if (firstPart && firstPart.length >= 8) return firstPart;
    return base || '-';
  } catch (e) {
    return '-';
  }
}

const FONT_MAIN = 'Calibri';
const COLOR_HEADER_BG = 'FF1E293B';
const COLOR_HEADER_TEXT = 'FFFFFFFF';
const COLOR_LIGHT_ROW = 'FFF8FAFC';
const COLOR_WHITE = 'FFFFFFFF';
const COLOR_BORDER = 'FFE2E8F0';

const FIXED_STATUS_COLORS = {
  'Qualified':       { bg: 'FFDCFCE7', text: 'FF166534', tab: 'FF22C55E', header: 'FF166534' },
  'Disqualified':    { bg: 'FFFEE2E2', text: 'FF991B1B', tab: 'FFEF4444', header: 'FF991B1B' },
  'Call Back Later': { bg: 'FFFEF3C7', text: 'FF92400E', tab: 'FFF59E0B', header: 'FF92400E' },
  'DNC':             { bg: 'FFEDE9FE', text: 'FF5B21B6', tab: 'FF8B5CF6', header: 'FF5B21B6' },
};

// Deterministic color palette for custom statuses
const DYN_PALETTE = [
  { bg: 'FFE0F2FE', text: 'FF075985', tab: 'FF06B6D4', header: 'FF075985' },
  { bg: 'FFD1FAE5', text: 'FF065F46', tab: 'FF10B981', header: 'FF065F46' },
  { bg: 'FFFFF7ED', text: 'FF9A3412', tab: 'FFF97316', header: 'FF9A3412' },
  { bg: 'FFFCE7F3', text: 'FF9D174D', tab: 'FFEC4899', header: 'FF9D174D' },
  { bg: 'FFEFF6FF', text: 'FF1E40AF', tab: 'FF3B82F6', header: 'FF1E40AF' },
  { bg: 'FFF0FDF4', text: 'FF14532D', tab: 'FF14B8A6', header: 'FF14532D' },
];

function statusColors(status) {
  if (FIXED_STATUS_COLORS[status]) return FIXED_STATUS_COLORS[status];
  let h = 0;
  for (const c of (status || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return DYN_PALETTE[Math.abs(h) % DYN_PALETTE.length];
}

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

  // Dynamic breakdown from recordings
  const breakdown = db.getJobStatusBreakdown(job.id);

  let row = 5;
  // Stats header
  const statsHeaderRow = summary.getRow(row);
  summary.getCell(`A${row}`).value = 'Status';
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

  // Total first
  const totalRowEl = summary.getRow(row);
  summary.getCell(`A${row}`).value = 'Total Recordings';
  summary.getCell(`B${row}`).value = job.total_urls;
  summary.getCell(`A${row}`).font = { name: FONT_MAIN, size: 11 };
  summary.getCell(`B${row}`).font = { name: FONT_MAIN, size: 12, bold: true };
  summary.getCell(`B${row}`).alignment = { horizontal: 'center' };
  summary.getCell(`A${row}`).border = thinBorder();
  summary.getCell(`B${row}`).border = thinBorder();
  totalRowEl.height = 24;
  row++;

  // Dynamic status rows
  for (const { lead_status, count } of breakdown) {
    const sc = statusColors(lead_status);
    const r = summary.getRow(row);
    const cellA = summary.getCell(`A${row}`);
    const cellB = summary.getCell(`B${row}`);
    cellA.value = lead_status;
    cellB.value = count;
    cellA.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
    cellB.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } };
    cellA.font = { name: FONT_MAIN, size: 11, color: { argb: sc.text } };
    cellB.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: sc.text } };
    cellA.border = thinBorder();
    cellB.border = thinBorder();
    cellB.alignment = { horizontal: 'center' };
    r.height = 24;
    row++;
  }

  if (job.errors > 0) {
    summary.getCell(`A${row}`).value = 'Errors';
    summary.getCell(`B${row}`).value = job.errors;
    summary.getCell(`A${row}`).font = { name: FONT_MAIN, size: 11 };
    summary.getCell(`B${row}`).font = { name: FONT_MAIN, size: 11, bold: true };
    summary.getCell(`B${row}`).alignment = { horizontal: 'center' };
    summary.getCell(`A${row}`).border = thinBorder();
    summary.getCell(`B${row}`).border = thinBorder();
    summary.getRow(row).height = 24;
    row++;
  }

  // ══════════════════════════════════════════════════════════════
  // SHEET 2: All Results
  // ══════════════════════════════════════════════════════════════
  const sheet = workbook.addWorksheet('Results', {
    properties: { tabColor: { argb: 'FF22C55E' } },
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const columns = [
    { header: '#',               key: 'num',        width: 6  },
    { header: 'SID',             key: 'sid',        width: 36 },
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
      sid: extractSid(rec.url),
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

    // Status cell — dynamically coloured
    const statusCell = dataRow.getCell('status');
    const sc = rec.lead_status ? statusColors(rec.lead_status) : null;
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
  sheet.autoFilter = { from: 'A1', to: `O${recordings.length + 1}` };

  // ══════════════════════════════════════════════════════════════
  // SHEETS 3+: One sheet per status (dynamic — whatever the AI returned)
  // ══════════════════════════════════════════════════════════════
  for (const { lead_status } of breakdown) {
    const group = recordings.filter(r => r.lead_status === lead_status);
    if (group.length === 0) continue;

    const sc = statusColors(lead_status);
    // Safe sheet name (max 31 chars, no special chars)
    const sheetName = lead_status.replace(/[\\\/\?\*\[\]:]/g, '').substring(0, 31);

    const gSheet = workbook.addWorksheet(sheetName, {
      properties: { tabColor: { argb: sc.tab } },
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    gSheet.columns = [
      { header: '#',             key: 'num',        width: 6  },
      { header: 'SID',           key: 'sid',        width: 36 },
      { header: 'Prospect Name', key: 'name',       width: 24 },
      { header: 'Reason',        key: 'reason',     width: 44 },
      { header: 'Callback Time', key: 'callback',   width: 22 },
      { header: 'Recording',     key: 'url',        width: 36 },
      { header: 'Transcript',    key: 'transcript', width: 30 },
    ];

    const hRow = gSheet.getRow(1);
    hRow.height = 30;
    hRow.eachCell((cell) => {
      cell.font = { name: FONT_MAIN, size: 11, bold: true, color: { argb: COLOR_HEADER_TEXT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.header } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder();
    });

    // Alternate row colors: light/lighter version of status color
    const bgEven = sc.bg;
    const bgOdd  = 'FFFFFFFF';

    group.forEach((rec, i) => {
      let a = {};
      try { a = JSON.parse(rec.analysis); } catch (e) {}

      const r = gSheet.addRow({
        num: i + 1,
        sid: extractSid(rec.url),
        name: a.prospect_name || '-',
        reason: a.status_reason || '-',
        callback: a.callback_time || '-',
        url: rec.url,
        transcript: `${baseUrl}/#transcript/${rec.id}`
      });

      r.height = 22;
      const bg = i % 2 === 0 ? bgEven : bgOdd;
      r.eachCell(cell => {
        cell.font = { name: FONT_MAIN, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.border = thinBorder();
        cell.alignment = { vertical: 'middle' };
      });

      const urlCell = r.getCell('url');
      urlCell.value = { text: 'Play Recording', hyperlink: rec.url };
      urlCell.font = { name: FONT_MAIN, size: 10, color: { argb: sc.text }, underline: true };

      const tCell = r.getCell('transcript');
      tCell.value = { text: 'View Transcript', hyperlink: `${baseUrl}/#transcript/${rec.id}` };
      tCell.font = { name: FONT_MAIN, size: 10, color: { argb: sc.text }, underline: true };
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
