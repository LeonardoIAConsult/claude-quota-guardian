'use strict';

let notifier = null;
try {
  notifier = require('node-notifier');
} catch {
  notifier = null;
}

function send(title, message) {
  if (!notifier) return;
  try {
    notifier.notify({ title, message });
  } catch {
    // Notification failures must never affect the calling hook/watcher.
  }
}

module.exports = { send };
