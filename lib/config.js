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
  thresholds: { context: 0.986, plan: 0.986, desktopWarn: 0.96 },
  // When false, the local context-window estimate never drives a hard block or
  // predictive block -- only the real account plan quota does. The context% is
  // still measured and reported (statusline/heartbeat), just demoted from a
  // blocking signal. Use this when a reliable plan-quota signal (usageApi /
  // rate_limits) is available and the transcript context estimate is untrustworthy
  // (e.g. large/1M-token windows where used/limit overshoots). Default true keeps
  // the historical behavior.
  blockOnContext: true,
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
  // Predictive trigger: instead of only firing AT the hard threshold, fit a
  // slope to the last few context% readings and project it `leadSeconds` ahead.
  // If the projection crosses `thresholds.context` while the current reading is
  // still below it, checkpoint early -- ~leadSeconds before the wall, not on it.
  // Needs `minSamples` readings inside a `windowSeconds` window before it acts,
  // so a slow/idle session behaves exactly like the old fixed-threshold guard.
  predictive: {
    enabled: true,
    leadSeconds: 90,
    minSamples: 3,
    maxSamples: 8,
    windowSeconds: 300,
  },
  notifications: { enabled: true },
  // Optional Telegram delivery for the same messages shown as OS notifications.
  // Off until you set enabled + botToken + chatId (kept in the LOCAL config file,
  // never in git). Fire-and-forget with a short timeout; any failure is swallowed
  // so delivery never gates the hook.
  telegram: { enabled: false, botToken: null, chatId: null, timeoutMs: 5000 },
  // Downgrade nudge: when account quota enters the band [warnPct, hard block)
  // AND the session is on a premium model (name contains one of `models`),
  // suggest dropping to a cheaper model to stretch the quota. NOTIFY-ONLY --
  // hooks cannot switch the live model, so this never forces a change. CLI only.
  downgrade: { enabled: true, warnPct: 85, models: ['opus'] },
  // Exact account-wide 5h/7d usage straight from Anthropic's OAuth usage
  // endpoint (the one the CLI's /usage command uses). Undocumented endpoint:
  // on any failure Guardian degrades to the statusline/ccusage signals.
  // Note getStatus only consults it when `enabled` is literally true, so
  // hand-built configs (tests) never touch the network by accident.
  usageApi: { enabled: true, cacheSeconds: 60, timeoutMs: 5000 },
  // Per-model (scoped) quota warning. Session + weekly_all gate every model and
  // drive the hard block; a scoped cap (e.g. Fable) limits ONE model only, so it
  // is notify-only -- Guardian warns when it enters [warnPct, 100] but never
  // blocks, since other models still work.
  scoped: { enabled: true, warnPct: 85 },
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
    telegram: { ...DEFAULTS.telegram, ...(onDisk.telegram || {}) },
    downgrade: { ...DEFAULTS.downgrade, ...(onDisk.downgrade || {}) },
    adaptiveWatcher: { ...DEFAULTS.adaptiveWatcher, ...(onDisk.adaptiveWatcher || {}) },
    predictive: { ...DEFAULTS.predictive, ...(onDisk.predictive || {}) },
    usageApi: { ...DEFAULTS.usageApi, ...(onDisk.usageApi || {}) },
    scoped: { ...DEFAULTS.scoped, ...(onDisk.scoped || {}) },
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
