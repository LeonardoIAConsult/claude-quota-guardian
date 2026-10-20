const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const host = require('../../lib/native-host');
const { DEFAULTS } = require('../../lib/config');

const HOST_SCRIPT = path.join(__dirname, '..', '..', 'native-host', 'guardian-host.js');
const NOW = Date.parse('2026-10-19T20:00:00Z');
const MIN = 60000;
const NO_CREDS = path.join(os.tmpdir(), 'cqg-no-credentials-xyz.json');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-host-'));
}

function writeState(root, name, state) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'state.json'), JSON.stringify(state));
}

test('manifest only allows the Guardian extension to start the host', () => {
  const m = host.hostManifest('/x/guardian-host.sh');
  assert.deepStrictEqual(m.allowed_origins, [`chrome-extension://${host.EXTENSION_ID}/`]);
  assert.strictEqual(m.type, 'stdio');
  assert.match(m.name, /^[a-z0-9_.]+$/);
});

test('extension id in lib matches the key pinned in extension/manifest.json', () => {
  const crypto = require('node:crypto');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'manifest.json'), 'utf8'));
  const der = Buffer.from(manifest.key, 'base64');
  const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)
    .split('').map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
  assert.strictEqual(id, host.EXTENSION_ID);
  assert.ok(manifest.permissions.includes('nativeMessaging'));
});

test('describeInstall on win32 writes a launcher + manifest and registers Chrome, Edge, Brave and Chromium', () => {
  const d = host.describeInstall('win32', { nodePath: 'C:\\node\\node.exe', hostScript: 'C:\\g\\native-host\\guardian-host.js' });
  assert.strictEqual(d.files.length, 2);
  assert.match(d.files[0].content, /"C:\\node\\node\.exe" "C:\\g\\native-host\\guardian-host\.js"/);
  const manifest = JSON.parse(d.files[1].content);
  assert.strictEqual(manifest.path, d.files[0].path);
  assert.strictEqual(d.commands.length, 4);
  for (const cmd of d.commands) {
    assert.strictEqual(cmd[0], 'reg');
    assert.ok(cmd[2].endsWith(`\\${host.HOST_NAME}`));
    assert.strictEqual(cmd[cmd.indexOf('/d') + 1], d.files[1].path);
  }
});

test('describeInstall on darwin/linux writes an executable launcher and one manifest per browser', () => {
  for (const platform of ['darwin', 'linux']) {
    const d = host.describeInstall(platform, { nodePath: '/usr/bin/node', hostScript: '/g/native-host/guardian-host.js' });
    assert.strictEqual(d.commands.length, 0);
    assert.strictEqual(d.files[0].mode, 0o755);
    assert.match(d.files[0].content, /^#!\/bin\/sh\nexec "\/usr\/bin\/node" "\/g\/native-host\/guardian-host\.js"/);
    assert.strictEqual(d.files.length, 5);
    for (const f of d.files.slice(1)) {
      assert.ok(f.path.endsWith(`${host.HOST_NAME}.json`));
      assert.strictEqual(JSON.parse(f.content).path, d.files[0].path);
    }
  }
});

test('describeUninstall mirrors describeInstall', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const inst = host.describeInstall(platform, { nodePath: 'n', hostScript: 's' });
    const un = host.describeUninstall(platform);
    assert.deepStrictEqual(un.files.sort(), inst.files.map((f) => f.path).sort());
    assert.strictEqual(un.commands.length, inst.commands.length);
  }
});

test('collectCacheSessions: one entry per recent project, newest first, only names and numbers', () => {
  const root = makeRoot();
  writeState(root, 'aaa', { projectName: 'web', lastActivityAt: new Date(NOW - 10 * MIN).toISOString(), rateLimitPct: 40 });
  writeState(root, 'bbb', { projectName: 'api', lastActivityAt: new Date(NOW - 2 * MIN).toISOString() });
  writeState(root, 'old', { projectName: 'stale', lastActivityAt: new Date(NOW - 25 * 60 * MIN).toISOString() });
  writeState(root, 'codex-1', { maxPct: 10 });
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', 'state.json'), '{not json');

  const sessions = host.collectCacheSessions({ config: DEFAULTS, now: NOW, root, oauthCredentialsPath: NO_CREDS });
  assert.deepStrictEqual(sessions.map((s) => s.project), ['api', 'web']);
  assert.deepStrictEqual(sessions[0], {
    project: 'api', ttlMinutes: 5, minutesLeft: 3, expired: false, warn: true,
    lastActivityAt: new Date(NOW - 2 * MIN).toISOString(),
  });
  assert.strictEqual(sessions[1].ttlMinutes, 60); // rate_limits seen -> subscription
  assert.strictEqual(sessions[1].minutesLeft, 50);
  for (const s of sessions) {
    assert.deepStrictEqual(Object.keys(s).sort(), ['expired', 'lastActivityAt', 'minutesLeft', 'project', 'ttlMinutes', 'warn']);
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test('collectCacheSessions: the transcript mtime beats an older stored lastActivityAt, path is never returned', () => {
  const root = makeRoot();
  const transcript = path.join(root, 't.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const recent = new Date(NOW - 1 * MIN);
  fs.utimesSync(transcript, recent, recent);
  writeState(root, 'aaa', { projectName: 'web', transcriptPath: transcript, apiUsage: { pct: 1 }, lastActivityAt: new Date(NOW - 30 * MIN).toISOString() });

  const [s] = host.collectCacheSessions({ config: DEFAULTS, now: NOW, root, oauthCredentialsPath: NO_CREDS });
  assert.strictEqual(s.minutesLeft, 59);
  assert.ok(!JSON.stringify(s).includes('t.jsonl'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('collectCacheSessions: one session that changed folders is listed once, under its latest folder', () => {
  const root = makeRoot();
  const transcript = path.join(root, 't.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const t = new Date(NOW - 1 * MIN);
  fs.utimesSync(transcript, t, t);
  writeState(root, 'aaa', { projectName: 'repo', transcriptPath: transcript, sessionId: 's1', updatedAt: new Date(NOW - 5 * MIN).toISOString() });
  writeState(root, 'bbb', { projectName: 'repo-sub', transcriptPath: transcript, sessionId: 's1', updatedAt: new Date(NOW - 1 * MIN).toISOString() });
  writeState(root, 'ccc', { projectName: 'other', sessionId: 's2', lastActivityAt: new Date(NOW - 3 * MIN).toISOString() });

  const sessions = host.collectCacheSessions({ config: DEFAULTS, now: NOW, root, oauthCredentialsPath: NO_CREDS });
  assert.deepStrictEqual(sessions.map((s) => s.project), ['repo-sub', 'other']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collectCacheSessions: an OAuth login on disk means subscription even without Guardian\'s status line', () => {
  const root = makeRoot();
  const creds = path.join(root, 'creds.json');
  fs.writeFileSync(creds, '{}');
  writeState(root, 'aaa', { projectName: 'web', lastActivityAt: new Date(NOW - 10 * MIN).toISOString() });

  const [s] = host.collectCacheSessions({ config: DEFAULTS, now: NOW, root, oauthCredentialsPath: creds });
  assert.strictEqual(s.ttlMinutes, 60);
  assert.strictEqual(s.minutesLeft, 50);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collectCacheSessions: caps the list and the project name length', () => {
  const root = makeRoot();
  for (let i = 0; i < 12; i += 1) {
    writeState(root, `p${i}`, { projectName: 'x'.repeat(200), lastActivityAt: new Date(NOW - i * MIN).toISOString() });
  }
  const sessions = host.collectCacheSessions({ config: DEFAULTS, now: NOW, root, oauthCredentialsPath: NO_CREDS });
  assert.strictEqual(sessions.length, host.MAX_SESSIONS);
  assert.strictEqual(sessions[0].project.length, 80);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collectCacheSessions: missing root is an empty list', () => {
  assert.deepStrictEqual(host.collectCacheSessions({ config: DEFAULTS, now: NOW, root: path.join(os.tmpdir(), 'cqg-nope-xyz'), oauthCredentialsPath: NO_CREDS }), []);
});

test('handleMessage: unknown requests are refused, cache.enabled=false answers empty', () => {
  assert.deepStrictEqual(host.handleMessage({ type: 'read', file: '/etc/passwd' }, { config: DEFAULTS, now: NOW }), { ok: false, error: 'unknown-request' });
  assert.deepStrictEqual(host.handleMessage(null, { config: DEFAULTS, now: NOW }), { ok: false, error: 'unknown-request' });
  const off = { ...DEFAULTS, cache: { ...DEFAULTS.cache, enabled: false } };
  assert.deepStrictEqual(host.handleMessage({ type: 'cache' }, { config: off, now: NOW }), { ok: true, disabled: true, sessions: [] });
});

test('frames round-trip and oversized frames are rejected', () => {
  const frame = host.encodeFrame({ type: 'cache' });
  assert.strictEqual(frame.readUInt32LE(0), frame.length - 4);
  assert.deepStrictEqual(host.decodeFrame(frame), { type: 'cache' });
  assert.strictEqual(host.decodeFrame(frame.subarray(0, 6)), undefined);
  const big = Buffer.alloc(4);
  big.writeUInt32LE(10 * 1024 * 1024, 0);
  assert.throws(() => host.decodeFrame(big), /too large/);
});

function runHost(input, home) {
  const res = spawnSync(process.execPath, [HOST_SCRIPT], { input, env: { ...process.env, CQG_HOME: home }, timeout: 10000 });
  assert.strictEqual(res.status, 0, String(res.stderr));
  return host.decodeFrame(res.stdout);
}

test('guardian-host.js answers one framed request over stdio, as Chrome calls it', () => {
  const home = makeRoot();
  const root = path.join(home, '.claude', 'session-continuity');
  writeState(root, 'aaa', { projectName: 'web', lastActivityAt: new Date().toISOString(), rateLimitPct: 10 });

  const reply = runHost(host.encodeFrame({ type: 'cache' }), home);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.sessions.length, 1);
  assert.strictEqual(reply.sessions[0].project, 'web');
  assert.strictEqual(reply.sessions[0].ttlMinutes, 60);

  fs.rmSync(home, { recursive: true, force: true });
});

test('guardian-host.js refuses a malformed request instead of crashing', () => {
  const home = makeRoot();
  const big = Buffer.alloc(4);
  big.writeUInt32LE(10 * 1024 * 1024, 0);
  assert.deepStrictEqual(runHost(big, home), { ok: false, error: 'bad-request' });

  const garbage = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{{{')]);
  assert.deepStrictEqual(runHost(garbage, home), { ok: false, error: 'bad-request' });
  fs.rmSync(home, { recursive: true, force: true });
});
