'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleBusinessPublisher, config, cleanText, localPostUrl } = require('../ms-google-business');

const env = { DATABASE_URL: 'postgres://test', GOOGLE_BUSINESS_CLIENT_ID: 'client-id', GOOGLE_BUSINESS_CLIENT_SECRET: 'client-secret',
  GOOGLE_BUSINESS_REDIRECT_URI: 'https://pilot.example/auth/google/business/callback', GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  GOOGLE_BUSINESS_LOCATION: 'accounts/1/locations/2', GOOGLE_BUSINESS_AUTOPUBLISH_ENABLED: 'true' };

test('Google Business settings require HTTPS callback, a stable encryption key and a valid location path', () => {
  assert.equal(config(env).publishingEnabled, true);
  assert.throws(() => config({ ...env, GOOGLE_BUSINESS_REDIRECT_URI: 'http://pilot.example/auth/google/business/callback' }), /GOOGLE_REDIRECT_INVALID/);
  assert.throws(() => config({ ...env, GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY: 'bad' }), /GOOGLE_ENCRYPTION_KEY_INVALID/);
  assert.throws(() => config({ ...env, GOOGLE_BUSINESS_LOCATION: 'accounts/1/locations/nope' }), /GOOGLE_LOCATION_INVALID/);
  assert.deepEqual(config({}).missing.sort(), ['DATABASE_URL', 'GOOGLE_BUSINESS_CLIENT_ID', 'GOOGLE_BUSINESS_CLIENT_SECRET',
    'GOOGLE_BUSINESS_REDIRECT_URI', 'GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY'].sort());
});

test('Google text is plain German, bounded and rejects markup, emojis and control characters', () => {
  assert.equal(cleanText('  Innenanstrich  in Kempten ', 1500, 'INVALID_TEXT'), 'Innenanstrich in Kempten');
  assert.throws(() => cleanText('<b>Werbung</b>', 1500, 'INVALID_TEXT'), /INVALID_TEXT/);
  assert.throws(() => cleanText('Neu 🔥', 1500, 'INVALID_TEXT'), /INVALID_TEXT/);
  assert.throws(() => cleanText('x'.repeat(1501), 1500, 'INVALID_TEXT'), /INVALID_TEXT/);
  assert.equal(localPostUrl('accounts/1/locations/2'), 'https://mybusiness.googleapis.com/v4/accounts/1/locations/2/localPosts');
});

function fakePool() {
  const post = { id: 'post-1', payload: { languageCode: 'de', summary: 'Innenanstrich in Kempten. Wände wurden gestrichen.',
    link: 'https://ms-handwerkservice.de/?utm_source=google', service: 'Innenanstrich', city: 'Kempten' }, status: 'queued' };
  const events = [];
  const pool = { events, async query(sql, args = []) {
    events.push({ sql: String(sql), args });
    if (String(sql).includes("WHERE id='ms_handwerk'")) return { rows: [{ status: 'connected', encrypted_credentials: 'unused' }] };
    if (String(sql).includes('count(*)::int AS n')) return { rows: [{ n: post.status === 'recovery_required' || post.status === 'published' ? 1 : 0 }] };
    if (String(sql).includes('GROUP BY status')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  }, async connect() {
    return { async query(sql, args = []) {
      events.push({ sql: String(sql), args });
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (String(sql).includes('count(*)::int AS n')) return { rows: [{ n: post.status === 'recovery_required' || post.status === 'published' ? 1 : 0 }] };
      if (String(sql).includes('SELECT * FROM ms_gbp_posts')) return { rows: post.status === 'queued' ? [post] : [] };
      if (String(sql).includes("SET status='publishing'")) post.status = 'publishing';
      if (String(sql).includes("SET status='recovery_required'") && post.status === 'publishing') post.status = 'recovery_required';
      if (String(sql).includes('SET status=$2')) post.status = args[1];
      if (String(sql).includes('SET status=\'published\'')) post.status = 'published';
      return { rows: [], rowCount: 1 };
    }, release() {} };
  } };
  return { pool, post };
}

test('worker publishes one queued post to the configured MS location and stores Google confirmation', async () => {
  const { pool, post } = fakePool(); let outbound;
  const publisher = new GoogleBusinessPublisher({ env, pool, fetchImpl: async (url, options) => {
    outbound = { url, options }; return { ok: true, json: async () => ({ name: 'accounts/1/locations/2/localPosts/77', state: 'LIVE' }) };
  } });
  publisher.accessToken = async () => ({ token: 'test-token', credentials: {} });
  const result = await publisher.tick();
  assert.equal(result.published, true, JSON.stringify(result));
  assert.equal(post.status, 'published');
  assert.equal(outbound.url, 'https://mybusiness.googleapis.com/v4/accounts/1/locations/2/localPosts');
  assert.match(outbound.options.headers.Authorization, /^Bearer /);
  assert.deepEqual(JSON.parse(outbound.options.body), { languageCode: 'de', summary: post.payload.summary, topicType: 'STANDARD',
    callToAction: { actionType: 'LEARN_MORE', url: post.payload.link } });
  assert.ok(pool.events.some(x => x.sql.includes('remote=$3') && x.args[2].name.endsWith('/77')));
});

test('ambiguous remote result is held for recovery and is never submitted a second time', async () => {
  const { pool, post } = fakePool(); let submits = 0;
  const publisher = new GoogleBusinessPublisher({ env, pool, fetchImpl: async () => { submits++; throw new Error('connection closed'); } });
  publisher.accessToken = async () => ({ token: 'test-token', credentials: {} });
  const first = await publisher.tick();
  assert.equal(first.status, 'recovery_required', JSON.stringify(first));
  assert.equal(post.status, 'recovery_required');
  const second = await publisher.tick();
  assert.equal(second.skipped, 'DAILY_LIMIT');
  assert.equal(submits, 1);
});

