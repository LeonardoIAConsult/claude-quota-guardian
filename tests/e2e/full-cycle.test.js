const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');
const { atomicWriteFileSync } = require('../../lib/atomic-write');

const ROOT = path.join(__dirname, '..', '..');
const CHECK_HOOK = path.join(ROOT, 'hooks', 'check-usage.js');
const RESUME_HOOK = path.join(ROOT, 'hooks', 'resume-context.js');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

function run(hook, input, env) {
  return execFileSync('node', [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('full cycle: trigger -> checkpoint -> resume -> idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-e2e-'));
  const cwd = 'C:\\fake\\my-project';
  const env = { CQG_HOME: home };

  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none', blockOnContext: true })
  );

  // 1. Threshold hit -> PostToolUse hook blocks and writes pending.json
  const checkOut = run(CHECK_HOOK, {
    transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    cwd,
    session_id: 's1',
  }, env);
  assert.strictEqual(JSON.parse(checkOut).decision, 'block');

  const projectDir = path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd));
  const pendingFile = path.join(projectDir, 'pending.json');
  let pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'context');

  // 2. Simulate /continuity-checkpoint: write checkpoint + update pending
  const checkpointFile = path.join(projectDir, 'checkpoint-test.md');
  fs.writeFileSync(checkpointFile, '# Checkpoint\n\n## Exact Next Step\nRun the failing test for X.\n');
  pending.checkpointFile = checkpointFile;
  atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));

  // 3. Reopen: SessionStart hook resumes
  const resumeOut = run(RESUME_HOOK, { cwd, source: 'startup' }, env);
  const ctx = JSON.parse(resumeOut).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Exact Next Step/);
  assert.match(ctx, /MODO RETOMAR/);

  pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, true);

  // 4. Second resume is a no-op
  const resumeOut2 = run(RESUME_HOOK, { cwd, source: 'startup' }, env);
  assert.strictEqual(resumeOut2.trim(), '');

  fs.rmSync(home, { recursive: true, force: true });
});
