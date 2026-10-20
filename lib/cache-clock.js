'use strict';

const fs = require('node:fs');

// Prompt-cache countdown, shared by the status line, the native host and the
// extension. Claude Code caches the conversation prefix after each request;
// while that cache is warm the next message re-reads the context cheaply, once
// it expires the next message pays full price for all of it again. Nothing in
// the hook payloads says when that happens, so Guardian estimates it:
//   last activity = the transcript's mtime (each message written there is a
//                   request that refreshed the cache)
//   ttl           = config.cache.ttlMinutes, else 60 min on a subscription
//                   and 5 min on an API key (detectSubscription below).
// lib/threshold-check.js and hooks/statusline.js write both signals into the
// session's state.json (lastActivityAt, subscription); the status line, the
// native host and the bar (bar/hooks/register.tsx, which carries the minutes
// math in TypeScript) all read them from there, so they agree.

const SUBSCRIPTION_TTL_MINUTES = 60;
const API_TTL_MINUTES = 5;
const DEFAULT_WARN_MINUTES = 5;

function resolveTtlMinutes(cacheConfig, { hasRateLimits } = {}) {
  const fixed = cacheConfig && cacheConfig.ttlMinutes;
  if (typeof fixed === 'number' && fixed > 0) return fixed;
  return hasRateLimits ? SUBSCRIPTION_TTL_MINUTES : API_TTL_MINUTES;
}

function resolveWarnMinutes(cacheConfig) {
  const warn = cacheConfig && cacheConfig.warnMinutes;
  return typeof warn === 'number' && warn >= 0 ? warn : DEFAULT_WARN_MINUTES;
}

// Settings that make Claude Code bill per token instead of a Pro/Max plan.
const API_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// Sessions the status line has seen rate_limits for (only subscriptions get
// them). A short list, not one id: two sessions sharing a folder would
// otherwise overwrite each other's proof on every refresh.
const MAX_PROVEN_SESSIONS = 16;

function provenSessions(state) {
  const list = state && state.subscriptionSessions;
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
}

// The list with `sessionId` added (newest last, capped), or null when it is
// already there: the caller then has nothing new to write.
function withProvenSession(state, sessionId) {
  const list = provenSessions(state);
  if (!sessionId || list.includes(sessionId)) return null;
  return [...list, sessionId].slice(-MAX_PROVEN_SESSIONS);
}

// Whether THIS session runs on a subscription, the one answer every surface
// reads from state.json (`subscription`). Strongest first: rate_limits seen
// for this very session; else an API setting in the environment means
// per-token; else an OAuth login (the credentials file, or a usage reading,
// which needs the OAuth token wherever it lives: the macOS Keychain too).
function detectSubscription({ prevState, sessionId, env = process.env, oauthLogin = false, usageReading = false }) {
  if (sessionId && provenSessions(prevState).includes(sessionId)) return { subscription: true, from: 'rate_limits' };
  if (API_ENV_VARS.some((name) => isSet(env[name]))) return { subscription: false, from: 'api-env' };
  if (oauthLogin || usageReading) return { subscription: true, from: 'login' };
  return { subscription: false, from: 'no-login' };
}

// An env switch written as 0/false/no/off (or empty) is a switch turned off.
function isSet(value) {
  return typeof value === 'string' && value.trim() !== '' && !/^(0|false|no|off)$/i.test(value.trim());
}

// The one precedence every surface uses for "is this session on a
// subscription": rate_limits proof (in this very payload / engine reading, or
// recorded for this session) first, then the session's stored answer. Null
// when the state has no answer for this session (a state from before 1.1.1).
// bar/hooks/shared.ts mirrors it: change both together.
function sessionSubscription(state, { rateLimitsNow = false } = {}) {
  if (rateLimitsNow) return true;
  if (state && state.sessionId && provenSessions(state).includes(state.sessionId)) return true;
  if (state && typeof state.subscription === 'boolean') return state.subscription;
  return null;
}

// A usage reading only proves an OAuth login while it is recent: the cached
// one is carried forward forever and may predate a logout.
const USAGE_READING_FRESH_MS = 60 * 60 * 1000;

function freshUsageReading(reading, now = Date.now()) {
  if (!reading) return false;
  const at = Date.parse(reading.fetchedAt);
  return !Number.isNaN(at) && now - at >= 0 && now - at <= USAGE_READING_FRESH_MS;
}

// When the session last used the cache: the newer of what the hooks stored
// and the transcript's mtime now. The status line, the host and the bar all
// use this, so they agree to the minute. Null before any activity.
function sessionLastActivity(state, transcriptMs) {
  const stored = state ? Date.parse(state.lastActivityAt) : NaN;
  const last = Math.max(Number.isNaN(stored) ? 0 : stored, transcriptMs || 0);
  return last > 0 ? last : null;
}

// mtime of the transcript in ms, or null when it is missing/unreadable.
function lastActivityMs(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
}

// { minutesLeft, expired, warn } for a cache last used at `lastMs`, or null
// when there is no activity yet. minutesLeft is rounded up so "1" means "under
// a minute left" and 0 only ever appears together with expired.
function cacheStatus({ lastMs, ttlMinutes, warnMinutes = DEFAULT_WARN_MINUTES, now = Date.now() }) {
  if (typeof lastMs !== 'number' || !Number.isFinite(lastMs)) return null;
  const leftMs = lastMs + ttlMinutes * 60000 - now;
  if (leftMs <= 0) return { minutesLeft: 0, expired: true, warn: true };
  const minutesLeft = Math.min(ttlMinutes, Math.ceil(leftMs / 60000));
  return { minutesLeft, expired: false, warn: minutesLeft <= warnMinutes };
}

module.exports = {
  SUBSCRIPTION_TTL_MINUTES,
  API_TTL_MINUTES,
  DEFAULT_WARN_MINUTES,
  resolveTtlMinutes,
  resolveWarnMinutes,
  API_ENV_VARS,
  MAX_PROVEN_SESSIONS,
  provenSessions,
  withProvenSession,
  detectSubscription,
  isSet,
  sessionSubscription,
  freshUsageReading,
  sessionLastActivity,
  lastActivityMs,
  cacheStatus,
};
