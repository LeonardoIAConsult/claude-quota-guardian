const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { spawnSync } = cp;
const paths = require('../../lib/paths');
const sessions = require('../../lib/cache-sessions');
const host = require('../../lib/native-host');
const { DEFAULTS } = require('../../lib/config');
const { performCheck } = require('../../lib/threshold-check');

const HOOKS = path.join(__dirname, '..', '..', 'hooks');
const NO_CREDS = path.join(os.tmpdir(), 'cqg-no-credentials-xyz.json');
const MIN = 60000;
const NOW = Date.parse('2026-10-22T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-sessions-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-sessions-cwd-'));
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME;
    else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { home, cwd, root: paths.continuityRoot() };
}

// Runs a hook the way Claude Code does: JSON on stdin.
function runHook(name, input, home) {
  return spawnSync('node', [path.join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
}

function readState(cwd) {
  return JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
}

function listed(root, now, config = DEFAULTS) {
  return host.collectCacheSessions({ config, now, root, oauthCredentialsPath: NO_CREDS });
}

function writeFolderState(root, dir, state) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'state.json'), JSON.stringify(state));
}

test('withSessionEntry keeps the other sessions entries and merges only its own', () => {
  const state = { cacheSessions: { a: { lastActivityAt: iso(NOW - MIN), projectName: 'a' } } };
  const map = sessions.withSessionEntry(state, 'b', { lastActivityAt: iso(NOW), projectName: 'b' }, NOW);
  assert.deepStrictEqual(Object.keys(map).sort(), ['a', 'b']);
  assert.strictEqual(map.a.projectName, 'a');
});

test('withSessionEntry caps the map at 8 (the most recent) and drops entries older than 24 h', () => {
  const state = { cacheSessions: {} };
  for (let i = 0; i < 10; i += 1) state.cacheSessions[`s${i}`] = { lastActivityAt: iso(NOW - (i + 1) * MIN) };
  state.cacheSessions.old = { lastActivityAt: iso(NOW - 25 * 60 * MIN) };
  const map = sessions.withSessionEntry(state, 'new', { lastActivityAt: iso(NOW) }, NOW);
  const ids = Object.keys(map);
  assert.strictEqual(ids.length, sessions.MAX_CACHE_SESSIONS);
  assert.ok(ids.includes('new') && ids.includes('s0') && !ids.includes('s9') && !ids.includes('old'));
});

test('withSessionEntry turns the top-level fields of a pre-map state into an entry instead of erasing that session', () => {
  const state = { sessionId: 'a', transcriptPath: 'a.jsonl', projectName: 'a', lastActivityAt: iso(NOW - MIN), subscription: true };
  const map = sessions.withSessionEntry(state, 'b', { lastActivityAt: iso(NOW) }, NOW);
  assert.strictEqual(map.a.lastActivityAt, iso(NOW - MIN));
  assert.strictEqual(map.a.subscription, true);
});

test('hooks create the state of a fresh folder; the hook that writes last keeps the other entries', (t) => {
  const { home, cwd } = sandbox(t);
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  runHook('prompt-submit.js', { session_id: 'b', cwd, transcript_path: 'b.jsonl' }, home);
  const state = readState(cwd);
  assert.deepStrictEqual(Object.keys(state.cacheSessions).sort(), ['a', 'b']);
  assert.strictEqual(state.cacheSessions.a.transcriptPath, 'a.jsonl');
  assert.strictEqual(state.cacheSessions.a.projectName, path.basename(cwd));
});

test('performCheck re-reads state.json before writing: an entry another session adds DURING the check survives', (t) => {
  const { cwd } = sandbox(t);
  const config = { plan: 'pro', planTokenLimit: null, planCheckIntervalToolCalls: 3, thresholds: { context: 0.995, plan: 0.995 } };
  performCheck({ transcript_path: 'a.jsonl', cwd, session_id: 'a' }, { config });
  // the slow part of a check (ccusage) is where another session's hook gets its write in
  t.mock.method(cp, 'execFileSync', () => {
    const state = readState(cwd);
    state.cacheSessions.b = { lastActivityAt: iso(Date.now()), transcriptPath: 'b.jsonl' };
    fs.writeFileSync(paths.statePath(cwd), JSON.stringify(state));
    return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 42 } }] });
  });
  performCheck({ transcript_path: 'a.jsonl', cwd, session_id: 'a' }, { config });
  assert.deepStrictEqual(Object.keys(readState(cwd).cacheSessions).sort(), ['a', 'b']);
});

test('prompt-submit and session-end never block or print, and exit 0 with garbage, no session id or an unwritable state', (t) => {
  const { home, cwd } = sandbox(t);
  for (const hook of ['prompt-submit.js', 'session-end.js']) {
    const ok = runHook(hook, { session_id: 'a', cwd, transcript_path: 't.jsonl' }, home);
    assert.strictEqual(ok.status, 0, hook);
    assert.strictEqual(ok.stdout, '', hook);
    const garbage = spawnSync('node', [path.join(HOOKS, hook)], { input: 'not json', encoding: 'utf8', env: { ...process.env, CQG_HOME: home } });
    assert.strictEqual(garbage.status, 0, hook);
    assert.strictEqual(garbage.stdout, '', hook);
    assert.strictEqual(runHook(hook, { cwd }, home).status, 0, `${hook} without a session id`);
  }
  // a state.json that is a folder cannot be written: the error goes to the log, the exit stays 0
  fs.rmSync(paths.projectDir(cwd), { recursive: true, force: true });
  fs.mkdirSync(paths.statePath(cwd), { recursive: true });
  const failed = runHook('session-end.js', { session_id: 'a', cwd, transcript_path: 't.jsonl' }, home);
  assert.strictEqual(failed.status, 0);
  assert.match(fs.readFileSync(paths.logPath(), 'utf8'), /\[session-end\].*ERROR/);
});

test('a stamp is one small read and one atomic write: far under the 1.5 s SessionEnd budget', (t) => {
  const { cwd } = sandbox(t);
  const input = { session_id: 'a', cwd, transcript_path: 't.jsonl' };
  sessions.stampSession(input, { lastActivityAt: iso(Date.now()) }); // warm up
  let best = Infinity;
  for (let i = 0; i < 5; i += 1) {
    const start = process.hrtime.bigint();
    sessions.stampSession(input, { endedAt: iso(Date.now()) });
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  assert.ok(best < 200, `a stamp took ${best} ms`);
});

// ---- the host reading the maps ----

test('two sessions in one folder are two rows; when one ends (SessionEnd) there is one', (t) => {
  const { home, cwd, root } = sandbox(t);
  const now = Date.now();
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  runHook('prompt-submit.js', { session_id: 'b', cwd, transcript_path: 'b.jsonl' }, home);
  assert.strictEqual(listed(root, now + MIN).length, 2);

  runHook('session-end.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl', reason: 'other' }, home);
  assert.strictEqual(listed(root, now + MIN).length, 1);
  assert.ok(readState(cwd).cacheSessions.a.endedAt);
});

test('a session that sends a message after SessionEnd (same id, resumed) is listed again', (t) => {
  const { home, cwd, root } = sandbox(t);
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  runHook('session-end.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  assert.strictEqual(listed(root, Date.now() + MIN).length, 0);
  const state = readState(cwd);
  state.cacheSessions.a.endedAt = iso(Date.now() - 5000); // it ended before the new message
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify(state));
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  assert.strictEqual(listed(root, Date.now() + MIN).length, 1);
});

test('a transcript touched after the Stop hook adds no minutes: the hook time counts', (t) => {
  const { home, cwd, root } = sandbox(t);
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const config = { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } };
  const t0 = Date.now() - 30 * MIN; // the last real request, 30 min ago
  const realNow = Date.now;
  Date.now = () => t0;
  try {
    performCheck({ transcript_path: transcript, cwd, session_id: 'a' }, { config });
  } finally {
    Date.now = realNow;
  }
  // a summary or a reopened session rewrites the transcript just now
  const touched = new Date();
  fs.utimesSync(transcript, touched, touched);
  const [row] = listed(root, Date.now(), { cache: { ttlMinutes: 60, warnMinutes: 5 } });
  assert.strictEqual(row.lastActivityAt, iso(t0));
  assert.ok(row.minutesLeft <= 30, `minutesLeft ${row.minutesLeft} must count from the hook, not the mtime`);
});

test('the host dedupes one session across folders (latest activity wins) and keeps legacy states without a map', (t) => {
  const { root } = sandbox(t);
  writeFolderState(root, 'aaa', { sessionId: 's1', updatedAt: iso(NOW - 9 * MIN), cacheSessions: { s1: { projectName: 'old-folder', lastActivityAt: iso(NOW - 9 * MIN) } } });
  writeFolderState(root, 'bbb', { sessionId: 's1', updatedAt: iso(NOW - 2 * MIN), cacheSessions: { s1: { projectName: 'new-folder', lastActivityAt: iso(NOW - 2 * MIN) } } });
  writeFolderState(root, 'ccc', { sessionId: 'legacy', projectName: 'legacy', lastActivityAt: iso(NOW - 3 * MIN) });
  const rows = listed(root, NOW, { cache: { ttlMinutes: 60, warnMinutes: 5 } });
  assert.deepStrictEqual(rows.map((r) => r.project), ['new-folder', 'legacy']);
  // the reply keeps the shape the extension reads
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['expired', 'lastActivityAt', 'minutesLeft', 'project', 'ttlMinutes', 'warn']);
});

test('SessionEnd written in the folder a session moved to hides it from the folder it started in', (t) => {
  const { root } = sandbox(t);
  writeFolderState(root, 'aaa', { sessionId: 's1', cacheSessions: { s1: { projectName: 'p', lastActivityAt: iso(NOW - 5 * MIN) } } });
  writeFolderState(root, 'bbb', { sessionId: 'x', cacheSessions: { s1: { projectName: 'p', endedAt: iso(NOW - MIN) } } });
  assert.strictEqual(listed(root, NOW, { cache: { ttlMinutes: 60, warnMinutes: 5 } }).length, 0);
});

test('the transcript path is never returned', (t) => {
  const { home, cwd, root } = sandbox(t);
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: path.join(home, 'secret-name.jsonl') }, home);
  const rows = listed(root, Date.now() + MIN);
  assert.strictEqual(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('secret-name'));
});

test('withSessionEntry drops another session entry older than 24 h even under the cap', () => {
  const state = { cacheSessions: {
    old: { lastActivityAt: iso(NOW - 25 * 60 * MIN) },
    recent: { lastActivityAt: iso(NOW - 60 * MIN) },
  } };
  const map = sessions.withSessionEntry(state, 'me', { lastActivityAt: iso(NOW) }, NOW);
  assert.deepStrictEqual(Object.keys(map).sort(), ['me', 'recent']);
});

test('a stamp by the session that owns the state also moves the top level, so status line, bar and host agree', (t) => {
  const { home, cwd } = sandbox(t);
  fs.mkdirSync(path.dirname(paths.statePath(cwd)), { recursive: true });
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ sessionId: 's1', lastActivityAt: iso(NOW - 40 * MIN) }));
  const r = runHook('prompt-submit.js', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, transcript_path: null }, home);
  assert.strictEqual(r.status, 0);
  const state = readState(cwd);
  assert.ok(Date.parse(state.lastActivityAt) > NOW - 40 * MIN, 'top level not stamped');
  assert.strictEqual(state.lastActivityAt, state.cacheSessions.s1.lastActivityAt);
});

test('an end marker written where the session never stamped activity does not bring it back by mtime', (t) => {
  const { root } = sandbox(t);
  const transcript = path.join(root, 't.jsonl');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(transcript, '{}\n');
  const now = Date.now();
  fs.utimesSync(transcript, new Date(now), new Date(now));
  writeFolderState(root, 'aaa', { cacheSessions: { s1: { transcriptPath: transcript, projectName: 'p', lastActivityAt: iso(now - 5 * MIN), subscription: true } } });
  writeFolderState(root, 'bbb', { cacheSessions: { s1: { transcriptPath: transcript, projectName: 'p', endedAt: iso(now - MIN) } } });
  assert.deepStrictEqual(listed(root, now), []);
});
