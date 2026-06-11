const test = require('node:test');
const assert = require('node:assert');
const notify = require('../../lib/notify');

test('send does not throw even if notifier unavailable', () => {
  assert.doesNotThrow(() => notify.send('Title', 'Message'));
});
