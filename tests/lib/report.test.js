'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectReport, renderReportHtml } = require('../../lib/report');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-report-'));
  // Project A: 2 checkpoints, resumed.
  const a = path.join(root, 'aaaaaaaaaaaa');
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'checkpoint-2026-08-05T10-00-00-000Z.md'), '# c1');
  fs.writeFileSync(path.join(a, 'checkpoint-2026-08-05T12-00-00-000Z.md'), '# c2');
  fs.writeFileSync(
    path.join(a, 'pending.json'),
    JSON.stringify({ projectName: 'Alpha', triggeredBy: 'context', consumed: true })
  );
  // Project B: 1 checkpoint, not resumed, no name.
  const b = path.join(root, 'bbbbbbbbbbbb');
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'checkpoint-2026-08-04T09-00-00-000Z.md'), '# c1');
  fs.writeFileSync(path.join(b, 'pending.json'), JSON.stringify({ triggeredBy: 'context-predicted', consumed: false }));
  // Provider dir (codex), 1 checkpoint.
  const c = path.join(root, 'codex-cccccccccccc');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'checkpoint-2026-08-03T08-00-00-000Z.md'), '# c1');
  // Noise: a loose file at root must be ignored.
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  return root;
}

test('collectReport aggregates real checkpoint data', () => {
  const root = makeTree();
  const data = collectReport(root);

  assert.strictEqual(data.totals.projects, 3);
  assert.strictEqual(data.totals.checkpoints, 4);
  assert.strictEqual(data.totals.resumes, 1);
  assert.deepStrictEqual(data.totals.byTrigger, { context: 1, 'context-predicted': 1 });

  // Sorted: Alpha (2 checkpoints) first.
  assert.strictEqual(data.projects[0].name, 'Alpha');
  assert.strictEqual(data.projects[0].checkpoints, 2);
  assert.strictEqual(data.projects[0].resumed, true);
  assert.strictEqual(data.projects[0].lastCheckpoint, '2026-08-05T12-00-00-000Z');

  const codex = data.projects.find((p) => p.provider === 'codex');
  assert.ok(codex, 'codex provider dir detected');
  assert.strictEqual(codex.provider, 'codex');

  fs.rmSync(root, { recursive: true, force: true });
});

test('collectReport returns empty shape when root is missing', () => {
  const data = collectReport(path.join(os.tmpdir(), 'cqg-does-not-exist-xyz'));
  assert.deepStrictEqual(data.totals, { projects: 0, checkpoints: 0, resumes: 0, byTrigger: {} });
  assert.strictEqual(data.projects.length, 0);
});

test('renderReportHtml produces self-contained HTML with totals', () => {
  const root = makeTree();
  const html = renderReportHtml(collectReport(root), '2026-08-05T13-00-00-000Z');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Checkpoints creados/);
  assert.match(html, /Alpha/);
  assert.ok(!/<script/i.test(html), 'no scripts — static report');
  fs.rmSync(root, { recursive: true, force: true });
});

test('renderReportHtml escapes project names', () => {
  const data = { projects: [{ name: '<x>&"', provider: 'claude', checkpoints: 1, lastCheckpoint: null, resumed: false }], totals: { projects: 1, checkpoints: 1, resumes: 0, byTrigger: {} } };
  const html = renderReportHtml(data, 'now');
  assert.ok(!html.includes('<x>&"'), 'raw name not injected');
  assert.match(html, /&lt;x&gt;/);
});
