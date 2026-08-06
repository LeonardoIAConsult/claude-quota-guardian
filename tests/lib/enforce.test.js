const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../../lib/paths');
const override = require('../../lib/override');
const { enforceDecision } = require('../../lib/enforce');

const CWD = 'C:\\fake\\enf';

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-enf-'));
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME; else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function seedPending(consumed) {
  const file = paths.pendingPath(CWD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ consumed, checkpointFile: null }));
}

test('enforceDecision blocks a non-allowlisted tool while a pending checkpoint is unconsumed', (t) => {
  withHome(t);
  seedPending(false);
  const d = enforceDecision({ cwd: CWD, tool_name: 'Read' });
  assert.ok(d && d.decision === 'block');
  assert.match(d.reason, /continuity-checkpoint/);
  assert.match(d.reason, /guardian-continue/); // escape hatch is advertised
});

test('enforceDecision allows Bash and Write (the checkpoint flow needs them)', (t) => {
  withHome(t);
  seedPending(false);
  assert.strictEqual(enforceDecision({ cwd: CWD, tool_name: 'Bash' }), null);
  assert.strictEqual(enforceDecision({ cwd: CWD, tool_name: 'Write' }), null);
});

test('enforceDecision allows everything when there is no pending checkpoint', (t) => {
  withHome(t);
  assert.strictEqual(enforceDecision({ cwd: CWD, tool_name: 'Read' }), null);
});

test('enforceDecision allows everything once the pending is consumed', (t) => {
  withHome(t);
  seedPending(true);
  assert.strictEqual(enforceDecision({ cwd: CWD, tool_name: 'Read' }), null);
});

test('enforceDecision stands down while an override is active, even with an unconsumed pending', (t) => {
  withHome(t);
  seedPending(false);
  override.write(CWD, 30, 'test', 1000);
  assert.strictEqual(enforceDecision({ cwd: CWD, tool_name: 'Read' }, { now: 2000 }), null);
  // ...and blocks again once the override has expired
  assert.ok(enforceDecision({ cwd: CWD, tool_name: 'Read' }, { now: 1000 + 31 * 60000 }));
});

test('enforceDecision ignores malformed input', (t) => {
  withHome(t);
  assert.strictEqual(enforceDecision(null), null);
  assert.strictEqual(enforceDecision({ cwd: CWD }), null); // no tool_name
});
