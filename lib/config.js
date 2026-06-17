'use strict';

const fs = require('node:fs');
const paths = require('./paths');

const DEFAULTS = {
  plan: 'none',
  // context: hard-block threshold for the CLI/IDE surface (PreToolUse really
  // stops tool calls there). desktopWarn: Claude Code Desktop shares this same
  // config/hooks but has no "end the turn" affordance like a terminal does, so
  // it only gets a notify-only warning at a lower threshold and is never
  // hard-blocked, even past `context`.
  thresholds: { context: 0.996, plan: 0.995, desktopWarn: 0.99 },
  // Optional: tokens in your plan's 5h window. ccusage >=20 no longer computes a
  // plan-quota %, so set this to enable plan-% monitoring (else context-% only).
  planTokenLimit: null,
  planCheckIntervalToolCalls: 5,
  watcherIntervalMinutes: 15,
  // Adaptive watcher cadence: poll less often when idle, ramp up as the session
  // approaches its limit. baseMinutes applies below the lowest tier; each tier
  // {atPct, minutes} shortens the interval once max(context%, plan%) >= atPct.
  adaptiveWatcher: {
    enabled: true,
    baseMinutes: 15,
    tiers: [
      { atPct: 90, minutes: 3 },
      { atPct: 98, minutes: 1 },
    ],
  },
  notifications: { enabled: true },
};

function loadConfig() {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(paths.configPath(), 'utf8'));
  } catch {
    onDisk = {};
  }
  return {
    ...DEFAULTS,
    ...onDisk,
    thresholds: { ...DEFAULTS.thresholds, ...(onDisk.thresholds || {}) },
    notifications: { ...DEFAULTS.notifications, ...(onDisk.notifications || {}) },
    adaptiveWatcher: { ...DEFAULTS.adaptiveWatcher, ...(onDisk.adaptiveWatcher || {}) },
  };
}

module.exports = { loadConfig, DEFAULTS };
