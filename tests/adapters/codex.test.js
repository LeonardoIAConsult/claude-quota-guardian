const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findRecentRollouts, readSessionUsage, readCodexUsage } = require('../../lib/adapters/codex');

const NOW = new Date('2026-07-23T12:00:00.000Z');

function makeCodexHome({ dateDir = '2026/07/23' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-codex-'));
  const sessions = path.join(root, 'sessions', ...dateDir.split('/'));
  fs.mkdirSync(sessions, { recursive: true });
  return { root, sessions };
}

function rolloutLines({ cwd = 'C:\\proj\\demo', totalTokens = 200000, window = 258400, ratePct = null } = {}) {
  const meta = {
    timestamp: '2026-07-23T11:50:00.000Z',
    type: 'session_meta',
    payload: { session_id: 'sess-1', cwd, cli_version: '0.144.0', model_provider: 'openai' },
  };
  const rateLimits = ratePct === null ? null : { primary: { used_percent: ratePct, resets_in_seconds: 3600 }, secondary: null };
  const tokenCount = {
    timestamp: '2026-07-23T11:59:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: totalTokens * 3 },
        last_token_usage: { input_tokens: totalTokens - 500, output_tokens: 500, total_tokens: totalTokens },
        model_context_window: window,
      },
      rate_limits: rateLimits,
    },
  };
  return [JSON.stringify(meta), JSON.stringify(tokenCount)].join('\n') + '\n';
}

test('readSessionUsage extracts cwd, contextPct and rate limit from a rollout', () => {
  const { sessions, root } = makeCodexHome();
  const file = path.join(sessions, 'rollout-2026-07-23T11-50-00-abc.jsonl');
  fs.writeFileSync(file, rolloutLines({ totalTokens: 232560, window: 258400, ratePct: 55 }));

  const usage = readSessionUsage(file, NOW.getTime());
  assert.strictEqual(usage.projectPath, 'C:\\proj\\demo');
  assert.strictEqual(usage.projectName, 'demo');
  assert.strictEqual(usage.contextPct, 90);
  assert.strictEqual(usage.rateLimitPct, 55);
  assert.strictEqual(usage.maxPct, 90);
  assert.strictEqual(usage.sessionId, 'sess-1');

  fs.rmSync(root, { recursive: true, force: true });
});

test('readSessionUsage survives info:null token_count events (uses rate_limits only)', () => {
  const { sessions, root } = makeCodexHome();
  const file = path.join(sessions, 'rollout-x.jsonl');
  const meta = JSON.stringify({ type: 'session_meta', payload: { session_id: 's', cwd: 'C:\\p' } });
  const tc = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 97.5 } } } });
  fs.writeFileSync(file, meta + '\n' + tc + '\n');

  const usage = readSessionUsage(file, NOW.getTime());
  assert.strictEqual(usage.contextPct, null);
  assert.strictEqual(usage.rateLimitPct, 97.5);
  assert.strictEqual(usage.maxPct, 97.5);

  fs.rmSync(root, { recursive: true, force: true });
});

test('readSessionUsage returns null when no usage signal exists', () => {
  const { sessions, root } = makeCodexHome();
  const file = path.join(sessions, 'rollout-y.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:\\p' } }) + '\nnot json\n');

  assert.strictEqual(readSessionUsage(file, NOW.getTime()), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findRecentRollouts ignores stale files and non-rollout files', () => {
  const { sessions, root } = makeCodexHome();
  const fresh = path.join(sessions, 'rollout-fresh.jsonl');
  const stale = path.join(sessions, 'rollout-stale.jsonl');
  const other = path.join(sessions, 'notes.txt');
  for (const f of [fresh, stale, other]) fs.writeFileSync(f, 'x\n');

  const freshTime = new Date(NOW.getTime() - 5 * 60 * 1000);
  const staleTime = new Date(NOW.getTime() - 60 * 60 * 1000);
  fs.utimesSync(fresh, freshTime, freshTime);
  fs.utimesSync(stale, staleTime, staleTime);
  fs.utimesSync(other, freshTime, freshTime);

  const found = findRecentRollouts(root, { now: NOW });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].file, fresh);

  fs.rmSync(root, { recursive: true, force: true });
});

test('findRecentRollouts also walks yesterday\'s date dir', () => {
  const { sessions, root } = makeCodexHome({ dateDir: '2026/07/22' });
  const file = path.join(sessions, 'rollout-late-night.jsonl');
  fs.writeFileSync(file, 'x\n');
  const t = new Date(NOW.getTime() - 10 * 60 * 1000);
  fs.utimesSync(file, t, t);

  const found = findRecentRollouts(root, { now: NOW });
  assert.strictEqual(found.length, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test('readCodexUsage returns one entry per fresh session and none for a missing root', () => {
  const { sessions, root } = makeCodexHome();
  const file = path.join(sessions, 'rollout-a.jsonl');
  fs.writeFileSync(file, rolloutLines({ totalTokens: 129200 }));
  const t = new Date(NOW.getTime() - 60 * 1000);
  fs.utimesSync(file, t, t);

  const usages = readCodexUsage({ root, now: NOW });
  assert.strictEqual(usages.length, 1);
  assert.strictEqual(usages[0].contextPct, 50);
  assert.strictEqual(usages[0].updatedAt, t.toISOString());

  assert.deepStrictEqual(readCodexUsage({ root: path.join(root, 'nope'), now: NOW }), []);

  fs.rmSync(root, { recursive: true, force: true });
});
