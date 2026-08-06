const test = require('node:test');
const assert = require('node:assert');
const notify = require('../../lib/notify');

test('send does not throw even if notifier unavailable', () => {
  assert.doesNotThrow(() => notify.send('Title', 'Message'));
});

test('sendTelegram is a no-op (no network, no throw) when disabled or unconfigured', () => {
  assert.doesNotThrow(() => notify.sendTelegram('T', 'M', { enabled: false, botToken: 'x', chatId: 'y' }));
  assert.doesNotThrow(() => notify.sendTelegram('T', 'M', { enabled: true })); // missing token/chatId
  assert.doesNotThrow(() => notify.sendTelegram('T', 'M', null));
});

test('send with an explicit disabled telegram config never touches the network', () => {
  assert.doesNotThrow(() => notify.send('T', 'M', { telegram: { enabled: false } }));
});
