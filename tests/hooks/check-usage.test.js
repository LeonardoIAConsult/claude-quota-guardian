const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'check-usage.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

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

test('check-usage no-ops below threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage writes pending.json and blocks at threshold', () => {
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

  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /continuity-checkpoint/);

  const pending = JSON.parse(fs.readFileSync(pendingFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'context');
  assert.strictEqual(pending.checkpointFile, null);
  assert.ok(pending.pctAtTrigger.context >= 99.5);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage is idempotent when pending already exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const pendingFile = pendingFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ consumed: false }));

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage exits 0 with bad stdin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
