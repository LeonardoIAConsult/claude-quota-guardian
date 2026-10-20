'use strict';

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const {
  cacheStatus,
  lastActivityMs,
  resolveTtlMinutes,
  resolveWarnMinutes,
  sessionLastActivity,
  sessionSubscription,
} = require('./cache-clock');

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

// Claude Code names a project's transcript folder after the folder the session
// started in, every character outside [A-Za-z0-9] turned into "-". The hooks'
// projectName is only the folder of the LAST cd ("lib", "scratchpad"), so the
// project name is recovered from that transcript folder. The encoding is lossy
// ("-" could be a separator or part of a name), so walk the real folders and
// match each entry's own encoding. Returns the full path, or null when the
// folder no longer exists.
function encodeFolder(name) {
  return name.replace(/[^A-Za-z0-9]/g, '-');
}

function walkEncoded(dir, rest) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const enc = encodeFolder(e.name);
    const full = path.join(dir, e.name);
    if (enc === rest) return full;
    if (rest.startsWith(`${enc}-`)) {
      const found = walkEncoded(full, rest.slice(enc.length + 1));
      if (found) return found;
    }
  }
  return null;
}

const HOME_LABEL = 'Inicio (~)';

function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function sameFolder(a, b) {
  const x = realPath(a);
  const y = realPath(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isHomeName(name) {
  const home = paths.homeDir();
  const same = (x, y) => (process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y);
  return same(name, path.basename(home)) || same(name, path.basename(realPath(home)));
}

// The project a transcript folder stands for: its folder name, HOME_LABEL when
// the session started in the home folder or at a drive root (a project name there
// would be the OS user's), or null when the folder cannot be decoded.
function projectFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string') return null;
  const folder = path.dirname(transcriptPath);
  if (path.basename(path.dirname(folder)) !== 'projects') return null;
  const encoded = path.basename(folder);
  const drive = /^([A-Za-z])--(.*)$/.exec(encoded);
  let start = null;
  if (drive) start = drive[2] ? walkEncoded(`${drive[1]}:/`, drive[2]) : `${drive[1]}:/`;
  else if (encoded.startsWith('-')) start = encoded.length > 1 ? walkEncoded('/', encoded.slice(1)) : '/';
  if (!start) return null;
  if (path.parse(start).root === start || sameFolder(start, paths.homeDir())) return HOME_LABEL;
  return path.basename(start);
}

// Cache countdown for each Claude Code session with a LIVE cache (not yet
// expired) and activity in the last 24 h, most recent first. An expired cache
// has nothing left to protect and is usually a closed session or a routine
// nobody watches, so it is left out. Each entry holds only a display name and numbers.
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

    const fromTranscript = typeof state.transcriptPath === 'string' ? lastActivityMs(state.transcriptPath) : null;
    const lastMs = sessionLastActivity(state, fromTranscript);
    if (!lastMs || now - lastMs > RECENT_MS) continue;

    // The session's own answer (lib/cache-clock.js detectSubscription, written
    // by the hooks; rate_limits proof first), the same one the status line and
    // the bar read. A state written before 1.1.1 has none: fall back to what
    // it does hold.
    const answer = sessionSubscription(state);
    const hasRateLimits = answer !== null
      ? answer
      : typeof state.rateLimitPct === 'number' || Boolean(state.apiUsage) || oauthLogin;
    const ttlMinutes = resolveTtlMinutes(cacheConfig, { hasRateLimits });
    const status = cacheStatus({ lastMs, ttlMinutes, warnMinutes: resolveWarnMinutes(cacheConfig), now });
    if (!status || status.expired) continue;

    const stored = typeof state.projectName === 'string' && state.projectName;
    const project = projectFromTranscript(state.transcriptPath)
      || (stored && (isHomeName(stored) ? HOME_LABEL : stored))
      || 'Claude Code';
    sessions.push({
      project: project.slice(0, 80),
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
  projectFromTranscript,
  handleMessage,
  encodeFrame,
  decodeFrame,
};
