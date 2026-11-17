'use strict';

const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.MS_HANDWERK_DATA_DIR || path.join(process.env.PILOT_DATA_DIR || '/data', 'ms_handwerk');
const ASSETS_DIR = path.join(ROOT, 'assets', 'ms_handwerk');
const STATE_FILE = path.join(DATA_DIR, 'last-cycle.json');
const PUBLISH_FILE = path.join(DATA_DIR, 'publish-state.json');
let busy = false;
let timer = null;
let lastResult = null;

function readState() {
  try { lastResult = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return lastResult; }
  catch { return lastResult; }
}
function readPublishState() {
  try { return JSON.parse(fs.readFileSync(PUBLISH_FILE, 'utf8')); } catch { return {}; }
}
function writePublishState(state) {
  fs.mkdirSync(DATA_DIR, {recursive: true});
  const temp = `${PUBLISH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, PUBLISH_FILE);
}
async function zernio(pathname, {method = 'GET', body, idempotencyKey} = {}) {
  const key = String(process.env.ZERNIO_API_KEY || '');
  if (!key) throw new Error('ZERNIO_API_KEY_REQUIRED');
  const response = await fetch(`https://zernio.com/api/v1/${pathname}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {Authorization: `Bearer ${key}`, ...(body ? {'Content-Type': 'application/json'} : {}), ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`ZERNIO_HTTP_${response.status}`);
  return data;
}
const validObjectId = id => /^[a-f0-9]{24}$/.test(String(id || ''));

async function publishDaily(result) {
  const ids = {facebook: String(process.env.MS_ZERNIO_FB_ACCOUNT_ID || ''),
    instagram: String(process.env.MS_ZERNIO_IG_ACCOUNT_ID || ''), tiktok: String(process.env.MS_ZERNIO_TIKTOK_ACCOUNT_ID || '')};
  const configured = Object.entries(ids).filter(([platform, id]) => id && (platform !== 'tiktok' || String(process.env.MS_ZERNIO_TIKTOK_PUBLISH_CONSENT || '').toLowerCase() === 'true'));
  if (!configured.length) return {published: false, skipped: 'NO_APPROVED_MS_SOCIAL_ACCOUNTS'};
  if (!process.env.ZERNIO_API_KEY) return {published: false, skipped: 'ZERNIO_API_KEY_REQUIRED'};
  const assetName = path.basename(String(result.videoFile || ''));
  if (!/^ms-handwerk-\d{4}-\d{2}-\d{2}-[a-f0-9]+\.mp4$/.test(assetName)) return {published: false, skipped: 'VIDEO_ASSET_INVALID'};
  const domain = String(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain || /[^a-zA-Z0-9.-]/.test(domain)) return {published: false, skipped: 'RAILWAY_PUBLIC_DOMAIN_REQUIRED'};
  const videoURL = `https://${domain}/ms-handwerk-assets/${assetName}`;
  const accounts = (await zernio('accounts')).accounts || [];
  const state = readPublishState();
  const outcomes = [];
  for (const [platform, accountId] of configured) {
    if (!validObjectId(accountId)) { outcomes.push({platform, status: 'blocked', reason: 'ACCOUNT_ID_FORMAT_INVALID'}); continue; }
    const key = `${result.bundle.date}:${platform}`;
    if (state[key]) { outcomes.push({platform, status: state[key].status, reason: 'ALREADY_ATTEMPTED_TODAY'}); continue; }
    if (!accounts.some(account => account._id === accountId && account.platform === platform && account.isActive === true)) {
      outcomes.push({platform, status: 'blocked', reason: 'MS_ACCOUNT_ID_NOT_ACTIVE_ON_EXPECTED_PLATFORM'}); continue;
    }
    const idempotencyKey = crypto.createHash('sha256').update(`ms-handwerk:zernio:${result.bundle.date}:${platform}:${accountId}`).digest('hex');
    const intent = {status: 'submission_intent', accountId, platform, at: new Date().toISOString(), idempotencyKey};
    state[key] = intent;
    writePublishState(state);
    try {
      if (platform === 'tiktok') {
        const creator = await zernio(`accounts/${accountId}/tiktok/creator-info?mediaType=video`);
        if (creator.creator?.canPostMore !== true || !creator.privacyLevels?.some(item => item.value === 'PUBLIC_TO_EVERYONE') || !creator.commercialContentTypes?.some(item => item.value === 'brand_organic')) {
          delete state[key]; writePublishState(state);
          outcomes.push({platform, status: 'blocked', reason: 'TIKTOK_PUBLIC_OR_COMMERCIAL_POST_PREFLIGHT_FAILED'}); continue;
        }
      }
      const body = {content: result.bundle.video.caption, mediaItems: [{type: 'video', url: videoURL}], platforms: [{platform, accountId}], publishNow: true,
        metadata: {brand: 'ms_handwerk_service', cycleDate: result.bundle.date, idempotencyKey},
        ...(platform === 'tiktok' ? {tiktokSettings: {privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: false, allow_duet: false, allow_stitch: false,
          content_preview_confirmed: true, express_consent_given: true, commercialContentType: 'brand_organic'}} : {})};
      const created = await zernio('posts', {method: 'POST', body, idempotencyKey});
      const postId = String(created.post?._id || '');
      if (!validObjectId(postId)) throw new Error('ZERNIO_RESULT_UNCERTAIN');
      state[key] = {...intent, status: 'verification_pending', providerPostId: postId};
      writePublishState(state);
      const verified = await zernio(`posts/${postId}`);
      const entry = (verified.post?.platforms || []).find(item => item.platform === platform && String(item.accountId?._id || item.accountId) === accountId);
      let host = ''; try { host = new URL(entry?.platformPostUrl || '').hostname; } catch {}
      const domainPattern = platform === 'facebook' ? /(^|\.)facebook\.com$/ : platform === 'instagram' ? /(^|\.)instagram\.com$/ : /(^|\.)tiktok\.com$/;
      const published = entry?.status === 'published' && domainPattern.test(host);
      state[key] = {...state[key], status: published ? 'published' : 'verification_pending', permalink: published ? entry.platformPostUrl : null, checkedAt: new Date().toISOString()};
      writePublishState(state);
      outcomes.push({platform, status: state[key].status, permalink: state[key].permalink});
    } catch (error) {
      state[key] = {...intent, status: 'recovery_required', error: String(error.message || 'PUBLISH_RESULT_UNCERTAIN').slice(0, 80)};
      writePublishState(state);
      outcomes.push({platform, status: 'recovery_required', reason: state[key].error});
    }
  }
  return {published: outcomes.some(item => item.status === 'published'), outcomes};
}

function generate({force = false, render = true} = {}) {
  if (busy) return Promise.resolve({ok: false, status: 'busy', reason: 'CYCLE_ALREADY_RUNNING'});
  busy = true;
  fs.mkdirSync(DATA_DIR, {recursive: true});
  return new Promise(resolve => {
    const args = [path.join(ROOT, 'ms_handwerk_pipeline.py'), '--output-dir', DATA_DIR, '--assets-dir', ASSETS_DIR];
    if (!render) args.push('--no-render');
    const child = spawn('python3', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore']});
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) child.kill('SIGKILL'); });
    child.on('error', () => finish({ok: false, status: 'failed', reason: 'PYTHON3_UNAVAILABLE'}));
    child.on('close', async code => {
      if (code !== 0) return finish({ok: false, status: 'failed', reason: 'LOCAL_GENERATION_FAILED'});
      try {
        const generated = JSON.parse(stdout.trim());
        const result = {...generated, forceRequested: force, cycleStatus: 'generated_not_published'};
        if (render) result.social = await publishDaily(result).catch(error => ({published: false, skipped: String(error.message || 'PUBLISH_PREFLIGHT_FAILED').slice(0, 100)}));
        result.cycleStatus = result.social?.published ? 'published_verified' : 'generated_not_published';
        fs.writeFileSync(STATE_FILE, JSON.stringify(result, null, 2));
        lastResult = result;
        finish(result);
      } catch { finish({ok: false, status: 'failed', reason: 'GENERATION_RESULT_INVALID'}); }
    });
    function finish(result) { busy = false; resolve(result); }
  });
}

function dailyEnabled(env = process.env) { return String(env.MS_HANDWERK_PIPELINE_ENABLED || '').toLowerCase() === 'true'; }
function isDue(now = new Date()) {
  const prior = readState();
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  return prior?.bundle?.date !== today;
}
async function runIfDue() {
  if (!dailyEnabled() || !isDue()) return {skipped: dailyEnabled() ? 'ALREADY_RAN_TODAY' : 'PIPELINE_DISABLED'};
  return generate({render: true});
}
function registerAssetRoute(app) {
  app.get('/ms-handwerk-assets/:filename', (req, res) => {
    const name = String(req.params.filename || '');
    if (!/^ms-handwerk-\d{4}-\d{2}-\d{2}-[a-f0-9]+\.mp4$/.test(name)) return res.sendStatus(404);
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) return res.sendStatus(404);
    res.type('video/mp4').set('Cache-Control', 'public, max-age=86400, immutable').sendFile(file);
  });
}
function startDailyScheduler({runOnBoot = true, app} = {}) {
  if (timer || !dailyEnabled()) return false;
  if (app) registerAssetRoute(app);
  if (runOnBoot) { const startup = setTimeout(() => runIfDue().catch(() => {}), 30_000); startup.unref?.(); }
  timer = setInterval(() => runIfDue().catch(() => {}), 60_000);
  timer.unref?.();
  return true;
}
function stopDailyScheduler() { if (timer) clearInterval(timer); timer = null; }
function status(env = process.env) {
  const ids = {facebook: String(env.MS_ZERNIO_FB_ACCOUNT_ID || ''), instagram: String(env.MS_ZERNIO_IG_ACCOUNT_ID || ''), tiktok: String(env.MS_ZERNIO_TIKTOK_ACCOUNT_ID || '')};
  const missing = Object.entries(ids).filter(([, id]) => !id).map(([platform]) => `MS_ZERNIO_${platform.toUpperCase()}_ACCOUNT_ID_REQUIRED`);
  if (!env.ZERNIO_API_KEY) missing.push('ZERNIO_API_KEY_REQUIRED');
  if (ids.tiktok && String(env.MS_ZERNIO_TIKTOK_PUBLISH_CONSENT || '').toLowerCase() !== 'true') missing.push('MS_ZERNIO_TIKTOK_PUBLISH_CONSENT_REQUIRED');
  return {enabled: dailyEnabled(env), dailySchedule: 'once_per_local_calendar_day', timeZone: 'Europe/Berlin', running: busy,
    lastCycle: readState(), social: {accountIdsConfigured: Object.fromEntries(Object.entries(ids).map(([k,v]) => [k, Boolean(v)])), zernioApiKeyConfigured: Boolean(env.ZERNIO_API_KEY), publishingImplemented: true, blockers: missing, lastPublishState: readPublishState()},
    paidAdsEnabled: String(env.PAID_ADS_ENABLED || '').toLowerCase() === 'true', adSpendEUR: 0};
}

module.exports = {generate, runIfDue, startDailyScheduler, stopDailyScheduler, registerAssetRoute, status, DATA_DIR};
