'use strict';

// Guardian activity report — evidence-based, no invented metrics.
//
// Reads the session-continuity tree that Guardian already writes (checkpoint
// files + pending.json per project) and turns it into a self-contained HTML
// dashboard. It reports ONLY what the system actually records: checkpoints
// created, sessions resumed (pending.consumed), what triggered each, and when.
// It never estimates "tokens saved" or anything the system does not measure.

const fs = require('node:fs');
const path = require('node:path');

function safeReadJson(fsmod, file) {
  try {
    return JSON.parse(fsmod.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Scan a continuity root dir and return structured, real data.
// `fsmod` is injectable for tests; defaults to node:fs.
function collectReport(continuityRoot, fsmod = fs) {
  const empty = {
    projects: [],
    totals: { projects: 0, checkpoints: 0, resumes: 0, byTrigger: {} },
  };
  let entries;
  try {
    entries = fsmod.readdirSync(continuityRoot, { withFileTypes: true });
  } catch {
    return empty; // root does not exist yet → nothing to report
  }

  const projects = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue; // skip config.json, watcher.log, etc.
    const dir = path.join(continuityRoot, ent.name);
    let files;
    try {
      files = fsmod.readdirSync(dir);
    } catch {
      continue;
    }
    const checkpoints = files.filter((f) => /^checkpoint-.*\.md$/.test(f)).sort();
    const pending = safeReadJson(fsmod, path.join(dir, 'pending.json'));

    // A provider dir is named "<provider>-<hash>" (e.g. codex-ab12...).
    const providerMatch = /^([a-z]+)-[0-9a-f]{12}$/.exec(ent.name);
    const provider = providerMatch ? providerMatch[1] : 'claude';

    const name =
      (pending && (pending.projectName || pending.projectPath)) ||
      (provider !== 'claude' ? `${provider} session` : ent.name);

    // Last checkpoint timestamp is embedded in the filename (checkpoint-<ts>.md).
    const lastCheckpoint =
      checkpoints.length > 0
        ? checkpoints[checkpoints.length - 1].replace(/^checkpoint-/, '').replace(/\.md$/, '')
        : null;

    projects.push({
      dir: ent.name,
      name,
      provider,
      checkpoints: checkpoints.length,
      lastCheckpoint,
      resumed: Boolean(pending && pending.consumed),
      triggeredBy: (pending && pending.triggeredBy) || null,
      triggeredAt: (pending && pending.triggeredAt) || null,
    });
  }

  // Deterministic order: most checkpoints first, then name.
  projects.sort((a, b) => b.checkpoints - a.checkpoints || a.name.localeCompare(b.name));

  const totals = projects.reduce(
    (acc, p) => {
      acc.projects += 1;
      acc.checkpoints += p.checkpoints;
      if (p.resumed) acc.resumes += 1;
      if (p.triggeredBy) acc.byTrigger[p.triggeredBy] = (acc.byTrigger[p.triggeredBy] || 0) + 1;
      return acc;
    },
    { projects: 0, checkpoints: 0, resumes: 0, byTrigger: {} }
  );

  return { projects, totals };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Render the collected data as a self-contained HTML dashboard (inline CSS).
function renderReportHtml(data, generatedAt) {
  const { projects, totals } = data;
  const rows =
    projects.length === 0
      ? '<tr><td colspan="5" class="empty">Sin checkpoints todavía — Guardian aún no ha entrado en acción.</td></tr>'
      : projects
          .map(
            (p) => `<tr>
      <td>${esc(p.name)}</td>
      <td class="prov">${esc(p.provider)}</td>
      <td class="num">${p.checkpoints}</td>
      <td>${p.resumed ? '✅ retomada' : '—'}</td>
      <td class="ts">${p.lastCheckpoint ? esc(p.lastCheckpoint) : '—'}</td>
    </tr>`
          )
          .join('\n');

  const triggerList =
    Object.keys(totals.byTrigger).length === 0
      ? '—'
      : Object.entries(totals.byTrigger)
          .map(([k, v]) => `${esc(k)}: ${v}`)
          .join(' · ');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guardian — reporte de actividad</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --ink:#e6edf3; --mut:#8b949e; --acc:#f0a726; --line:#30363d; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); padding:2rem 1rem; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .sub { color:var(--mut); margin:0 0 1.5rem; font-size:.9rem; }
  .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:.75rem; margin-bottom:1.5rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1rem; }
  .card .n { font-size:2rem; font-weight:700; color:var(--acc); }
  .card .l { color:var(--mut); font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th,td { text-align:left; padding:.6rem .8rem; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; }
  tr:last-child td { border-bottom:none; }
  .num,.prov { text-align:left; }
  .num { color:var(--acc); font-weight:600; }
  .ts { color:var(--mut); font-family:ui-monospace,monospace; font-size:.8rem; }
  .empty { color:var(--mut); text-align:center; padding:1.5rem; }
  .foot { color:var(--mut); font-size:.78rem; margin-top:1.25rem; }
  @media (max-width:560px){ .cards{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>🛡️ Guardian — reporte de actividad</h1>
  <p class="sub">Generado ${esc(generatedAt)} · datos reales de tus checkpoints (no estima tokens)</p>
  <div class="cards">
    <div class="card"><div class="n">${totals.checkpoints}</div><div class="l">Checkpoints creados</div></div>
    <div class="card"><div class="n">${totals.resumes}</div><div class="l">Sesiones retomadas</div></div>
    <div class="card"><div class="n">${totals.projects}</div><div class="l">Proyectos protegidos</div></div>
  </div>
  <table>
    <thead><tr><th>Proyecto</th><th>Proveedor</th><th>Checkpoints</th><th>Estado</th><th>Último checkpoint</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="foot">Disparadores: ${triggerList}. Este reporte solo cuenta lo que Guardian registra de verdad; no infiere ahorros que el sistema no mide.</p>
</div>
</body>
</html>`;
}

module.exports = { collectReport, renderReportHtml };
