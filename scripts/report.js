#!/usr/bin/env node
'use strict';

// CLI: generate Guardian's activity report as a standalone HTML file.
//   node scripts/report.js [--out <path>]
// Default output: <continuityRoot>/report.html
// Reads only what Guardian already wrote (checkpoints + pending.json). No network.

const fs = require('node:fs');
const path = require('node:path');
const { continuityRoot } = require('../lib/paths');
const { collectReport, renderReportHtml } = require('../lib/report');

function parseOut(argv) {
  const i = argv.indexOf('--out');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return path.join(continuityRoot(), 'report.html');
}

function main() {
  const out = parseOut(process.argv.slice(2));
  const data = collectReport(continuityRoot());
  const html = renderReportHtml(data, new Date().toISOString());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  process.stdout.write(
    `Reporte escrito en ${out}\n` +
      `  ${data.totals.checkpoints} checkpoints · ${data.totals.resumes} retomadas · ${data.totals.projects} proyectos\n`
  );
}

main();
