const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('../../lib/paths');
const host = require('../../lib/native-host');

// Code-review round on the per-session cache state: the status line's write,
// the transcript stat as a fallback only, SessionStart on a reopened session,
// and one row per transcript.

const HOOKS = path.join(__dirname, '..', '..', 'hooks');
const NO_CREDS = path.join(os.tmpdir(), 'cqg-no-credentials-xyz.json');
const CONFIG = { cache: { ttlMinutes: 60, warnMinutes: 5 } };
const MIN = 60000;
const NOW = Date.parse('2026-10-22T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-review-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-review-cwd-'));
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

function runHook(name, input, home, nodeArgs = []) {
  return spawnSync('node', [...nodeArgs, path.join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
}

// The status line with a preload script (node --require) hooking `fs` inside
// the hook's own process.
function runStatusLine(input, home, preloadSource) {
  const preload = path.join(home, 'preload.js');
  fs.writeFileSync(preload, preloadSource);
  return runHook('statusline.js', input, home, ['--require', preload]);
}

function readState(cwd) {
  return JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
}

function listed(root, now, config = CONFIG) {
  return host.collectCacheSessions({ config, now, root, oauthCredentialsPath: NO_CREDS });
}

function writeFolderState(root, dir, state) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'state.json'), JSON.stringify(state));
}

test('the status line re-reads state.json before it writes: an entry another session added after its first read survives', (t) => {
  const { home, cwd } = sandbox(t);
  fs.mkdirSync(paths.projectDir(cwd), { recursive: true });
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ sessionId: 'a', cacheSessions: { a: { lastActivityAt: iso(NOW) } } }));
  // right after the status line's startup read, another session's hook writes its entry
  const r = runStatusLine({
    cwd,
    session_id: 'a',
    rate_limits: { five_hour: { used_percentage: 20, resets_at: 1738425600 } },
  }, home, `
    const fs = require('fs');
    const read = fs.readFileSync;
    let done = false;
    fs.readFileSync = function (p, ...rest) {
      const out = read.call(this, p, ...rest);
      if (!done && typeof p === 'string' && p.endsWith('state.json')) {
        done = true;
        const s = JSON.parse(out);
        s.cacheSessions.b = { lastActivityAt: 'B-FRESH', endedAt: 'B-ENDED' };
        fs.writeFileSync(p, JSON.stringify(s));
      }
      return out;
    };
  `);
  assert.strictEqual(r.status, 0);
  const state = readState(cwd);
  assert.strictEqual(state.cacheSessions.b.endedAt, 'B-ENDED');
  assert.ok(state.cacheSessions.a);
  assert.strictEqual(state.rateLimitPct, 20);
});

test('the host stats a transcript only when no activity time is stored', (t) => {
  const { home, root } = sandbox(t);
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  writeFolderState(root, 'aaa', { sessionId: 's1', cacheSessions: { s1: { transcriptPath: transcript, projectName: 'p', lastActivityAt: iso(Date.now() - MIN) } } });
  writeFolderState(root, 'bbb', { sessionId: 's2', cacheSessions: { s2: { transcriptPath: `${transcript}.2`, projectName: 'q' } } });

  const stats = [];
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (p, ...rest) => {
    stats.push(String(p));
    return realStat.call(fs, p, ...rest);
  });
  listed(root, Date.now());
  assert.ok(!stats.includes(transcript), 'a stored time: its transcript is not stat\'ed');
  assert.ok(stats.includes(`${transcript}.2`), 'nothing stored: the fallback stats the transcript');
});

test('the status line stats the transcript only when no activity time is stored', (t) => {
  const { home, cwd } = sandbox(t);
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const log = path.join(home, 'stats.log');
  const preload = `
    const fs = require('fs');
    const stat = fs.statSync;
    fs.statSync = function (p, ...rest) {
      if (String(p).endsWith('transcript.jsonl')) fs.appendFileSync(${JSON.stringify(log)}, 'stat');
      return stat.call(this, p, ...rest);
    };
  `;
  fs.mkdirSync(paths.projectDir(cwd), { recursive: true });
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ sessionId: 's1', subscription: true, lastActivityAt: iso(Date.now() - MIN) }));
  const out = runStatusLine({ cwd, session_id: 's1', transcript_path: transcript }, home, preload);
  assert.match(out.stdout, /cache 59m/);
  assert.ok(!fs.existsSync(log), 'a time was stored: no stat');

  fs.writeFileSync(paths.statePath(cwd), JSON.stringify({ sessionId: 's1', subscription: true }));
  runStatusLine({ cwd, session_id: 's1', transcript_path: transcript }, home, preload);
  assert.ok(fs.existsSync(log), 'nothing stored: the mtime fallback stats the transcript');
});

test('SessionStart on a reopened session clears endedAt: its live cache is listed again, with no activity stamped', (t) => {
  const { home, cwd, root } = sandbox(t);
  const last = iso(Date.now() - 10 * MIN);
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  const state = readState(cwd);
  state.cacheSessions.a.lastActivityAt = last;
  fs.writeFileSync(paths.statePath(cwd), JSON.stringify(state));
  runHook('session-end.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl', reason: 'other' }, home);
  assert.strictEqual(listed(root, Date.now()).length, 0);

  const r = runHook('resume-context.js', { session_id: 'a', cwd, source: 'resume' }, home);
  assert.strictEqual(r.status, 0);
  const after = readState(cwd).cacheSessions.a;
  assert.strictEqual(after.endedAt, undefined);
  assert.strictEqual(after.lastActivityAt, last, 'SessionStart stamps no activity');
  assert.strictEqual(listed(root, Date.now()).length, 1);
});

test('SessionStart creates no state for a session it has never seen and leaves other sessions\' marks alone', (t) => {
  const { home, cwd } = sandbox(t);
  runHook('resume-context.js', { session_id: 'new', cwd, source: 'startup' }, home);
  assert.strictEqual(fs.existsSync(paths.statePath(cwd)), false);
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  runHook('session-end.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  runHook('resume-context.js', { session_id: 'b', cwd, source: 'startup' }, home);
  assert.ok(readState(cwd).cacheSessions.a.endedAt, 'a is still ended');
});

test('SessionStart still consumes the pending checkpoint after clearing endedAt', (t) => {
  const { home, cwd } = sandbox(t);
  runHook('prompt-submit.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  runHook('session-end.js', { session_id: 'a', cwd, transcript_path: 'a.jsonl' }, home);
  const checkpoint = path.join(paths.projectDir(cwd), 'checkpoint-1.md');
  fs.writeFileSync(checkpoint, '# saved work');
  fs.writeFileSync(paths.pendingPath(cwd), JSON.stringify({ consumed: false, checkpointFile: checkpoint, triggeredAt: new Date().toISOString() }));
  const r = runHook('resume-context.js', { session_id: 'a', cwd, source: 'resume' }, home);
  assert.match(r.stdout, /saved work/);
  assert.strictEqual(JSON.parse(fs.readFileSync(paths.pendingPath(cwd), 'utf8')).consumed, true);
  assert.strictEqual(readState(cwd).cacheSessions.a.endedAt, undefined);
});

test('two session ids on one transcript are one row, the one used last', (t) => {
  const { root } = sandbox(t);
  writeFolderState(root, 'aaa', { sessionId: 's1', cacheSessions: { s1: { transcriptPath: 'same.jsonl', projectName: 'p', lastActivityAt: iso(NOW - 9 * MIN) } } });
  writeFolderState(root, 'bbb', { sessionId: 's2', cacheSessions: { s2: { transcriptPath: 'same.jsonl', projectName: 'p', lastActivityAt: iso(NOW - 2 * MIN) } } });
  writeFolderState(root, 'ccc', { sessionId: 's3', cacheSessions: { s3: { transcriptPath: 'other.jsonl', projectName: 'q', lastActivityAt: iso(NOW - 3 * MIN) } } });
  const rows = listed(root, NOW);
  assert.deepStrictEqual(rows.map((r) => r.lastActivityAt), [iso(NOW - 2 * MIN), iso(NOW - 3 * MIN)]);
});
