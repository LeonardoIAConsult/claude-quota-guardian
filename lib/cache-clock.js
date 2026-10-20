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
//                   (the payload carries rate_limits) and 5 min on an API key.
// bar/hooks/register.tsx carries the same rule in TypeScript (a hooks module
// cannot require Node code) -- change both together.

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
  lastActivityMs,
  cacheStatus,
};
