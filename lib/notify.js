'use strict';

const https = require('node:https');

let notifier = null;
try {
  notifier = require('node-notifier');
} catch {
  notifier = null;
}

function sendOs(title, message) {
  if (!notifier) return;
  try {
    notifier.notify({ title, message });
  } catch {
    // Notification failures must never affect the calling hook/watcher.
  }
}

// Best-effort Telegram delivery. Intentionally NOT awaited: in a short-lived
// hook process the pending socket keeps the event loop alive until the POST
// finishes or the timeout fires, then the process exits normally. Any error
// (no network, bad token) is swallowed -- delivery never gates the hook. The
// bot token comes only from the local config file and is never logged.
function sendTelegram(title, message, cfg) {
  if (!cfg || cfg.enabled !== true || !cfg.botToken || !cfg.chatId) return;
  try {
    const body = JSON.stringify({ chat_id: cfg.chatId, text: `${title}\n${message}` });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${cfg.botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.setTimeout(cfg.timeoutMs || 5000, () => req.destroy());
    req.write(body);
    req.end();
  } catch {
    // best-effort: delivery must never break the hook
  }
}

// `config` is optional: hooks that already loaded it pass it in (hot path, no
// re-read); ad-hoc callers omit it and we lazy-load. Telegram stays silent
// unless explicitly configured, so tests and default installs never hit the net.
function send(title, message, config) {
  sendOs(title, message);
  let telegramCfg = config && config.telegram;
  if (telegramCfg === undefined) {
    try {
      telegramCfg = require('./config').loadConfig().telegram;
    } catch {
      telegramCfg = null;
    }
  }
  sendTelegram(title, message, telegramCfg);
}

module.exports = { send, sendTelegram };
