const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../../lib/paths');
const { loadConfig, DEFAULTS } = require('../../lib/config');

test('loadConfig returns defaults when no config file exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-cfg-'));
  const fake = path.join(dir, 'config.json');
  t.mock.method(paths, 'configPath', () => fake);

  assert.deepStrictEqual(loadConfig(), DEFAULTS);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig merges on-disk overrides with defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-cfg-'));
  const fake = path.join(dir, 'config.json');
  fs.writeFileSync(fake, JSON.stringify({ plan: 'pro', thresholds: { context: 0.9 } }));
  t.mock.method(paths, 'configPath', () => fake);

  const cfg = loadConfig();
  assert.strictEqual(cfg.plan, 'pro');
  assert.strictEqual(cfg.thresholds.context, 0.9);
  assert.strictEqual(cfg.thresholds.plan, DEFAULTS.thresholds.plan);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig ignores corrupt config file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-cfg-'));
  const fake = path.join(dir, 'config.json');
  fs.writeFileSync(fake, '{not valid json');
  t.mock.method(paths, 'configPath', () => fake);

  assert.deepStrictEqual(loadConfig(), DEFAULTS);

  fs.rmSync(dir, { recursive: true, force: true });
});
