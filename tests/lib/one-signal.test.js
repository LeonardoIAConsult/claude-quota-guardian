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
  const prevState = { subscriptionFrom: 'rate_limits', subscriptionSessionId: 's1' };
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
  assert.strictEqual(state.subscriptionSessionId, 's1');

  // a new session in the same folder starts from scratch (no login here -> API ttl)
  performCheck({ transcript_path: transcript, cwd, session_id: 's2' }, { config });
  assert.strictEqual(JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8')).subscription, false);
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
