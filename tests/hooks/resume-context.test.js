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

function pendingWith(home, cwd, checkpointFile) {
  const pendingFile = pendingFileFor(home, cwd);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  atomicWriteFileSync(pendingFile, JSON.stringify({
    projectPath: cwd, sessionId: 's1', triggeredBy: 'plan', triggeredAt: new Date().toISOString(),
    checkpointFile, consumed: false,
  }));
  return pendingFile;
}

// A refused checkpoint is never injected, but the pending is still consumed
// (otherwise the project would stay hard-blocked) and only its path is shown.
function assertNotAutoLoaded(out, pendingFile, secretText) {
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes(secretText), 'content must not be injected');
  assert.match(ctx, /no se cargó automáticamente/);
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, true);
  assert.strictEqual(pending.consumedReason, 'checkpoint-not-auto-loaded');
}

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { home, cwd };
}

test('resume-context never injects a file outside its continuity dir, but consumes the pending', (t) => {
  const { home, cwd } = sandbox(t);
  const secret = path.join(home, 'secret.md');
  fs.writeFileSync(secret, 'TOP SECRET');
  const pendingFile = pendingWith(home, cwd, secret);

  assertNotAutoLoaded(runHook({ cwd, source: 'startup' }, { CQG_HOME: home }), pendingFile, 'TOP SECRET');
});

test('resume-context never injects a non-markdown file, even from its own dir', (t) => {
  const { home, cwd } = sandbox(t);
  const pendingFile = pendingFileFor(home, cwd);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  const notMd = path.join(path.dirname(pendingFile), 'notes.txt');
  fs.writeFileSync(notMd, 'TOP SECRET');
  pendingWith(home, cwd, notMd);

  assertNotAutoLoaded(runHook({ cwd, source: 'startup' }, { CQG_HOME: home }), pendingFile, 'TOP SECRET');
});

test('resume-context does not auto-load a CHECKPOINT.md from the repo itself', (t) => {
  const { home, cwd } = sandbox(t);
  const inRepo = path.join(cwd, 'CHECKPOINT.md');
  fs.writeFileSync(inRepo, 'REPO CONTROLLED TEXT');
  const pendingFile = pendingWith(home, cwd, inRepo);

  assertNotAutoLoaded(runHook({ cwd, source: 'startup' }, { CQG_HOME: home }), pendingFile, 'REPO CONTROLLED TEXT');
});

test('resume-context refuses a hard link in its continuity dir pointing at another file', (t) => {
  const { home, cwd } = sandbox(t);
  const secret = path.join(home, 'id_rsa');
  fs.writeFileSync(secret, 'PRIVATE KEY');
  const pendingFile = pendingFileFor(home, cwd);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  const link = path.join(path.dirname(pendingFile), 'checkpoint-x.md');
  fs.linkSync(secret, link);
  pendingWith(home, cwd, link);

  assertNotAutoLoaded(runHook({ cwd, source: 'startup' }, { CQG_HOME: home }), pendingFile, 'PRIVATE KEY');
});

test('resume-context refuses a linked dir in its continuity dir pointing outside', (t) => {
  const { home, cwd } = sandbox(t);
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'loot.md'), 'OUTSIDE FILE');
  const pendingFile = pendingFileFor(home, cwd);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  const linkDir = path.join(path.dirname(pendingFile), 'linkdir');
  try {
    fs.symlinkSync(outside, linkDir, 'junction'); // junctions need no privileges on Windows
  } catch {
    t.skip('cannot create a directory link here');
    return;
  }
  pendingWith(home, cwd, path.join(linkDir, 'loot.md'));

  assertNotAutoLoaded(runHook({ cwd, source: 'startup' }, { CQG_HOME: home }), pendingFile, 'OUTSIDE FILE');
});

test('resume-context consumes a pending whose checkpoint file no longer exists', (t) => {
  const { home, cwd } = sandbox(t);
  const pendingFile = pendingFileFor(home, cwd);
  const gone = path.join(path.dirname(pendingFile), 'checkpoint-gone.md');
  pendingWith(home, cwd, gone);

  runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  assert.strictEqual(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).consumed, true);
});


test('resume-context refuses a sibling dir that merely shares the continuity dir prefix', (t) => {
  const { home, cwd } = sandbox(t);
  const pendingFile = pendingFileFor(home, cwd);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  const sibling = `${path.dirname(pendingFile)}-evil`;
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'checkpoint.md'), 'SIBLING TEXT');
  pendingWith(home, cwd, path.join(sibling, 'checkpoint.md'));

  assertNotAutoLoaded(runHook({ cwd, source: 'startup' }, { CQG_HOME: home }), pendingFile, 'SIBLING TEXT');
});

test('resume-context shows the refused checkpoint path so the user can decide', (t) => {
  const { home, cwd } = sandbox(t);
  const inRepo = path.join(cwd, 'CHECKPOINT.md');
  fs.writeFileSync(inRepo, 'x');
  pendingWith(home, cwd, inRepo);

  const ctx = JSON.parse(runHook({ cwd, source: 'startup' }, { CQG_HOME: home })).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(JSON.stringify(inRepo)), 'the quoted path must be shown');
});
