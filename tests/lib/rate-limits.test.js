const test = require('node:test');
const assert = require('node:assert');
const { parseRateLimits, modelTier, weeklyForModel } = require('../../lib/rate-limits');

test('parseRateLimits picks the more-pressing account window as top', () => {
  const r = parseRateLimits({
    five_hour: { used_percentage: 40, resets_at: 1900000000 },
    seven_day: { used_percentage: 70, resets_at: 1900000000 },
  });
  assert.strictEqual(r.top.pct, 70);
  assert.ok(r.top.resetAt.startsWith('20')); // epoch seconds -> ISO
});

test('parseRateLimits extracts per-model weekly caps, including future models', () => {
  const r = parseRateLimits({
    seven_day: { used_percentage: 20 },
    seven_day_opus: { used_percentage: 92, resets_at: 1900000000 },
    seven_day_sonnet: { used_percentage: 30 },
    seven_day_newmodel: { used_percentage: 5 },
  });
  assert.strictEqual(r.byModel.opus.pct, 92);
  assert.strictEqual(r.byModel.sonnet.pct, 30);
  assert.strictEqual(r.byModel.newmodel.pct, 5); // generic discovery, no code change
});

test('parseRateLimits keeps a window with a bad resets_at (resetAt=null), never drops it', () => {
  const r = parseRateLimits({ five_hour: { used_percentage: 5, resets_at: 'junk' } });
  assert.strictEqual(r.top.pct, 5);
  assert.strictEqual(r.top.resetAt, null);
});

test('parseRateLimits drops one malformed window without dropping the others', () => {
  const r = parseRateLimits({
    five_hour: { used_percentage: 10 },
    seven_day_opus: { used_percentage: 'not-a-number' },
    seven_day_fable: { used_percentage: 50 },
  });
  assert.ok(r.top && r.top.pct === 10);
  assert.strictEqual(r.byModel.opus, undefined);
  assert.strictEqual(r.byModel.fable.pct, 50);
});

test('parseRateLimits returns empty shape for junk input', () => {
  assert.deepStrictEqual(parseRateLimits(null), { top: null, byModel: {} });
  assert.deepStrictEqual(parseRateLimits('nope'), { top: null, byModel: {} });
});

test('modelTier classifies by family', () => {
  assert.strictEqual(modelTier('claude-opus-4-8'), 'opus');
  assert.strictEqual(modelTier('claude-sonnet-4-6'), 'sonnet');
  assert.strictEqual(modelTier('gpt-4'), null);
});

test('weeklyForModel matches exact tier then prefix', () => {
  const byModel = { opus: { pct: 92 }, sonnet_4_6: { pct: 30 } };
  assert.strictEqual(weeklyForModel(byModel, 'claude-opus-4-8').pct, 92);
  assert.strictEqual(weeklyForModel(byModel, 'claude-sonnet-4-6').pct, 30); // prefix match
  assert.strictEqual(weeklyForModel(byModel, 'claude-haiku-4-5'), null);
});
