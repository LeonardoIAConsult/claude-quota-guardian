'use strict';

const fs = require('node:fs');
const paths = require('./paths');

const DEFAULTS = {
  plan: 'none',
  // Hard-block thresholds. Enforcement only ever applies to the terminal
  // surface (transcript entrypoint === "cli"); every other surface is
  // heartbeat-only regardless of these values.
  // desktopWarn: notify-only warning threshold for the Claude Code Desktop
  // surface (never blocked). Set to null to silence Desktop entirely.
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
  // Exact account-wide 5h/7d usage straight from Anthropic's OAuth usage
  // endpoint (the one the CLI's /usage command uses). Undocumented endpoint:
  // on any failure Guardian degrades to the statusline/ccusage signals.
  // Note getStatus only consults it when `enabled` is literally true, so
  // hand-built configs (tests) never touch the network by accident.
  usageApi: { enabled: true, cacheSeconds: 60, timeoutMs: 5000 },
  // Non-Claude AI CLIs, watched notify-only by the background watcher (no
  // hook system there, so no blocking and no auto-resume -- just a warning
  // to save/summarize before the cutoff). warnPct is a percentage (0-100),
  // unlike `thresholds` above, because these providers report percentages.
  providers: {
    codex: { enabled: true, warnPct: 90, stalenessMinutes: 20, renotifyMinutes: 15 },
  },
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
    usageApi: { ...DEFAULTS.usageApi, ...(onDisk.usageApi || {}) },
    providers: {
      ...DEFAULTS.providers,
      ...Object.fromEntries(Object.entries(onDisk.providers || {}).map(([name, value]) => [
        name,
        { ...(DEFAULTS.providers[name] || {}), ...(value || {}) },
      ])),
    },
  };
}

module.exports = { loadConfig, DEFAULTS };
