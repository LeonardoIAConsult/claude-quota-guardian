const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'enforce-checkpoint.js');

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

function writePending(home, cwd, overrides = {}) {
  const file = pendingFileFor(home, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consumed: false, ...overrides }));
}

test('enforce-checkpoint allows tool calls when no pending checkpoint exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook(
    { cwd: 'C:\\fake\\project', tool_name: 'Read' },
    { CQG_HOME: home }
  );
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('enforce-checkpoint blocks non-allowlisted tools while a pending checkpoint is unconsumed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  writePending(home, 'C:\\fake\\project');

  const out = runHook(
    { cwd: 'C:\\fake\\project', tool_name: 'Edit' },
    { CQG_HOME: home }
  );

  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /continuity-checkpoint/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('enforce-checkpoint still allows Bash and Write so /continuity-checkpoint can run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  writePending(home, 'C:\\fake\\project');

  for (const tool_name of ['Bash', 'Write']) {
    const out = runHook({ cwd: 'C:\\fake\\project', tool_name }, { CQG_HOME: home });
    assert.strictEqual(out.trim(), '', `expected ${tool_name} to be allowed`);
  }

  fs.rmSync(home, { recursive: true, force: true });
});

test('enforce-checkpoint allows tools again once the pending checkpoint is consumed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  writePending(home, 'C:\\fake\\project', { consumed: true });

  const out = runHook({ cwd: 'C:\\fake\\project', tool_name: 'Edit' }, { CQG_HOME: home });
  assert.strictEqual(out.trim(), '');

  fs.rmSync(home, { recursive: true, force: true });
});

test('enforce-checkpoint exits 0 with bad stdin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
