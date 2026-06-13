const test = require('node:test');
const assert = require('node:assert');
const { ensureHooksMerged, removeHooks } = require('../../lib/hooks-merge');

test('ensureHooksMerged adds hooks to empty settings', () => {
  const result = ensureHooksMerged({}, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
    { event: 'SessionStart', matcher: '*', command: 'node "resume-context.js"' },
  ]);

  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
  ]);
  assert.deepStrictEqual(result.hooks.SessionStart, [
    { matcher: '*', hooks: [{ type: 'command', command: 'node "resume-context.js"' }] },
  ]);
});

test('ensureHooksMerged preserves existing unrelated hooks', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
      ],
    },
    otherSetting: true,
  };

  const result = ensureHooksMerged(existing, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
  ]);

  assert.strictEqual(result.otherSetting, true);
  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
    { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
  ]);
});

test('ensureHooksMerged is idempotent', () => {
  let result = ensureHooksMerged({}, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
  ]);
  result = ensureHooksMerged(result, [
    { event: 'PostToolUse', matcher: '*', command: 'node "check-usage.js"' },
  ]);

  assert.strictEqual(result.hooks.PostToolUse.length, 1);
  assert.strictEqual(result.hooks.PostToolUse[0].hooks.length, 1);
});

test('removeHooks removes only the matching command', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
        { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
      ],
    },
  };

  const result = removeHooks(existing, [
    { event: 'PostToolUse', command: 'node "check-usage.js"' },
  ]);

  assert.deepStrictEqual(result.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "other-hook.js"' }] },
  ]);
});

test('removeHooks cleans up empty event arrays and the hooks key', () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node "check-usage.js"' }] },
      ],
    },
  };

  const result = removeHooks(existing, [
    { event: 'PostToolUse', command: 'node "check-usage.js"' },
  ]);

  assert.strictEqual(result.hooks, undefined);
});

test('removeHooks on settings with no hooks is a no-op', () => {
  const existing = { someSetting: 1 };
  const result = removeHooks(existing, [{ event: 'PostToolUse', command: 'x' }]);
  assert.deepStrictEqual(result, existing);
});
