'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { cacheStatus, lastActivityMs, resolveTtlMinutes, resolveWarnMinutes } = require('./cache-clock');

// Native-messaging bridge between the browser extension and Claude Code's
// local state. The extension cannot read files, so Chrome/Edge/Brave start
// native-host/guardian-host.js on request and talk to it over stdin/stdout.
// Read-only by design: it lists Guardian's own state.json files and answers
// with the cache countdown per project -- no paths, no file contents, no
// transcript text ever leave this machine's disk.

const HOST_NAME = 'com.leonardoantolinez.quota_guardian';
// Fixed by the "key" in extension/manifest.json, so only that extension can
// start the host (allowed_origins below).
const EXTENSION_ID = 'ibdecbijeejndpgpkjgopiapdeekodpo';
const MAX_SESSIONS = 8;
const RECENT_MS = 24 * 60 * 60 * 1000;

// Outside session-continuity on purpose: every folder there is read as a
// project (report, watcher, the host itself), so the launcher must not be one.
function hostDir() {
  return path.join(paths.claudeHome(), 'quota-guardian-native-host');
}

// Where 1.1 builds before the review put it; install and uninstall remove it.
function legacyHostDir() {
  return path.join(paths.continuityRoot(), 'native-host');
}

function hostManifest(launcherPath) {
  return {
    name: HOST_NAME,
    description: 'Claude Quota Guardian: prompt-cache countdown for the browser extension (read-only).',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

// Per-browser places Chromium-based browsers look for a host manifest. Windows reads the
// manifest path from the registry; macOS and Linux read fixed folders.
const WIN_REGISTRY_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
];
const MAC_DIRS = [
  'Library/Application Support/Google/Chrome/NativeMessagingHosts',
  'Library/Application Support/Microsoft Edge/NativeMessagingHosts',
  'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  'Library/Application Support/Chromium/NativeMessagingHosts',
];
const LINUX_DIRS = [
  '.config/google-chrome/NativeMessagingHosts',
  '.config/microsoft-edge/NativeMessagingHosts',
  '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  '.config/chromium/NativeMessagingHosts',
];

// What installing the host means on `platform`: files to write and commands to
// run. Pure, so tests can check it without touching the registry.
function describeInstall(platform, { nodePath, hostScript }) {
  const dir = hostDir();
  const manifestFile = `${HOST_NAME}.json`;

  if (platform === 'win32') {
    const launcher = path.join(dir, 'guardian-host.cmd');
    const manifestPath = path.join(dir, manifestFile);
    return {
      files: [
        { path: launcher, content: `@echo off\r\n"${nodePath}" "${hostScript}"\r\n` },
        { path: manifestPath, content: JSON.stringify(hostManifest(launcher), null, 2) },
      ],
      commands: WIN_REGISTRY_KEYS.map((key) => (
        ['reg', 'add', `${key}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']
      )),
    };
  }

  const launcher = path.join(dir, 'guardian-host.sh');
  const manifest = JSON.stringify(hostManifest(launcher), null, 2);
  const browserDirs = platform === 'darwin' ? MAC_DIRS : LINUX_DIRS;
  return {
    files: [
      { path: launcher, content: `#!/bin/sh\nexec "${nodePath}" "${hostScript}"\n`, mode: 0o755 },
      ...browserDirs.map((rel) => ({ path: path.join(paths.homeDir(), rel, manifestFile), content: manifest })),
    ],
    commands: [],
  };
}

function describeUninstall(platform) {
  const dir = hostDir();
  if (platform === 'win32') {
    return {
      files: [path.join(dir, 'guardian-host.cmd'), path.join(dir, `${HOST_NAME}.json`)],
      commands: WIN_REGISTRY_KEYS.map((key) => ['reg', 'delete', `${key}\\${HOST_NAME}`, '/f']),
    };
  }
  const browserDirs = platform === 'darwin' ? MAC_DIRS : LINUX_DIRS;
  return {
    files: [
      path.join(dir, 'guardian-host.sh'),
      ...browserDirs.map((rel) => path.join(paths.homeDir(), rel, `${HOST_NAME}.json`)),
    ],
    commands: [],
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Cache countdown for each Claude Code project active in the last 24 h, most
// recent first. Each entry holds only a display name and numbers.
function collectCacheSessions({ config, now = Date.now(), root = paths.continuityRoot(), oauthCredentialsPath = paths.oauthCredentialsPath() }) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  // state.json is per working directory, and one session that changes its
  // directory leaves one per folder it visited. The cache belongs to the
  // session, so keep only the most recently written state per transcript.
  const latest = new Map();
  for (const d of dirs) {
    const state = readJsonSafe(path.join(root, d.name, 'state.json'));
    if (!state || typeof state !== 'object') continue;
    const id = (typeof state.transcriptPath === 'string' && state.transcriptPath) || state.sessionId || d.name;
    const prev = latest.get(id);
    if (!prev || (Date.parse(state.updatedAt) || 0) > (Date.parse(prev.updatedAt) || 0)) latest.set(id, state);
  }

  const cacheConfig = config && config.cache;
  const oauthLogin = fs.existsSync(oauthCredentialsPath);
  const sessions = [];
  for (const state of latest.values()) {

    const stored = Date.parse(state.lastActivityAt);
    const fromTranscript = typeof state.transcriptPath === 'string' ? lastActivityMs(state.transcriptPath) : null;
    const lastMs = Math.max(Number.isNaN(stored) ? 0 : stored, fromTranscript || 0);
    if (!lastMs || now - lastMs > RECENT_MS) continue;

    // Subscription signals: Guardian's own status line (rateLimitPct), the
    // usage endpoint (apiUsage) or, when neither runs, an OAuth login on disk.
    const hasRateLimits = typeof state.rateLimitPct === 'number' || Boolean(state.apiUsage) || oauthLogin;
    const ttlMinutes = resolveTtlMinutes(cacheConfig, { hasRateLimits });
    const status = cacheStatus({ lastMs, ttlMinutes, warnMinutes: resolveWarnMinutes(cacheConfig), now });
    if (!status) continue;

    sessions.push({
      project: typeof state.projectName === 'string' && state.projectName ? state.projectName.slice(0, 80) : 'Claude Code',
      ttlMinutes,
      minutesLeft: status.minutesLeft,
      expired: status.expired,
      warn: status.warn,
      lastActivityAt: new Date(lastMs).toISOString(),
    });
  }

  sessions.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  return sessions.slice(0, MAX_SESSIONS);
}

function handleMessage(message, { config, now }) {
  if (!message || message.type !== 'cache') return { ok: false, error: 'unknown-request' };
  if (config && config.cache && config.cache.enabled === false) return { ok: true, disabled: true, sessions: [] };
  return { ok: true, sessions: collectCacheSessions({ config, now }) };
}

// Chrome native messaging framing: 4-byte little-endian length, then UTF-8 JSON.
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Returns the first complete message in `buf`, or undefined while incomplete.
// Throws on a frame larger than `maxBytes` (a request is a few bytes).
function decodeFrame(buf, maxBytes = 64 * 1024) {
  if (buf.length < 4) return undefined;
  const len = buf.readUInt32LE(0);
  if (len > maxBytes) throw new Error('frame too large');
  if (buf.length < 4 + len) return undefined;
  return JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
}

module.exports = {
  HOST_NAME,
  EXTENSION_ID,
  MAX_SESSIONS,
  hostDir,
  legacyHostDir,
  hostManifest,
  describeInstall,
  describeUninstall,
  collectCacheSessions,
  handleMessage,
  encodeFrame,
  decodeFrame,
};
