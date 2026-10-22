'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { atomicWriteFileSync } = require('./atomic-write');

// Per-session part of state.json. state.json is one file per working
// directory and its top-level fields describe only the session that wrote it
// last, so two sessions sharing a folder would erase each other from the
// extension's list. `cacheSessions` keeps one small entry per session:
//   { [sessionId]: { transcriptPath, projectName, lastActivityAt, subscription, endedAt } }
// Read by lib/native-host.js (all folders), hooks/statusline.js and the bar
// (their own entry, via cache-clock.js sessionView).
//
// Every writer is a hook that re-reads state.json right before it writes and
// merges only its own entry, so another session's entry survives. Residual
// risk, accepted: read-modify-write is not locked, so two hooks of different
// sessions landing in the same few milliseconds can lose one entry's update.
// The next hook of that session (every tool call, every turn end) puts it back.

const MAX_CACHE_SESSIONS = 8;
const CACHE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function cacheSessionsOf(state) {
  const map = state && state.cacheSessions;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([, e]) => e && typeof e === 'object'));
}

function entryTime(entry) {
  return Math.max(Date.parse(entry.lastActivityAt) || 0, Date.parse(entry.endedAt) || 0);
}

// What a state written before this map existed says about its one session.
function topLevelEntry(state) {
  return {
    transcriptPath: state.transcriptPath || null,
    projectName: state.projectName || null,
    lastActivityAt: state.lastActivityAt || null,
    subscription: typeof state.subscription === 'boolean' ? state.subscription : null,
  };
}

// The map with `patch` merged into `sessionId`'s entry, entries older than
// 24 h dropped and only the 8 most recent kept. The entry being written always
// stays. The top-level fields of a state from before the map become an entry
// first, so the session that wrote them is not erased by this write.
function withSessionEntry(state, sessionId, patch, now = Date.now()) {
  const map = cacheSessionsOf(state);
  if (state && typeof state.sessionId === 'string' && !map[state.sessionId]) {
    map[state.sessionId] = topLevelEntry(state);
  }
  map[sessionId] = { ...map[sessionId], ...patch };

  const others = Object.entries(map)
    .filter(([id, e]) => id !== sessionId && now - entryTime(e) <= CACHE_SESSION_MAX_AGE_MS)
    .sort((a, b) => entryTime(b[1]) - entryTime(a[1]))
    .slice(0, MAX_CACHE_SESSIONS - 1);
  return Object.fromEntries([...others, [sessionId, map[sessionId]]]);
}

// Shared by the activity hooks that only stamp state.json (UserPromptSubmit,
// SessionEnd): fresh read, this session's entry merged, atomic write. The
// top-level fields are touched only when they already belong to this session.
function stampSession(input, patch, { now = Date.now() } = {}) {
  const sessionId = input && input.session_id;
  if (!sessionId || !input.cwd) return;
  const statePath = paths.statePath(input.cwd);
  const state = readJsonSafe(statePath) || {};
  const entryPatch = {
    transcriptPath: input.transcript_path || null,
    projectName: path.basename(path.resolve(input.cwd)),
    ...patch,
  };
  const next = { ...state, cacheSessions: withSessionEntry(state, sessionId, entryPatch, now) };
  if (state.sessionId === sessionId && patch.lastActivityAt) next.lastActivityAt = patch.lastActivityAt;
  atomicWriteFileSync(statePath, JSON.stringify(next, null, 2));
}

// SessionStart: a session reopened after its SessionEnd (claude --resume <id>)
// has a live cache again, so it is no longer "ended". Clears endedAt only; it
// stamps no activity (nothing was sent yet) and creates nothing.
function clearEnded(input) {
  const sessionId = input && input.session_id;
  if (!sessionId || !input.cwd) return;
  const statePath = paths.statePath(input.cwd);
  const state = readJsonSafe(statePath);
  const entry = cacheSessionsOf(state)[sessionId];
  if (!entry || !entry.endedAt) return;
  const { endedAt, ...rest } = entry;
  atomicWriteFileSync(statePath, JSON.stringify({ ...state, cacheSessions: { ...state.cacheSessions, [sessionId]: rest } }, null, 2));
}

module.exports = {
  clearEnded,
  MAX_CACHE_SESSIONS,
  CACHE_SESSION_MAX_AGE_MS,
  cacheSessionsOf,
  withSessionEntry,
  stampSession,
};
