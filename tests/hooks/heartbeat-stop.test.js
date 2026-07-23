const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'heartbeat-stop.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

function stateFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'state.json');
}

function pendingFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'pending.json');
}

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('heartbeat-stop writes a heartbeat below threshold and emits no decision', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  assert.strictEqual(out.trim(), '');
  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.ok(state.maxPct > 0 && state.maxPct < 90);

  fs.rmSync(home, { recursive: true, force: true });
});

test('heartbeat-stop creates a pending checkpoint at threshold but never emits decision:block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  // Stop's `decision: block` means "prevent the agent from stopping" -- the
  // opposite of what we want at high usage -- so this hook must stay silent
  // on stdout even when it creates a pending checkpoint.
  assert.strictEqual(out.trim(), '');

  const pending = JSON.parse(fs.readFileSync(pendingFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(pending.consumed, false);

  fs.rmSync(home, { recursive: true, force: true });
});

test('heartbeat-stop never pends for a non-CLI surface, even above the hard-block threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-7pct-desktop.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  assert.strictEqual(out.trim(), '');
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);

  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(state.entrypoint, 'claude-desktop');
  assert.ok(state.maxPct >= 99.5); // heartbeat still flows for the watcher

  fs.rmSync(home, { recursive: true, force: true });
});

test('heartbeat-stop creates a pending checkpoint from a cached rate_limit signal alone, even with low local context', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  const statePath = stateFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ rateLimitPct: 99.8, rateLimitResetAt: '2026-06-20T00:00:00.000Z' }));

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  assert.strictEqual(out.trim(), '');

  const pending = JSON.parse(fs.readFileSync(pendingFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'plan');

  fs.rmSync(home, { recursive: true, force: true });
});

test('heartbeat-stop exits 0 with bad stdin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
