'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const scheduledTask = require('../lib/scheduled-task');
const notify = require('../lib/notify');
const codexAdapter = require('../lib/adapters/codex');

const DEFAULT_STALENESS_MS = 20 * 60 * 1000;

function findPendingFiles(root) {
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'pending.json'))
    .filter((file) => fs.existsSync(file));
}

function shouldNotifyReset(pending, now) {
  if (!pending || pending.resetNotified) return false;
  if (pending.triggeredBy !== 'plan' && pending.triggeredBy !== 'both') return false;
  if (!pending.planResetAtSeen) return false;

  return now.getTime() >= new Date(pending.planResetAtSeen).getTime();
}

function processPendingFile(pendingFile, { now, notifySend }) {
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    return { notified: false, projectName: null };
  }

  if (!shouldNotifyReset(pending, now)) {
    return { notified: false, projectName: pending.projectName || null };
  }

  notifySend(
    'Claude Quota Guardian',
    `Cuota de Claude reiniciada. Proyecto "${pending.projectName}" listo para continuar.`
  );

  pending.resetNotified = true;
  atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));

  return { notified: true, projectName: pending.projectName || null };
}

function runWatcherOnce({ now = new Date(), config = loadConfig(), notifySend = notify.send } = {}) {
  const root = paths.continuityRoot();
  const files = findPendingFiles(root);
  const send = config.notifications.enabled ? notifySend : () => {};

  let notified = 0;
  for (const file of files) {
    const result = processPendingFile(file, { now, notifySend: send });
    if (result.notified && config.notifications.enabled) notified += 1;
  }

  return { checked: files.length, notified };
}

// Poll non-Claude providers (notify-only tier: no hooks there, so no blocking
// and no auto-resume). Each fresh session gets a `<provider>-<hash>/state.json`
// in the same maxPct/updatedAt shape as project heartbeats, so readLiveMaxPct
// and the adaptive cadence react to these sessions with zero extra wiring.
// updatedAt is the session file's mtime, not the poll time -- an idle session
// goes stale on its own.
function pollProviders({ now = new Date(), config = loadConfig(), notifySend = notify.send } = {}) {
  const result = { sessions: 0, notified: 0 };
  const pc = (config.providers && config.providers.codex) || {};
  if (!pc.enabled) return result;

  const send = (config.notifications && config.notifications.enabled) ? notifySend : () => {};
  const warnPct = pc.warnPct != null ? pc.warnPct : 90;
  const renotifyMs = (pc.renotifyMinutes != null ? pc.renotifyMinutes : 15) * 60 * 1000;
  const stalenessMs = (pc.stalenessMinutes != null ? pc.stalenessMinutes : 20) * 60 * 1000;

  let sessions;
  try {
    sessions = codexAdapter.readCodexUsage({ root: paths.codexHome(), now, stalenessMs });
  } catch {
    return result;
  }

  for (const s of sessions) {
    result.sessions += 1;
    const stateFile = path.join(paths.providerStateDir('codex', s.file), 'state.json');

    let prev;
    try {
      prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
    } catch {
      prev = {};
    }

    let lastWarnedAt = prev.lastWarnedAt || null;
    if (s.maxPct >= warnPct) {
      const last = lastWarnedAt ? new Date(lastWarnedAt).getTime() : 0;
      if (now.getTime() - last >= renotifyMs) {
        lastWarnedAt = now.toISOString();
        send(
          'Claude Quota Guardian',
          `Codex al ${s.maxPct}% en "${s.projectName || 'sesión'}" — pedile un resumen/checkpoint del avance antes del corte.`
        );
        result.notified += 1;
      }
    }

    atomicWriteFileSync(stateFile, JSON.stringify({
      provider: 'codex',
      maxPct: s.maxPct,
      contextPct: s.contextPct,
      rateLimitPct: s.rateLimitPct,
      projectPath: s.projectPath,
      sessionId: s.sessionId,
      sessionFile: s.file,
      lastWarnedAt,
      updatedAt: s.updatedAt,
    }, null, 2));
  }

  return result;
}

// Highest live usage % across all active projects. Heartbeats older than
// stalenessMs are ignored (idle session = usage not climbing). Returns null when
// no fresh signal exists, which keeps the watcher at its base interval.
function readLiveMaxPct(root, { now = new Date(), stalenessMs = DEFAULT_STALENESS_MS } = {}) {
  if (!fs.existsSync(root)) return null;

  let max = null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stateFile = path.join(root, entry.name, 'state.json');
    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      continue;
    }
    if (typeof state.maxPct !== 'number') continue;
    if (state.updatedAt) {
      const age = now.getTime() - new Date(state.updatedAt).getTime();
      if (!Number.isFinite(age) || age > stalenessMs) continue;
    }
    if (max === null || state.maxPct > max) max = state.maxPct;
  }
  return max;
}

function readWatcherInterval() {
  try {
    const state = JSON.parse(fs.readFileSync(paths.watcherStatePath(), 'utf8'));
    return typeof state.intervalMinutes === 'number' ? state.intervalMinutes : null;
  } catch {
    return null;
  }
}

function defaultApplyReschedule(intervalMinutes, { platform = process.platform } = {}) {
  const desc = scheduledTask.describeReschedule(platform, {
    nodePath: process.execPath,
    watcherPath: __filename,
    intervalMinutes,
    logPath: paths.logPath(),
  });
  for (const file of desc.files || []) {
    const target = file.path.startsWith('~/')
      ? path.join(paths.homeDir(), file.path.slice(2))
      : file.path;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  for (const [cmd, ...args] of desc.commands) {
    execFileSync(cmd, args, { stdio: 'ignore' });
  }
}

// Compare desired cadence (from live usage) against the last-applied interval and
// re-register the OS schedule only when the tier actually changes. Reschedule
// side effects are injected so this stays unit-testable.
function reconcileInterval({
  now = new Date(),
  config = loadConfig(),
  applyReschedule = defaultApplyReschedule,
  readMaxPct = readLiveMaxPct,
  getCurrentInterval = readWatcherInterval,
} = {}) {
  const adaptive = config.adaptiveWatcher || {};
  if (!adaptive.enabled) return { changed: false, reason: 'disabled' };

  const maxPct = readMaxPct(paths.continuityRoot(), { now });
  const desired = scheduledTask.pickIntervalMinutes(maxPct, config);
  const current = getCurrentInterval();

  if (current === desired) {
    return { changed: false, intervalMinutes: desired, maxPct };
  }

  try {
    applyReschedule(desired);
  } catch (err) {
    return { changed: false, error: err.message, desired, maxPct };
  }

  atomicWriteFileSync(paths.watcherStatePath(), JSON.stringify({
    intervalMinutes: desired,
    maxPct,
    updatedAt: now.toISOString(),
  }, null, 2));

  return { changed: true, from: current, to: desired, maxPct };
}

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(paths.logPath()), { recursive: true });
    fs.appendFileSync(paths.logPath(), line);
  } catch {
    // logging is best-effort: a failed write here must not crash the watcher
  }
}

function main() {
  const summary = runWatcherOnce();
  let providerNote = '';
  try {
    const providers = pollProviders();
    if (providers.sessions > 0) providerNote = ` codex-sessions=${providers.sessions} codex-notified=${providers.notified}`;
  } catch (err) {
    providerNote = ` provider-error=${err.message}`;
  }
  let intervalNote = '';
  try {
    const result = reconcileInterval();
    if (result.changed) intervalNote = ` interval=${result.from}->${result.to}min (max=${result.maxPct}%)`;
    else if (result.error) intervalNote = ` interval-reschedule-failed=${result.error}`;
  } catch (err) {
    intervalNote = ` interval-error=${err.message}`;
  }
  appendLog(`checked=${summary.checked} notified=${summary.notified}${providerNote}${intervalNote}`);
}

if (require.main === module) {
  main();
}

module.exports = { findPendingFiles, shouldNotifyReset, processPendingFile, runWatcherOnce, pollProviders, readLiveMaxPct, readWatcherInterval, reconcileInterval, appendLog, main };
