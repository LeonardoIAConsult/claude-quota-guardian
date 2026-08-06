const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../../lib/paths');
const override = require('../../lib/override');

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-ovr-'));
  const prev = process.env.CQG_HOME;
  process.env.CQG_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.CQG_HOME; else process.env.CQG_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

const CWD = 'C:\\fake\\ovr';

test('override.isActive is false when no override file exists', (t) => {
  withHome(t);
  assert.strictEqual(override.isActive(CWD, 1000), false);
});

test('override.write makes isActive true within the window and false after expiry', (t) => {
  withHome(t);
  const payload = override.write(CWD, 1, 'test', 1000); // 1 minute grace from t=1000
  assert.strictEqual(payload.until, new Date(1000 + 60000).toISOString());
  assert.strictEqual(override.isActive(CWD, 30000), true);   // inside window
  assert.strictEqual(override.isActive(CWD, 61001), false);  // past until
});

test('override.write clamps non-positive minutes to at least 1', (t) => {
  withHome(t);
  override.write(CWD, 0, null, 1000);
  assert.strictEqual(override.isActive(CWD, 1000 + 59999), true);
});

test('override.clear removes an active override', (t) => {
  withHome(t);
  override.write(CWD, 30, 'test', 1000);
  assert.strictEqual(override.isActive(CWD, 2000), true);
  override.clear(CWD);
  assert.strictEqual(fs.existsSync(paths.overridePath(CWD)), false);
  assert.strictEqual(override.isActive(CWD, 2000), false);
});

test('override.isActive is false for a malformed override file', (t) => {
  const home = withHome(t);
  const file = paths.overridePath(CWD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(override.isActive(CWD, 2000), false);
  assert.ok(home);
});
