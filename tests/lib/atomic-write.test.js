const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFileSync } = require('../../lib/atomic-write');

test('atomicWriteFileSync writes file and leaves no tmp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-'));
  const target = path.join(dir, 'sub', 'file.json');

  atomicWriteFileSync(target, '{"a":1}');

  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":1}');
  const leftovers = fs.readdirSync(path.join(dir, 'sub')).filter((f) => f.includes('.tmp'));
  assert.strictEqual(leftovers.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteFileSync overwrites existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-'));
  const target = path.join(dir, 'file.json');
  fs.writeFileSync(target, 'old');

  atomicWriteFileSync(target, 'new');

  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
  fs.rmSync(dir, { recursive: true, force: true });
});
