const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { performCheck } = require('../../lib/threshold-check');
const paths = require('../../lib/paths');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function baseInput(cwd) {
  return {
    transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    cwd,
    session_id: 's1',
  };
}

test('performCheck throttles ccusage to once every planCheckIntervalToolCalls checks', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));

  let ccusageCalls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    ccusageCalls += 1;
    return JSON.stringify({ blocks: [{ endTime: 'reset', tokenLimitStatus: { percentUsed: 42 } }] });
  });

  const config = {
    plan: 'pro',
    planTokenLimit: null,
    planCheckIntervalToolCalls: 3,
    thresholds: { context: 0.995, plan: 0.995 },
  };
  const input = baseInput(cwd);

  performCheck(input, { config }); // no cache yet -> calls ccusage
  performCheck(input, { config }); // cached, under interval -> skip
  performCheck(input, { config }); // still under interval -> skip
  performCheck(input, { config }); // counter hits interval -> refresh

  assert.strictEqual(ccusageCalls, 2);

  const state = JSON.parse(fs.readFileSync(paths.statePath(cwd), 'utf8'));
  assert.strictEqual(state.planPct, 42);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});

test('performCheck does not touch ccusage at all when plan is "none"', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-threshold-'));
  process.env.CQG_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-project-'));

  let ccusageCalls = 0;
  t.mock.method(cp, 'execFileSync', () => {
    ccusageCalls += 1;
    return '{}';
  });

  const config = {
    plan: 'none',
    planTokenLimit: null,
    planCheckIntervalToolCalls: 3,
    thresholds: { context: 0.995, plan: 0.995 },
  };
  const input = baseInput(cwd);

  performCheck(input, { config });
  performCheck(input, { config });

  assert.strictEqual(ccusageCalls, 0);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CQG_HOME;
});
