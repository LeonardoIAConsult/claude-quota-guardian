const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'statusline.js');

function stateFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'state.json');
}

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('statusline caches the higher of five_hour/seven_day used_percentage into state.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));

  runHook(
    {
      cwd: 'C:\\fake\\project',
      model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 71.2, resets_at: 1738857600 },
      },
    },
    { CQG_HOME: home }
  );

  const state = JSON.parse(fs.readFileSync(stateFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(state.rateLimitPct, 71.2);
  assert.strictEqual(state.rateLimitResetAt, new Date(1738857600 * 1000).toISOString());

  fs.rmSync(home, { recursive: true, force: true });
});

test('statusline prints model and rate-limit summary to stdout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));

  const out = runHook(
    {
      cwd: 'C:\\fake\\project',
      model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' },
      context_window: { used_percentage: 42 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 71.2, resets_at: 1738857600 },
      },
    },
    { CQG_HOME: home }
  );

  assert.match(out, /Sonnet/);
  assert.match(out, /42%/);
  assert.match(out, /24%|23%/); // Math.round(23.5)
  assert.match(out, /71%/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('statusline preserves existing state.json fields written by other hooks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const statePath = stateFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ maxPct: 50, entrypoint: 'cli', sessionId: 's1' }));

  runHook(
    {
      cwd: 'C:\\fake\\project',
      model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' },
      rate_limits: { five_hour: { used_percentage: 60, resets_at: 1738425600 } },
    },
    { CQG_HOME: home }
  );

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(state.maxPct, 50);
  assert.strictEqual(state.entrypoint, 'cli');
  assert.strictEqual(state.sessionId, 's1');
  assert.strictEqual(state.rateLimitPct, 60);

  fs.rmSync(home, { recursive: true, force: true });
});

test('statusline no-ops the cache when rate_limits is absent (e.g. not a Pro/Max subscriber yet)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));

  const out = runHook(
    { cwd: 'C:\\fake\\project', model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' } },
    { CQG_HOME: home }
  );

  assert.strictEqual(fs.existsSync(stateFileFor(home, 'C:\\fake\\project')), false);
  assert.match(out, /Sonnet/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('statusline exits cleanly with bad stdin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
