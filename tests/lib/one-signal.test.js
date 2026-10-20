// One "last activity" and one "subscription" answer per session, written by the
// hooks into state.json and read by the status line and the native host (the
// bar reads the same fields: bar/hooks/register.test.tsx).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const clock = require('../../lib/cache-clock');
const paths = require('../../lib/paths');
const { performCheck } = require('../../lib/threshold-check');
const host = require('../../lib/native-host');
const { DEFAULTS } = require('../../lib/config');

const STATUSLINE = path.join(__dirname, '..', '..', 'hooks', 'statusline.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const MIN = 60000;

function withoutApiEnv(t) {
  const saved = {};
  for (const name of clock.API_ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-signal-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-signal-project-'));
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME; else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const transcript = path.join(home, 'transcript.jsonl');
  fs.copyFileSync(path.join(FIXTURES, 'transcript-50pct.jsonl'), transcript);
  // copyFileSync keeps the fixture's old mtime on Windows: make it a live session
  const fresh = new Date(Date.now() - MIN);
  fs.utimesSync(transcript, fresh, fresh);
  return { home, cwd, transcript };
}

function ageFile(file, minutes) {
  const when = new Date(Date.now() - minutes * MIN);
  fs.utimesSync(file, when, when);
}

function statusLine(input, home, env = {}) {
  const clean = { ...process.env, CQG_HOME: home, ...env };
  for (const name of clock.API_ENV_VARS) if (!(name in env)) delete clean[name];
  return execFileSync('node', [STATUSLINE], { input: JSON.stringify(input), encoding: 'utf8', env: clean });
}

const config = { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } };

test('detectSubscription: rate_limits seen for this session wins, but only for that session', () => {
  const prevState = { subscriptionSessions: ['s0', 's1'] };
  assert.deepStrictEqual(clock.detectSubscription({ prevState, sessionId: 's1', env: { ANTHROPIC_API_KEY: 'x' } }), { subscription: true, from: 'rate_limits' });
  assert.deepStrictEqual(clock.detectSubscription({ prevState, sessionId: 's2', env: {}, oauthLogin: false }), { subscription: false, from: 'no-login' });
});

test('detectSubscription: an API setting beats an OAuth login on the same machine', () => {
  for (const name of clock.API_ENV_VARS) {
    assert.deepStrictEqual(clock.detectSubscription({ env: { [name]: '1' }, oauthLogin: true }), { subscription: false, from: 'api-env' });
  }
  assert.deepStrictEqual(clock.detectSubscription({ env: {}, oauthLogin: true }), { subscription: true, from: 'login' });
  assert.deepStrictEqual(clock.detectSubscription({ env: {}, oauthLogin: false }), { subscription: false, from: 'no-login' });
});

test('performCheck writes the session\'s subscription answer into state.json', (t) => {
  withoutApiEnv(t);
  const { home, cwd, transcript } = sandbox(t);
  performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });
  let state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.subscription, false);
  assert.strictEqual(state.subscriptionFrom, 'no-login');

  fs.writeFileSync(paths.oauthCredentialsPath(), '{}');
  performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });
  state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.subscription, true);
  assert.strictEqual(state.subscriptionFrom, 'login');

  process.env.ANTHROPIC_API_KEY = 'sk-test';
  performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });
  state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.subscription, false);
  assert.strictEqual(state.subscriptionFrom, 'api-env');
  assert.ok(!fs.existsSync(home + '-never'));
});

test('the status line\'s rate_limits proof survives the next hook rewrite of state.json', (t) => {
  withoutApiEnv(t);
  const { home, cwd, transcript } = sandbox(t);
  statusLine({ cwd, session_id: 's1', transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1738425600 } } }, home);
  performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });

  const state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.subscription, true);
  assert.strictEqual(state.subscriptionFrom, 'rate_limits');
  assert.deepStrictEqual(state.subscriptionSessions, ['s1']);

  // a new session in the same folder starts from scratch (no login here -> API ttl)
  performCheck({ transcript_path: transcript, cwd, session_id: 's2' }, { config });
  assert.strictEqual(JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8')).subscription, false);
});

test('two sessions sharing a folder do not make the idle status line rewrite state.json', (t) => {
  withoutApiEnv(t);
  const { home, cwd, transcript } = sandbox(t);
  const rl = { five_hour: { used_percentage: 10, resets_at: 1738425600 } };
  for (const id of ['A', 'B']) statusLine({ cwd, session_id: id, transcript_path: transcript, rate_limits: rl }, home);

  const file = paths.statePath(cwd);
  const settled = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(settled.subscriptionSessions, ['A', 'B']);
  for (const id of ['B', 'A', 'B', 'A']) {
    statusLine({ cwd, session_id: id, transcript_path: transcript, rate_limits: rl }, home);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt, settled.updatedAt, `refresh of ${id} rewrote state.json`);
  }
});

test('a proof for another session in the folder leaves the current session\'s answer alone', (t) => {
  withoutApiEnv(t);
  const { home, cwd, transcript } = sandbox(t);
  fs.mkdirSync(path.dirname(paths.statePath(cwd)), { recursive: true });
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ sessionId: 'A', subscription: false, subscriptionFrom: 'api-env' }));
  statusLine({ cwd, session_id: 'B', transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1738425600 } } }, home);

  const state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.deepStrictEqual(state.subscriptionSessions, ['B']);
  assert.strictEqual(state.subscription, false); // A's own answer, untouched
  assert.strictEqual(state.subscriptionFrom, 'api-env');
});

test('the proven-session list is capped', () => {
  let state = {};
  for (let i = 0; i < clock.MAX_PROVEN_SESSIONS + 5; i += 1) state = { subscriptionSessions: clock.withProvenSession(state, `s${i}`) };
  assert.strictEqual(state.subscriptionSessions.length, clock.MAX_PROVEN_SESSIONS);
  assert.strictEqual(clock.withProvenSession(state, `s${clock.MAX_PROVEN_SESSIONS + 4}`), null);
});

test('macOS (OAuth token in the Keychain, no credentials file): a usage reading still means subscription', (t) => {
  withoutApiEnv(t);
  const { cwd, transcript } = sandbox(t);
  assert.deepStrictEqual(clock.detectSubscription({ env: {}, oauthLogin: false, usageReading: true }), { subscription: true, from: 'login' });

  // the hooks' cached usage reading (what lib/usage-api.js got with the Keychain token)
  fs.mkdirSync(path.dirname(paths.statePath(cwd)), { recursive: true });
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ apiUsage: { pct: 12, fetchedAt: Date.now() } }));
  performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });
  const state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.subscription, true);
  const [s] = host.collectCacheSessions({ config: DEFAULTS, root: paths.continuityRoot(), oauthCredentialsPath: path.join(os.tmpdir(), 'none') });
  assert.strictEqual(s.ttlMinutes, 60);
});

test('the host trusts the rate_limits proof over a stale false written before it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-signal-host-'));
  fs.mkdirSync(path.join(root, 'aaa'));
  fs.writeFileSync(path.join(root, 'aaa', 'state.json'), JSON.stringify({
    sessionId: 's1', subscription: false, subscriptionFrom: 'no-login', subscriptionSessions: ['s1'],
    projectName: 'web', lastActivityAt: new Date(Date.now() - 10 * MIN).toISOString(),
  }));
  const [s] = host.collectCacheSessions({ config: DEFAULTS, root, oauthCredentialsPath: path.join(root, 'none') });
  assert.strictEqual(s.ttlMinutes, 60);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the status line ignores a state.json last written by another session in the folder', (t) => {
  withoutApiEnv(t);
  const { home, cwd, transcript } = sandbox(t);
  fs.mkdirSync(path.dirname(paths.statePath(cwd)), { recursive: true });
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ sessionId: 'other', subscription: true, lastActivityAt: new Date().toISOString() }));
  ageFile(transcript, 2);
  const line = statusLine({ cwd, session_id: 'mine', transcript_path: transcript }, home);
  assert.match(line, /cache 3m!$/); // API ttl from its own (absent) answer, minutes from its own transcript
});

test('status line and native host show the same minutes for the same session', (t) => {
  withoutApiEnv(t);
  const { home, cwd, transcript } = sandbox(t);
  const root = paths.continuityRoot();
  const noCreds = path.join(home, 'no-creds.json');

  for (const [label, prepare, expectTtl] of [
    ['API key session', () => {}, 5],
    ['OAuth login, no rate_limits yet', () => fs.writeFileSync(paths.oauthCredentialsPath(), '{}'), 60],
  ]) {
    prepare();
    ageFile(transcript, 3);
    performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });
    ageFile(transcript, 3);

    const line = statusLine({ cwd, session_id: 's1', transcript_path: transcript }, home);
    const fromLine = Number((line.match(/cache (\d+)m/) || [])[1]);
    const [fromHost] = host.collectCacheSessions({ config: DEFAULTS, root, oauthCredentialsPath: noCreds });

    assert.strictEqual(fromHost.ttlMinutes, expectTtl, label);
    assert.strictEqual(fromLine, fromHost.minutesLeft, `${label}: line "${line}" vs host ${fromHost.minutesLeft}`);
  }
});

test('an API-key session on a machine with an OAuth login shows 5 min in the host, not 60', (t) => {
  withoutApiEnv(t);
  const { cwd, transcript } = sandbox(t);
  fs.mkdirSync(path.dirname(paths.oauthCredentialsPath()), { recursive: true });
  fs.writeFileSync(paths.oauthCredentialsPath(), '{}');
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  performCheck({ transcript_path: transcript, cwd, session_id: 's1' }, { config });

  const [s] = host.collectCacheSessions({ config: DEFAULTS, root: paths.continuityRoot(), oauthCredentialsPath: paths.oauthCredentialsPath() });
  assert.strictEqual(s.ttlMinutes, 5);
});

test('the native host lives outside session-continuity, and the uninstaller removes the old folder too', (t) => {
  const { home } = sandbox(t);
  assert.ok(!path.resolve(host.hostDir()).startsWith(path.resolve(paths.continuityRoot()) + path.sep));

  const legacy = host.legacyHostDir();
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'guardian-host.cmd'), 'old');
  require('../../bin/uninstall').uninstallNativeHost({ platform: 'linux', execFn: () => {} });
  assert.strictEqual(fs.existsSync(legacy), false);
  assert.ok(home);
});
