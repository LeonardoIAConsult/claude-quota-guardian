'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const notify = require('../lib/notify');

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
  appendLog(`checked=${summary.checked} notified=${summary.notified}`);
}

if (require.main === module) {
  main();
}

module.exports = { findPendingFiles, shouldNotifyReset, processPendingFile, runWatcherOnce, appendLog, main };
