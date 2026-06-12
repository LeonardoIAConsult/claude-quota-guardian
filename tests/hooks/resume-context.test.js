const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');
const { atomicWriteFileSync } = require('../../lib/atomic-write');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'resume-context.js');

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

test('resume-context no-ops when nothing pending', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook({ cwd: 'C:\\fake\\project', source: 'startup' }, { CQG_HOME: home });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('resume-context injects checkpoint and marks consumed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = 'C:\\fake\\project';
  const pendingFile = pendingFileFor(home, cwd);
  const checkpointFile = path.join(path.dirname(pendingFile), 'checkpoint-test.md');

  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(checkpointFile, '# Checkpoint\n\n## Exact Next Step\nRun the failing test for X.\n');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    projectPath: cwd,
    projectName: 'project',
    sessionId: 's1',
    triggeredBy: 'context',
    pctAtTrigger: { context: 99.6, plan: null },
    triggeredAt: new Date().toISOString(),
    checkpointFile,
    consumed: false,
    consumedAt: null,
    planResetAtSeen: null,
  }, null, 2));

  const out = runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  const result = JSON.parse(out);
  const ctx = result.hookSpecificOutput.additionalContext;

  assert.match(ctx, /Exact Next Step/);
  assert.match(ctx, /MODO RETOMAR/);

  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, true);
  assert.ok(pending.consumedAt);

  fs.rmSync(home, { recursive: true, force: true });
});

test('resume-context is a no-op on second call (already consumed)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = 'C:\\fake\\project';
  const pendingFile = pendingFileFor(home, cwd);
  const checkpointFile = path.join(path.dirname(pendingFile), 'checkpoint-test.md');

  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(checkpointFile, '# Checkpoint\n');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    checkpointFile,
    consumed: true,
    consumedAt: new Date().toISOString(),
    triggeredAt: new Date().toISOString(),
  }, null, 2));

  const out = runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  assert.strictEqual(out.trim(), '');

  fs.rmSync(home, { recursive: true, force: true });
});

test('resume-context warns when checkpoint is older than 7 days', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = 'C:\\fake\\project';
  const pendingFile = pendingFileFor(home, cwd);
  const checkpointFile = path.join(path.dirname(pendingFile), 'checkpoint-test.md');
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(checkpointFile, '# Checkpoint\n\n## Exact Next Step\nDo X.\n');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    checkpointFile,
    consumed: false,
    consumedAt: null,
    triggeredAt: oldDate,
  }, null, 2));

  const out = runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  const result = JSON.parse(out);
  assert.match(result.hookSpecificOutput.additionalContext, /ADVERTENCIA/);
  assert.match(result.hookSpecificOutput.additionalContext, /8 días/);

  fs.rmSync(home, { recursive: true, force: true });
});
