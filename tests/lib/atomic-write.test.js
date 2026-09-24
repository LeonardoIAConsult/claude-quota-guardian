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

test('atomicWriteFileSync never writes through a symlink planted at the tmp name', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'original');
  const target = path.join(dir, 'file.json');
  try {
    fs.symlinkSync(victim, path.join(dir, `.file.json.${process.pid}.tmp`));
  } catch {
    t.skip('symlinks need extra privileges on this OS');
    return;
  }

  atomicWriteFileSync(target, '{"a":1}');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":1}');
});

test('atomicWriteFileSync recovers from a leftover tmp file of a crashed run', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, `.file.json.${process.pid}.tmp`), 'stale');

  atomicWriteFileSync(path.join(dir, 'file.json'), '{"b":2}');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'file.json'), 'utf8'), '{"b":2}');
});

test('atomicWriteFileSync never writes into a file hard-linked at the tmp name', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'original');
  fs.linkSync(victim, path.join(dir, `.file.json.${process.pid}.tmp`));

  atomicWriteFileSync(path.join(dir, 'file.json'), '{"c":3}');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original');
});


test('atomicWriteFileSync writes through a linked directory (e.g. ~/.claude moved via a junction)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  const link = path.join(dir, 'link');
  // junctions need no privileges on Windows; directory symlinks need none on POSIX
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');

  atomicWriteFileSync(path.join(link, 'state.json'), '{"d":4}');
  assert.strictEqual(fs.readFileSync(path.join(real, 'state.json'), 'utf8'), '{"d":4}');
});
