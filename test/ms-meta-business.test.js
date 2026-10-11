'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { config, plain, mediaUrl } = require('../ms-meta-business');

const base = {
  DATABASE_URL: 'postgres://pilot:test@localhost/pilot', META_APP_ID: '123',
  META_APP_SECRET: 'meta-app-secret', META_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  META_MS_OAUTH_REDIRECT_URI: 'https://pilot.example/auth/meta/ms/callback'
};

test('MS Meta config stays off until separately enabled and uses a distinct callback', () => {
  assert.equal(config(base).enabled, false);
  assert.equal(config(base).maxDaily, 1);
  assert.throws(() => config({ ...base, META_MS_OAUTH_REDIRECT_URI: 'https://pilot.example/auth/callback' }), { code: 'MS_META_REDIRECT_INVALID' });
  assert.throws(() => config({ ...base, MS_META_MAX_DAILY_PER_CHANNEL: '3' }), { code: 'MS_META_DAILY_LIMIT_INVALID' });
});

test('Meta text is plain and bounded; Instagram photos must be hosted by MS website', () => {
  assert.equal(plain('<b>Frisch gestrichene Wände</b>', 2000), 'Frisch gestrichene Wände');
  assert.throws(() => plain('   ', 2000), { code: 'MS_META_TEXT_INVALID' });
  assert.equal(mediaUrl('https://ms-handwerkservice.de/projekte/raum.jpg'), 'https://ms-handwerkservice.de/projekte/raum.jpg');
  assert.throws(() => mediaUrl('https://example.org/photo.jpg'), { code: 'MS_META_MEDIA_URL_INVALID' });
  assert.throws(() => mediaUrl('http://ms-handwerkservice.de/photo.jpg'), { code: 'MS_META_MEDIA_URL_INVALID' });
});
