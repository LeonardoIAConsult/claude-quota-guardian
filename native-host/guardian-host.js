#!/usr/bin/env node
'use strict';

// Started by the browser for each extension request (chrome.runtime.
// sendNativeMessage): read one framed message, answer once, exit. See
// lib/native-host.js for what it reads and what it never sends.

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const paths = require('../lib/paths');
const { handleMessage, encodeFrame, decodeFrame } = require('../lib/native-host');

function reply(obj) {
  process.stdout.write(encodeFrame(obj), () => process.exit(0));
}

function logError(err) {
  try {
    fs.mkdirSync(path.dirname(paths.logPath()), { recursive: true });
    fs.appendFileSync(paths.logPath(), `[native-host] ${new Date().toISOString()} ERROR ${err && err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}

let buf = Buffer.alloc(0);
let answered = false;

process.stdin.on('data', (chunk) => {
  if (answered) return;
  buf = Buffer.concat([buf, chunk]);
  let message;
  try {
    message = decodeFrame(buf);
  } catch (err) {
    answered = true;
    logError(err);
    reply({ ok: false, error: 'bad-request' });
    return;
  }
  if (message === undefined) return;
  answered = true;
  try {
    reply(handleMessage(message, { config: loadConfig(), now: Date.now() }));
  } catch (err) {
    logError(err);
    reply({ ok: false, error: 'host-error' });
  }
});

process.stdin.on('end', () => {
  if (!answered) process.exit(0);
});
