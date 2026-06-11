# claude-quota-guardian — Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-contained checkpoint/resume loop — detect when context-window or plan-quota usage hits 99.5%, auto-write a rich resumable checkpoint, and auto-inject it on the next session start.

**Architecture:** Pure Node.js ≥18, CommonJS, zero mandatory deps (`node-notifier` optional). Three layers: `lib/` (usage math + shared helpers), `hooks/` (`PostToolUse` trigger + `SessionStart` resume), `commands/continuity-checkpoint.md` (Claude-driven checkpoint writer). State lives under `~/.claude/session-continuity/` (overridable via `CQG_HOME` for tests).

**Tech Stack:** Node.js ≥18, `node:test` built-in runner, `node-notifier` (optional).

**Scope note:** Spec (`docs/superpowers/specs/2026-06-11-claude-quota-guardian-design.md`) sections 5.5 (watcher) and 9 (installer/uninstaller, full README/docs/CI for plan-quota reset detection) are deliberately deferred to a follow-up plan ("Phase 2: packaging & watcher"). This plan delivers a complete, independently useful, manually-installable system covering spec sections 1-4, 5.1-5.4, 6 (minus the watcher leg), 7, and 8.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `LICENSE`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-quota-guardian",
  "version": "0.1.0",
  "description": "Auto-checkpoint and auto-resume for Claude Code sessions approaching usage limits",
  "license": "MIT",
  "main": "lib/usage-monitor.js",
  "scripts": {
    "test": "node --test tests/"
  },
  "engines": {
    "node": ">=18"
  },
  "optionalDependencies": {
    "node-notifier": "^10.0.1"
  }
}
```

- [ ] **Step 2: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 claude-quota-guardian contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
*.tmp
.*.tmp
```

- [ ] **Step 4: Commit**

```bash
git add package.json LICENSE .gitignore
git commit -m "chore: project scaffolding"
```

---

### Task 2: `lib/atomic-write.js` and `lib/notify.js`

**Files:**
- Create: `lib/atomic-write.js`
- Create: `lib/notify.js`
- Test: `tests/lib/atomic-write.test.js`
- Test: `tests/lib/notify.test.js`

- [ ] **Step 1: Write failing tests**

`tests/lib/atomic-write.test.js`:

```js
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
```

`tests/lib/notify.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const notify = require('../../lib/notify');

test('send does not throw even if notifier unavailable', () => {
  assert.doesNotThrow(() => notify.send('Title', 'Message'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/atomic-write.test.js tests/lib/notify.test.js`
Expected: FAIL with "Cannot find module '../../lib/atomic-write'" and "../../lib/notify"

- [ ] **Step 3: Implement `lib/atomic-write.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

module.exports = { atomicWriteFileSync };
```

- [ ] **Step 4: Implement `lib/notify.js`**

```js
'use strict';

let notifier = null;
try {
  notifier = require('node-notifier');
} catch {
  notifier = null;
}

function send(title, message) {
  if (!notifier) return;
  try {
    notifier.notify({ title, message });
  } catch {
    // Notification failures must never affect the calling hook/watcher.
  }
}

module.exports = { send };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/lib/atomic-write.test.js tests/lib/notify.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/atomic-write.js lib/notify.js tests/lib/atomic-write.test.js tests/lib/notify.test.js
git commit -m "feat: add atomic write and notification helpers"
```

---

### Task 3: `lib/paths.js`

**Files:**
- Create: `lib/paths.js`
- Test: `tests/lib/paths.test.js`

- [ ] **Step 1: Write failing test**

`tests/lib/paths.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/paths.test.js`
Expected: FAIL with "Cannot find module '../../lib/paths'"

- [ ] **Step 3: Implement `lib/paths.js`**

```js
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

function continuityRoot() {
  const base = process.env.CQG_HOME || os.homedir();
  return path.join(base, '.claude', 'session-continuity');
}

function projectHash(projectPath) {
  return crypto.createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 12);
}

function projectDir(projectPath) {
  return path.join(continuityRoot(), projectHash(projectPath));
}

function pendingPath(projectPath) {
  return path.join(projectDir(projectPath), 'pending.json');
}

function checkpointPath(projectPath, timestamp) {
  return path.join(projectDir(projectPath), `checkpoint-${timestamp}.md`);
}

function configPath() {
  return path.join(continuityRoot(), 'config.json');
}

function logPath() {
  return path.join(continuityRoot(), 'watcher.log');
}

module.exports = {
  continuityRoot,
  projectHash,
  projectDir,
  pendingPath,
  checkpointPath,
  configPath,
  logPath,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/paths.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/paths.js tests/lib/paths.test.js
git commit -m "feat: add path helpers with CQG_HOME override for tests"
```

---

### Task 4: `lib/config.js`

**Files:**
- Create: `lib/config.js`
- Test: `tests/lib/config.test.js`

- [ ] **Step 1: Write failing test**

`tests/lib/config.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/config.test.js`
Expected: FAIL with "Cannot find module '../../lib/config'"

- [ ] **Step 3: Implement `lib/config.js`**

```js
'use strict';

const fs = require('node:fs');
const paths = require('./paths');

const DEFAULTS = {
  plan: 'none',
  thresholds: { context: 0.995, plan: 0.995 },
  planCheckIntervalToolCalls: 5,
  watcherIntervalMinutes: 15,
  notifications: { enabled: true },
};

function loadConfig() {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(paths.configPath(), 'utf8'));
  } catch {
    onDisk = {};
  }
  return {
    ...DEFAULTS,
    ...onDisk,
    thresholds: { ...DEFAULTS.thresholds, ...(onDisk.thresholds || {}) },
    notifications: { ...DEFAULTS.notifications, ...(onDisk.notifications || {}) },
  };
}

module.exports = { loadConfig, DEFAULTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/config.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/config.js tests/lib/config.test.js
git commit -m "feat: add config loader with defaults"
```

---

### Task 5: `lib/usage-monitor.js` — `getContextUsage`

**Files:**
- Create: `lib/plan-limits.json`
- Create: `lib/usage-monitor.js`
- Create: `tests/fixtures/transcript-50pct.jsonl`
- Create: `tests/fixtures/transcript-99-6pct.jsonl`
- Create: `tests/fixtures/transcript-no-usage.jsonl`
- Test: `tests/lib/usage-monitor.test.js`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/transcript-50pct.jsonl` (one assistant message using 100,000 of 200,000 tokens = 50%):

```
{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":90000,"cache_read_input_tokens":10000,"cache_creation_input_tokens":0,"output_tokens":500}}}
```

`tests/fixtures/transcript-99-6pct.jsonl` (199,200 of 200,000 tokens = 99.6%):

```
{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":190000,"cache_read_input_tokens":9200,"cache_creation_input_tokens":0,"output_tokens":300}}}
```

`tests/fixtures/transcript-no-usage.jsonl` (no assistant usage anywhere):

```
{"type":"user","message":{"role":"user","content":"hello"}}
```

- [ ] **Step 2: Create `lib/plan-limits.json`**

```json
{
  "context": {
    "default": 200000
  }
}
```

- [ ] **Step 3: Write failing test**

`tests/lib/usage-monitor.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { getContextUsage } = require('../../lib/usage-monitor');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

test('getContextUsage computes pct from latest assistant usage', () => {
  const result = getContextUsage(path.join(FIXTURES, 'transcript-50pct.jsonl'));
  assert.strictEqual(result.pct, 50);
  assert.strictEqual(result.used, 100000);
  assert.strictEqual(result.limit, 200000);
  assert.strictEqual(result.model, 'claude-sonnet-4-6');
});

test('getContextUsage detects near-threshold usage', () => {
  const result = getContextUsage(path.join(FIXTURES, 'transcript-99-6pct.jsonl'));
  assert.ok(Math.abs(result.pct - 99.6) < 0.001);
});

test('getContextUsage returns null pct when no usage found', () => {
  const result = getContextUsage(path.join(FIXTURES, 'transcript-no-usage.jsonl'));
  assert.strictEqual(result.pct, null);
  assert.strictEqual(result.error, 'no-usage-found');
});

test('getContextUsage returns null pct for missing file', () => {
  const result = getContextUsage(path.join(FIXTURES, 'does-not-exist.jsonl'));
  assert.strictEqual(result.pct, null);
  assert.strictEqual(result.error, 'transcript-unreadable');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test tests/lib/usage-monitor.test.js`
Expected: FAIL with "Cannot find module '../../lib/usage-monitor'"

- [ ] **Step 5: Implement `getContextUsage` in `lib/usage-monitor.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLAN_LIMITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan-limits.json'), 'utf8'));

function contextLimitForModel(model) {
  if (model && PLAN_LIMITS.context[model] != null) return PLAN_LIMITS.context[model];
  return PLAN_LIMITS.context.default;
}

function getContextUsage(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { pct: null, error: 'transcript-unreadable' };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const usage = entry && entry.message && entry.message.usage;
    if (!usage) continue;

    const used = (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0);
    const model = entry.message.model || null;
    const limit = contextLimitForModel(model);

    return { pct: (used / limit) * 100, used, limit, model };
  }

  return { pct: null, error: 'no-usage-found' };
}

module.exports = { getContextUsage };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tests/lib/usage-monitor.test.js`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/plan-limits.json lib/usage-monitor.js tests/fixtures tests/lib/usage-monitor.test.js
git commit -m "feat: add context-window usage calculation"
```

---

### Task 6: `lib/usage-monitor.js` — `getPlanUsage`

**Files:**
- Modify: `lib/usage-monitor.js`
- Modify: `tests/lib/usage-monitor.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/lib/usage-monitor.test.js`:

```js
const cp = require('node:child_process');
const { getPlanUsage } = require('../../lib/usage-monitor');

test('getPlanUsage returns unavailable for plan "none"', () => {
  const result = getPlanUsage('none');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'plan-none');
});

test('getPlanUsage parses ccusage active block', (t) => {
  const fakeOutput = JSON.stringify({
    blocks: [
      {
        endTime: '2026-06-11T18:00:00Z',
        tokenLimitStatus: { percentUsed: 87.2 },
      },
    ],
  });
  t.mock.method(cp, 'execFileSync', () => fakeOutput);

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.pct, 87.2);
  assert.strictEqual(result.resetAt, '2026-06-11T18:00:00Z');
});

test('getPlanUsage returns unavailable when ccusage throws', (t) => {
  t.mock.method(cp, 'execFileSync', () => {
    throw new Error('not found');
  });

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'ccusage-unavailable');
});

test('getPlanUsage returns unavailable when ccusage output has no limit data', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({ blocks: [{ endTime: 'x' }] }));

  const result = getPlanUsage('pro');
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.reason, 'no-limit-data');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/usage-monitor.test.js`
Expected: FAIL — `getPlanUsage is not a function`

- [ ] **Step 3: Implement `getPlanUsage`**

Add to top of `lib/usage-monitor.js` (after existing requires):

```js
const cp = require('node:child_process');
```

Add before `module.exports`:

```js
function runCcusage(args) {
  try {
    const out = cp.execFileSync('npx', ['ccusage@latest', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      windowsHide: true,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function getPlanUsage(planType) {
  if (!planType || planType === 'none') {
    return { available: false, reason: 'plan-none' };
  }

  const data = runCcusage(['blocks', '--json', '--active', '--token-limit', 'max']);
  if (!data || !Array.isArray(data.blocks) || data.blocks.length === 0) {
    return { available: false, reason: 'ccusage-unavailable' };
  }

  const block = data.blocks[0];
  const status = block.tokenLimitStatus;
  if (!status || typeof status.percentUsed !== 'number') {
    return { available: false, reason: 'no-limit-data' };
  }

  return {
    available: true,
    pct: status.percentUsed,
    resetAt: block.endTime || null,
  };
}
```

Update `module.exports` to:

```js
module.exports = { getContextUsage, getPlanUsage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/usage-monitor.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/usage-monitor.js tests/lib/usage-monitor.test.js
git commit -m "feat: add plan-quota usage via ccusage with self-calibrating limit"
```

---

### Task 7: `lib/usage-monitor.js` — `getStatus`

**Files:**
- Modify: `lib/usage-monitor.js`
- Modify: `tests/lib/usage-monitor.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/lib/usage-monitor.test.js`:

```js
const { getStatus } = require('../../lib/usage-monitor');

test('getStatus flags context threshold hit when plan is "none"', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'context');
  assert.strictEqual(status.planPct, null);
});

test('getStatus reports no threshold hit below limits', () => {
  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-50pct.jsonl'),
    config: { plan: 'none', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, false);
  assert.strictEqual(status.triggeredBy, null);
});

test('getStatus reports "both" when context and plan both hit', (t) => {
  t.mock.method(cp, 'execFileSync', () => JSON.stringify({
    blocks: [{ endTime: 'reset-time', tokenLimitStatus: { percentUsed: 99.7 } }],
  }));

  const status = getStatus({
    transcriptPath: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    config: { plan: 'pro', thresholds: { context: 0.995, plan: 0.995 } },
  });
  assert.strictEqual(status.anyAtThreshold, true);
  assert.strictEqual(status.triggeredBy, 'both');
  assert.strictEqual(status.planResetAt, 'reset-time');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/usage-monitor.test.js`
Expected: FAIL — `getStatus is not a function`

- [ ] **Step 3: Implement `getStatus`**

Add before `module.exports`:

```js
function getStatus({ transcriptPath, config }) {
  const ctx = getContextUsage(transcriptPath);
  const contextPct = ctx.pct;

  let planPct = null;
  let planResetAt = null;
  if (config.plan !== 'none') {
    const plan = getPlanUsage(config.plan);
    if (plan.available) {
      planPct = plan.pct;
      planResetAt = plan.resetAt;
    }
  }

  const contextHit = contextPct !== null && (contextPct / 100) >= config.thresholds.context;
  const planHit = planPct !== null && (planPct / 100) >= config.thresholds.plan;

  let triggeredBy = null;
  if (contextHit && planHit) triggeredBy = 'both';
  else if (contextHit) triggeredBy = 'context';
  else if (planHit) triggeredBy = 'plan';

  return {
    contextPct,
    planPct,
    planResetAt,
    anyAtThreshold: contextHit || planHit,
    triggeredBy,
  };
}
```

Update `module.exports` to:

```js
module.exports = { getContextUsage, getPlanUsage, getStatus };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/usage-monitor.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/usage-monitor.js tests/lib/usage-monitor.test.js
git commit -m "feat: add combined usage status with threshold detection"
```

---

### Task 8: `hooks/check-usage.js`

**Files:**
- Create: `hooks/check-usage.js`
- Test: `tests/hooks/check-usage.test.js`

- [ ] **Step 1: Write failing test**

`tests/hooks/check-usage.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'check-usage.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

function pendingFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'pending.json');
}

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('check-usage no-ops below threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-50pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(fs.existsSync(pendingFileFor(home, 'C:\\fake\\project')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage writes pending.json and blocks at threshold', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /continuity-checkpoint/);

  const pending = JSON.parse(fs.readFileSync(pendingFileFor(home, 'C:\\fake\\project'), 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'context');
  assert.strictEqual(pending.checkpointFile, null);
  assert.ok(pending.pctAtTrigger.context >= 99.5);

  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage is idempotent when pending already exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const pendingFile = pendingFileFor(home, 'C:\\fake\\project');
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ consumed: false }));

  const out = runHook(
    { transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'), cwd: 'C:\\fake\\project', session_id: 's1' },
    { CQG_HOME: home }
  );

  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('check-usage exits 0 with bad stdin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CQG_HOME: home },
  });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/check-usage.test.js`
Expected: FAIL — hook file does not exist (ENOENT)

- [ ] **Step 3: Implement `hooks/check-usage.js`**

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStatus } = require('../lib/usage-monitor');
const { loadConfig } = require('../lib/config');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');
const notify = require('../lib/notify');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const input = readStdin();
  if (!input || !input.transcript_path || !input.cwd) {
    return;
  }

  const pendingFile = paths.pendingPath(input.cwd);

  let pending = null;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    pending = null;
  }
  if (pending && pending.consumed === false) {
    return; // already pending — idempotent no-op
  }

  const config = loadConfig();
  const status = getStatus({ transcriptPath: input.transcript_path, config });

  if (!status.anyAtThreshold) {
    return;
  }

  const newPending = {
    projectPath: input.cwd,
    projectName: path.basename(input.cwd),
    sessionId: input.session_id || null,
    triggeredBy: status.triggeredBy,
    pctAtTrigger: {
      context: status.contextPct === null ? null : Math.round(status.contextPct * 10) / 10,
      plan: status.planPct === null ? null : Math.round(status.planPct * 10) / 10,
    },
    triggeredAt: new Date().toISOString(),
    checkpointFile: null,
    consumed: false,
    consumedAt: null,
    planResetAtSeen: status.planResetAt,
  };

  atomicWriteFileSync(pendingFile, JSON.stringify(newPending, null, 2));

  const pctShown = Math.max(newPending.pctAtTrigger.context || 0, newPending.pctAtTrigger.plan || 0);
  notify.send('Claude Quota Guardian', `Uso al ${pctShown}% — guardando progreso...`);

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Usage at threshold (${status.triggeredBy}). Stop the current task now: do not start new work. Run /continuity-checkpoint to save a resumable checkpoint, then end the turn.`,
  }));
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[check-usage] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/check-usage.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add hooks/check-usage.js tests/hooks/check-usage.test.js
git commit -m "feat: add PostToolUse hook to detect threshold and trigger checkpoint"
```

---

### Task 9: `commands/continuity-checkpoint.md`

**Files:**
- Create: `commands/continuity-checkpoint.md`

- [ ] **Step 1: Create the command file**

`commands/continuity-checkpoint.md`:

````markdown
---
description: Save a rich, resumable checkpoint before usage limits are reached, so the next session can resume without re-explaining context.
---

# /continuity-checkpoint

You are at or near a usage limit (context window or plan quota). Your job: capture everything a future session needs to resume this exact task with zero re-explanation, then stop.

## Step 1 — Compute paths

Run this in Bash (works on Windows/macOS/Linux with Node ≥18):

```bash
node -e "const c=require('crypto'),p=require('path'),fs=require('fs'),os=require('os');const cwd=process.cwd();const hash=c.createHash('sha1').update(p.resolve(cwd)).digest('hex').slice(0,12);const root=p.join(os.homedir(),'.claude','session-continuity',hash);fs.mkdirSync(root,{recursive:true});const ts=new Date().toISOString().replace(/[:.]/g,'-');console.log(JSON.stringify({root,ts,checkpoint:p.join(root,'checkpoint-'+ts+'.md'),pending:p.join(root,'pending.json')}))"
```

This prints a JSON object with `root`, `ts`, `checkpoint`, and `pending` paths. Use these exact paths in the next steps.

## Step 2 — Write the checkpoint file

Write to the `checkpoint` path from Step 1, with this exact structure (fill in real content from this session — no placeholders):

```markdown
# Checkpoint — <ISO timestamp>

## What We Are Building
<1-3 sentences: the overall goal of this project/task>

## What WORKED
<bullet list of completed, verified work, with evidence (file paths, test results, commit hashes)>

## What Did NOT Work
<bullet list of approaches tried and abandoned, and WHY — so they aren't retried>

## What Has NOT Been Tried Yet
<bullet list of remaining approaches/ideas not yet attempted>

## Current State of Files
| File | State |
|---|---|
<one row per file touched this session, with current status>

## Decisions Made
<bullet list of decisions and their rationale>

## Blockers & Open Questions
<anything unresolved that needs user input — or "None">

## Exact Next Step
<the SINGLE concrete next action, specific enough to execute with zero ambiguity>
```

## Step 3 — Update pending.json

Read the `pending` path from Step 1.

If it exists (the check-usage hook created it): update its `checkpointFile` field to the `checkpoint` path from Step 1, keeping all other fields unchanged. Write it back atomically — write to `<pending>.tmp` in the same directory, then rename over `pending.json`.

If it does NOT exist (this command was run manually, not triggered by the hook): create it with this shape, then write it atomically the same way:

```json
{
  "projectPath": "<cwd>",
  "projectName": "<basename of cwd>",
  "sessionId": null,
  "triggeredBy": "manual",
  "pctAtTrigger": { "context": null, "plan": null },
  "triggeredAt": "<ISO timestamp>",
  "checkpointFile": "<checkpoint path>",
  "consumed": false,
  "consumedAt": null,
  "planResetAtSeen": null
}
```

## Step 4 — Confirm and stop

Reply with exactly one line:

> Checkpoint guardado en `<checkpoint path>`. Podés cerrar Claude — al reabrir en este proyecto, retoma solo.

Then end your turn. Do NOT start any new task.
````

- [ ] **Step 2: Commit**

```bash
git add commands/continuity-checkpoint.md
git commit -m "feat: add self-contained /continuity-checkpoint command"
```

---

### Task 10: `hooks/resume-context.js`

**Files:**
- Create: `hooks/resume-context.js`
- Test: `tests/hooks/resume-context.test.js`

- [ ] **Step 1: Write failing test**

`tests/hooks/resume-context.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');
const { atomicWriteFileSync } = require('../../lib/atomic-write');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'resume-context.js');

function pendingFileFor(home, cwd) {
  return path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd), 'pending.json');
}

function runHook(input, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('resume-context no-ops when nothing pending', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const out = runHook({ cwd: 'C:\\fake\\project', source: 'startup' }, { CQG_HOME: home });
  assert.strictEqual(out.trim(), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('resume-context injects checkpoint and marks consumed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = 'C:\\fake\\project';
  const pendingFile = pendingFileFor(home, cwd);
  const checkpointFile = path.join(path.dirname(pendingFile), 'checkpoint-test.md');

  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(checkpointFile, '# Checkpoint\n\n## Exact Next Step\nRun the failing test for X.\n');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    projectPath: cwd,
    projectName: 'project',
    sessionId: 's1',
    triggeredBy: 'context',
    pctAtTrigger: { context: 99.6, plan: null },
    triggeredAt: new Date().toISOString(),
    checkpointFile,
    consumed: false,
    consumedAt: null,
    planResetAtSeen: null,
  }, null, 2));

  const out = runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  const result = JSON.parse(out);
  const ctx = result.hookSpecificOutput.additionalContext;

  assert.match(ctx, /Exact Next Step/);
  assert.match(ctx, /MODO RETOMAR/);

  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, true);
  assert.ok(pending.consumedAt);

  fs.rmSync(home, { recursive: true, force: true });
});

test('resume-context is a no-op on second call (already consumed)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = 'C:\\fake\\project';
  const pendingFile = pendingFileFor(home, cwd);
  const checkpointFile = path.join(path.dirname(pendingFile), 'checkpoint-test.md');

  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(checkpointFile, '# Checkpoint\n');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    checkpointFile,
    consumed: true,
    consumedAt: new Date().toISOString(),
    triggeredAt: new Date().toISOString(),
  }, null, 2));

  const out = runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  assert.strictEqual(out.trim(), '');

  fs.rmSync(home, { recursive: true, force: true });
});

test('resume-context warns when checkpoint is older than 7 days', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-home-'));
  const cwd = 'C:\\fake\\project';
  const pendingFile = pendingFileFor(home, cwd);
  const checkpointFile = path.join(path.dirname(pendingFile), 'checkpoint-test.md');
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(checkpointFile, '# Checkpoint\n\n## Exact Next Step\nDo X.\n');
  atomicWriteFileSync(pendingFile, JSON.stringify({
    checkpointFile,
    consumed: false,
    consumedAt: null,
    triggeredAt: oldDate,
  }, null, 2));

  const out = runHook({ cwd, source: 'startup' }, { CQG_HOME: home });
  const result = JSON.parse(out);
  assert.match(result.hookSpecificOutput.additionalContext, /ADVERTENCIA/);
  assert.match(result.hookSpecificOutput.additionalContext, /8 días/);

  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hooks/resume-context.test.js`
Expected: FAIL — hook file does not exist (ENOENT)

- [ ] **Step 3: Implement `hooks/resume-context.js`**

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const paths = require('../lib/paths');
const { atomicWriteFileSync } = require('../lib/atomic-write');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const input = readStdin();
  if (!input || !input.cwd) {
    return;
  }

  const pendingFile = paths.pendingPath(input.cwd);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    return;
  }

  if (!pending || pending.consumed !== false || !pending.checkpointFile) {
    return;
  }

  let checkpoint;
  try {
    checkpoint = fs.readFileSync(pending.checkpointFile, 'utf8');
  } catch {
    return;
  }

  let header = '';
  const ageMs = Date.now() - new Date(pending.triggeredAt).getTime();
  if (ageMs > 7 * MS_PER_DAY) {
    const days = Math.floor(ageMs / MS_PER_DAY);
    header += `**ADVERTENCIA:** este checkpoint tiene ${days} días. Verificá si algo cambió antes de continuar.\n\n`;
  }

  const directive = '\n\n---\n\n**MODO RETOMAR:** ya tenés el contexto completo arriba. No preguntes de nuevo ni releas archivos para entender qué se estaba haciendo — anunciá brevemente el "Próximo paso" y continuá directo. Las confirmaciones normales de seguridad para acciones irreversibles (push, borrar, etc.) siguen aplicando igual.';

  pending.consumed = true;
  pending.consumedAt = new Date().toISOString();
  atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: header + checkpoint + directive,
    },
  }));
}

try {
  main();
} catch (err) {
  try {
    fs.appendFileSync(paths.logPath(), `[resume-context] ${new Date().toISOString()} ERROR ${err.stack}\n`);
  } catch {
    // logging is best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hooks/resume-context.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add hooks/resume-context.js tests/hooks/resume-context.test.js
git commit -m "feat: add SessionStart hook to auto-inject pending checkpoint"
```

---

### Task 11: `scripts/simulate-threshold.js`

**Files:**
- Create: `scripts/simulate-threshold.js`

- [ ] **Step 1: Implement the script**

`scripts/simulate-threshold.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const out = { pct: 99.6, model: 'claude-sonnet-4-6', limit: 200000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pct') out.pct = parseFloat(argv[++i]);
    else if (argv[i] === '--model') out.model = argv[++i];
    else if (argv[i] === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

function main() {
  const { pct, model, limit } = parseArgs(process.argv.slice(2));
  const used = Math.round((pct / 100) * limit);

  const entry = {
    type: 'assistant',
    message: {
      id: 'msg_simulated',
      role: 'assistant',
      model,
      usage: {
        input_tokens: used,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
      },
    },
  };

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-sim-'));
  const outFile = path.join(outDir, 'transcript.jsonl');
  fs.writeFileSync(outFile, JSON.stringify(entry) + '\n');

  console.log(`Simulated transcript written to: ${outFile}`);
  console.log(`Target: ${pct}% (${used}/${limit} tokens, model=${model})`);
  console.log('');
  console.log('Test the hook with:');
  console.log(`  echo '{"transcript_path":${JSON.stringify(outFile)},"cwd":${JSON.stringify(process.cwd())},"session_id":"sim"}' | node hooks/check-usage.js`);
}

main();
```

- [ ] **Step 2: Manual smoke test**

Run: `node scripts/simulate-threshold.js --pct 99.6`
Expected: prints a transcript path and a ready-to-paste `echo | node hooks/check-usage.js` command. Run that command (with `CQG_HOME` set to a scratch dir) and confirm it prints a `decision: "block"` JSON object.

- [ ] **Step 3: Commit**

```bash
git add scripts/simulate-threshold.js
git commit -m "feat: add manual threshold simulation script"
```

---

### Task 12: End-to-end full-cycle test

**Files:**
- Test: `tests/e2e/full-cycle.test.js`

- [ ] **Step 1: Write the test**

`tests/e2e/full-cycle.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const paths = require('../../lib/paths');
const { atomicWriteFileSync } = require('../../lib/atomic-write');

const ROOT = path.join(__dirname, '..', '..');
const CHECK_HOOK = path.join(ROOT, 'hooks', 'check-usage.js');
const RESUME_HOOK = path.join(ROOT, 'hooks', 'resume-context.js');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

function run(hook, input, env) {
  return execFileSync('node', [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('full cycle: trigger -> checkpoint -> resume -> idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqg-e2e-'));
  const cwd = 'C:\\fake\\my-project';
  const env = { CQG_HOME: home };

  fs.mkdirSync(path.join(home, '.claude', 'session-continuity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session-continuity', 'config.json'),
    JSON.stringify({ plan: 'none' })
  );

  // 1. Threshold hit -> PostToolUse hook blocks and writes pending.json
  const checkOut = run(CHECK_HOOK, {
    transcript_path: path.join(FIXTURES, 'transcript-99-6pct.jsonl'),
    cwd,
    session_id: 's1',
  }, env);
  assert.strictEqual(JSON.parse(checkOut).decision, 'block');

  const projectDir = path.join(home, '.claude', 'session-continuity', paths.projectHash(cwd));
  const pendingFile = path.join(projectDir, 'pending.json');
  let pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, false);
  assert.strictEqual(pending.triggeredBy, 'context');

  // 2. Simulate /continuity-checkpoint: write checkpoint + update pending
  const checkpointFile = path.join(projectDir, 'checkpoint-test.md');
  fs.writeFileSync(checkpointFile, '# Checkpoint\n\n## Exact Next Step\nRun the failing test for X.\n');
  pending.checkpointFile = checkpointFile;
  atomicWriteFileSync(pendingFile, JSON.stringify(pending, null, 2));

  // 3. Reopen: SessionStart hook resumes
  const resumeOut = run(RESUME_HOOK, { cwd, source: 'startup' }, env);
  const ctx = JSON.parse(resumeOut).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Exact Next Step/);
  assert.match(ctx, /MODO RETOMAR/);

  pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.strictEqual(pending.consumed, true);

  // 4. Second resume is a no-op
  const resumeOut2 = run(RESUME_HOOK, { cwd, source: 'startup' }, env);
  assert.strictEqual(resumeOut2.trim(), '');

  fs.rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/e2e/full-cycle.test.js`
Expected: PASS (1 test)

- [ ] **Step 3: Run the full suite**

Run: `node --test tests/`
Expected: PASS — all tests across `tests/lib`, `tests/hooks`, `tests/e2e` (≈ 23 tests)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/full-cycle.test.js
git commit -m "test: add end-to-end checkpoint/resume cycle test"
```

---

### Task 13: README and configuration docs

**Files:**
- Create: `README.md`
- Create: `docs/configuration.md`

- [ ] **Step 1: Create `docs/configuration.md`**

```markdown
# Configuration

claude-quota-guardian reads `~/.claude/session-continuity/config.json`. All fields are optional — missing fields fall back to defaults.

| Field | Default | Description |
|---|---|---|
| `plan` | `"none"` | `"none"` \| `"pro"` \| `"max5x"` \| `"max20x"`. `"none"` disables plan-quota checks (context-window monitoring still runs). Any other value enables `ccusage`-based plan checks. |
| `thresholds.context` | `0.995` | Fraction (0-1) of the model's context window that triggers a checkpoint. |
| `thresholds.plan` | `0.995` | Fraction (0-1) of the plan's quota (per `ccusage`) that triggers a checkpoint. |
| `planCheckIntervalToolCalls` | `5` | Reserved for the Phase 2 watcher; not yet used by the core hooks. |
| `watcherIntervalMinutes` | `15` | Reserved for the Phase 2 watcher. |
| `notifications.enabled` | `true` | Reserved for future use; notifications currently fire whenever `node-notifier` is installed. |

## Plan-quota checks (`ccusage`)

If `plan` is not `"none"`, `getPlanUsage` shells out to `npx ccusage@latest blocks --json --active --token-limit max`. The `max` token-limit mode self-calibrates against your own historical usage, so no hardcoded per-plan token totals are needed. If `ccusage` is not installed or fails, plan-quota checks are silently skipped — only context-window checks remain active.

Install `ccusage` globally for faster startup: `npm i -g ccusage`.

## Example

```json
{
  "plan": "pro",
  "thresholds": { "context": 0.995, "plan": 0.995 }
}
```
```

- [ ] **Step 2: Create `README.md`**

```markdown
# claude-quota-guardian

Automatic checkpoint and resume for Claude Code sessions approaching usage limits.

When your context window or plan quota gets close to its limit, claude-quota-guardian:

1. Detects the threshold (default 99.5%) via a `PostToolUse` hook.
2. Tells Claude to stop and run `/continuity-checkpoint`, which writes a rich, structured summary of the session (what was built, what worked, what didn't, the exact next step).
3. The next time you open Claude Code in that project, a `SessionStart` hook automatically injects that checkpoint as context — Claude picks up exactly where it left off, with zero re-explanation.

No automatic relaunching: you decide when to reopen Claude. claude-quota-guardian only handles the save and the resume.

## How it works

```
[Normal work] -> PostToolUse: check-usage.js
       |
       |-- below threshold -> no-op
       |
       `-- >= 99.5% -> pending.json + OS notification + hook "block"
                        |
                        v
                Claude runs /continuity-checkpoint
                -> writes checkpoint-<ts>.md, updates pending.json
                -> ends the turn cleanly
                        |
              (you close Claude, usage resets later)
                        |
              You reopen Claude in the same project
                        |
                SessionStart: resume-context.js
                -> injects the full checkpoint + "MODO RETOMAR"
                -> marks pending.json consumed
                        |
                Claude announces the next step and continues
```

## Requirements

- Node.js >= 18
- Claude Code (CLI or desktop app) with hook support

## Installation (manual)

1. Clone this repo somewhere stable, e.g. `~/.claude/claude-quota-guardian`:

   ```bash
   git clone <repo-url> ~/.claude/claude-quota-guardian
   ```

2. Add the hooks to `~/.claude/settings.json` (merge into your existing `hooks` object — don't overwrite other hooks):

   ```json
   {
     "hooks": {
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"~/.claude/claude-quota-guardian/hooks/check-usage.js\"" }] }
       ],
       "SessionStart": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "node \"~/.claude/claude-quota-guardian/hooks/resume-context.js\"" }] }
       ]
     }
   }
   ```

   Replace `~` with your actual home directory path (e.g. `C:\\Users\\YOU` on Windows) — `settings.json` does not expand `~`.

3. Copy the checkpoint command:

   ```bash
   cp ~/.claude/claude-quota-guardian/commands/continuity-checkpoint.md ~/.claude/commands/
   ```

4. (Optional) enable plan-quota checks: create `~/.claude/session-continuity/config.json` — see [docs/configuration.md](docs/configuration.md).

5. (Optional) install `ccusage` for plan-quota checks: `npm i -g ccusage`.

6. (Optional) install `node-notifier` for OS notifications:

   ```bash
   cd ~/.claude/claude-quota-guardian && npm install
   ```

## Testing your install

```bash
node scripts/simulate-threshold.js --pct 99.6
```

This prints a ready-to-run command that feeds a simulated near-limit transcript into `hooks/check-usage.js`, so you can confirm the hook fires and writes `pending.json` without waiting for a real session to fill up.

## Status

This is the **core loop** (checkpoint + resume). A follow-up phase adds:

- A background watcher that detects when your plan quota resets and notifies you it's safe to reopen Claude.
- An interactive installer/uninstaller (`bin/install.js` / `bin/uninstall.js`).

See `docs/superpowers/specs/2026-06-11-claude-quota-guardian-design.md` for the full design.

## License

MIT
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/configuration.md
git commit -m "docs: add README and configuration reference"
```

---

### Task 14: CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create the workflow**

`.github/workflows/test.yml`:

```yaml
name: test

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm install
      - run: node --test tests/
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run test suite on Node 18 and 20"
```

---

## Self-Review Notes

- **Spec coverage:** Sections 1-4 (architecture, storage, formats) → Tasks 1, 3, 4, 5. Section 5.1 (`usage-monitor`) → Tasks 5-7. Section 5.2 (`check-usage`) → Task 8. Section 5.3 (`continuity-checkpoint`) → Task 9. Section 5.4 (`resume-context`) → Task 10. Section 6 (end-to-end flow, minus watcher leg) → Task 12. Section 7 (error handling: corrupt files, missing transcript, atomic writes, 7-day warning, ccusage missing) → covered across Tasks 5, 6, 8, 10. Section 8 (testing) → Tasks 5-12 + `scripts/simulate-threshold.js`. Section 9 (packaging) → partially covered by manual-install README (Task 13); `bin/install.js`/`bin/uninstall.js` and section 5.5 (watcher) deferred to Phase 2 per Scope Note.
- **Placeholder scan:** no TBD/TODO; all code blocks are complete and runnable.
- **Type consistency:** `getContextUsage` → `{pct, used, limit, model, error?}`; `getPlanUsage` → `{available, pct?, resetAt?, reason?}`; `getStatus` → `{contextPct, planPct, planResetAt, anyAtThreshold, triggeredBy}` — used consistently in Tasks 5-8. `pending.json` shape is identical across Tasks 8, 9, 10, 12.
