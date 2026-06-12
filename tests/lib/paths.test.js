const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const paths = require('../../lib/paths');

test('projectHash is deterministic, 12 hex chars', () => {
  const a = paths.projectHash('C:\\Users\\USER\\my-project');
  const b = paths.projectHash('C:\\Users\\USER\\my-project');
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('projectHash differs for different paths', () => {
  const a = paths.projectHash('C:\\Users\\USER\\project-a');
  const b = paths.projectHash('C:\\Users\\USER\\project-b');
  assert.notStrictEqual(a, b);
});

test('continuityRoot respects CQG_HOME override', () => {
  const original = process.env.CQG_HOME;
  process.env.CQG_HOME = 'C:\\fake\\home';
  assert.strictEqual(paths.continuityRoot(), path.join('C:\\fake\\home', '.claude', 'session-continuity'));
  if (original === undefined) delete process.env.CQG_HOME;
  else process.env.CQG_HOME = original;
});

test('pendingPath and checkpointPath nest under continuityRoot/<hash>', () => {
  const original = process.env.CQG_HOME;
  process.env.CQG_HOME = 'C:\\fake\\home';

  const hash = paths.projectHash('C:\\Users\\USER\\my-project');
  assert.strictEqual(
    paths.pendingPath('C:\\Users\\USER\\my-project'),
    path.join('C:\\fake\\home', '.claude', 'session-continuity', hash, 'pending.json')
  );
  assert.strictEqual(
    paths.checkpointPath('C:\\Users\\USER\\my-project', '2026-06-11T00-00-00'),
    path.join('C:\\fake\\home', '.claude', 'session-continuity', hash, 'checkpoint-2026-06-11T00-00-00.md')
  );

  if (original === undefined) delete process.env.CQG_HOME;
  else process.env.CQG_HOME = original;
});

test('configPath and logPath live at continuityRoot root', () => {
  const original = process.env.CQG_HOME;
  process.env.CQG_HOME = 'C:\\fake\\home';

  assert.strictEqual(paths.configPath(), path.join('C:\\fake\\home', '.claude', 'session-continuity', 'config.json'));
  assert.strictEqual(paths.logPath(), path.join('C:\\fake\\home', '.claude', 'session-continuity', 'watcher.log'));

  if (original === undefined) delete process.env.CQG_HOME;
  else process.env.CQG_HOME = original;
});
