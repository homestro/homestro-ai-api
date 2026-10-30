"""Explicit owner-authorized first-customer test. No prior sale, generation or new ad.

Only the exact durable owned campaign can be resumed. Consent, activation intent,
first actual activation, conservative expiry and stop latches survive restart.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import parse_qs, urljoin, urlsplit
from zoneinfo import ZoneInfo

import httpx

from .feed_manager import ProductFeedManager
from .micro_budget import configured_daily_budget_limit_eur, live_ads_dry_run
from .order_economics import decode_ref, instant

POLICY = 'first_purchase_acquisition_test'
AUTHORIZATION = 'homestro-DE-AT-5EUR-day-35EUR-7days-owner-20261027'
STOPPED_CLAIMS = {'STOPPED_TEST_BUDGET', 'STOPPED_PERFORMANCE', 'STOPPED_OWNER', 'STOPPED_TEST_EXPIRED'}


class FirstPurchaseStore:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.executescript('''CREATE TABLE IF NOT EXISTS pilot_first_purchase_consent(
              singleton INTEGER PRIMARY KEY CHECK(singleton=1), authorization TEXT NOT NULL,
              campaign TEXT NOT NULL, terms TEXT NOT NULL, state TEXT NOT NULL,
              authorized_at TEXT NOT NULL, activation_intent_at TEXT, activated_at TEXT,
              expires_at TEXT, stop_reason TEXT);
              CREATE TABLE IF NOT EXISTS pilot_first_purchase_reviews(
              creative TEXT PRIMARY KEY, revision TEXT NOT NULL, reviewer TEXT NOT NULL, reviewed_at TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS pilot_first_purchase_envelopes(
              day TEXT PRIMARY KEY,cap_cents INTEGER NOT NULL CHECK(cap_cents>0 AND cap_cents<=3500),
              provider_acknowledged INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS pilot_first_purchase_lifetime_cap(
              adset TEXT PRIMARY KEY,cap_cents INTEGER NOT NULL CHECK(cap_cents>0 AND cap_cents<=3500));
              CREATE TABLE IF NOT EXISTS pilot_first_purchase_backoff(
              campaign TEXT PRIMARY KEY,until_at TEXT NOT NULL,reason TEXT NOT NULL);''')

    def defer_provider(self, campaign, reason, now, seconds):
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_first_purchase_backoff VALUES(?,?,?) '
                       'ON CONFLICT(campaign) DO UPDATE SET until_at=excluded.until_at,reason=excluded.reason',
                       (campaign, (now + timedelta(seconds=seconds)).isoformat(), reason))

    def provider_backoff(self, campaign, now):
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT until_at,reason FROM pilot_first_purchase_backoff WHERE campaign=?', (campaign,)).fetchone()
        if row and now < instant(row[0]):
            return {'retry_after': row[0], 'reason': row[1]}
        return None

    def lifetime_cap(self, adset, proposed=None):
        with closing(self.audit._connect()) as db, db:
            if proposed is not None:
                db.execute('INSERT INTO pilot_first_purchase_lifetime_cap VALUES(?,?) ON CONFLICT(adset) DO NOTHING', (adset, proposed))
            row = db.execute('SELECT cap_cents FROM pilot_first_purchase_lifetime_cap WHERE adset=?', (adset,)).fetchone()
            return row[0] if row else None

    def authorize(self, campaign, now):
        terms = {'markets': ['DE', 'AT'], 'daily_eur': '5.00', 'total_eur': '35.00', 'days': 7,
                 'automatic_increase': False, 'starts_at_actual_activation': True,
                 'new_paid_generation_authorized': False, 'unseen_creatives_authorized': False,
                 'source': 'explicit_owner_voice_authorization_20261027'}
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_first_purchase_consent(singleton,authorization,campaign,terms,state,authorized_at) '
                       'VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO NOTHING',
                       (AUTHORIZATION, campaign, json.dumps(terms, sort_keys=True), 'authorized', now.isoformat()))
            row = db.execute('SELECT campaign,terms FROM pilot_first_purchase_consent WHERE singleton=1').fetchone()
            if row != (campaign, json.dumps(terms, sort_keys=True)):
                raise ValueError('PERSISTED_CONSENT_SCOPE_MISMATCH')
        return self.read()

    def read(self):
        with closing(self.audit._connect()) as db:
            db.row_factory = __import__('sqlite3').Row
            row = db.execute('SELECT * FROM pilot_first_purchase_consent WHERE singleton=1').fetchone()
        return dict(row) if row else None

    def intent(self, now, remote_end):
        deadline = min(now + timedelta(days=7), remote_end)
        with closing(self.audit._connect()) as db, db:
            db.execute("UPDATE pilot_first_purchase_consent SET state='activation_intent',activation_intent_at=?,expires_at=? "
                       "WHERE singleton=1 AND state='authorized'", (now.isoformat(), deadline.isoformat()))
        return self.read()

    def activated(self, at):
        row = self.read()
        deadline = min(instant(row['expires_at']), at + timedelta(days=7))
        with closing(self.audit._connect()) as db, db:
            db.execute("UPDATE pilot_first_purchase_consent SET state='active',activated_at=?,expires_at=? "
                       "WHERE singleton=1 AND state='activation_intent'", (at.isoformat(), deadline.isoformat()))
        return self.read()

    def stop(self, reason):
        with closing(self.audit._connect()) as db, db:
            db.execute("UPDATE pilot_first_purchase_consent SET state='stopped',stop_reason=? WHERE singleton=1", (reason,))

    def envelope(self, lifetime, today, now):
        lifetime, today = Decimal(lifetime), Decimal(today)
        if not lifetime.is_finite() or not today.is_finite() or today < 0 or lifetime < today:
            raise ValueError('DAILY_SPEND_BASELINE_INVALID')
        day = now.astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
        cap = min(3500, int((lifetime-today)*100)+500)
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_first_purchase_envelopes(day,cap_cents) VALUES(?,?) ON CONFLICT(day) DO NOTHING', (day, cap))
            db.execute('UPDATE pilot_first_purchase_envelopes SET provider_acknowledged=CASE WHEN cap_cents>? THEN 0 ELSE provider_acknowledged END, cap_cents=MIN(cap_cents,?) WHERE day=?', (cap, cap, day))
            row = db.execute('SELECT cap_cents FROM pilot_first_purchase_envelopes WHERE day=?', (day,)).fetchone()
        return {'day': day, 'cap_cents': min(cap, row[0]), 'authorized_daily_eur': '5.00', 'authorized_total_eur': '35.00'}

    def previous_envelope_confirmed(self, cap, day):
        with closing(self.audit._connect()) as db:
            return bool(db.execute('SELECT 1 FROM pilot_first_purchase_envelopes WHERE day<? AND cap_cents=? AND provider_acknowledged=1', (day, cap)).fetchone())

    def confirm_envelope(self, day, cap):
        with closing(self.audit._connect()) as db, db:
            db.execute('UPDATE pilot_first_purchase_envelopes SET provider_acknowledged=1 WHERE day=? AND cap_cents=?', (day, cap))

    def review(self, creative, revision, reviewer, now):
        if not re.fullmatch(r'\d{4,30}', creative) or not re.fullmatch(r'[a-f0-9]{64}', revision) or not isinstance(reviewer, str) or not 1 <= len(reviewer.strip()) <= 100:
            raise ValueError('CREATIVE_REVIEW_INVALID')
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_first_purchase_reviews VALUES(?,?,?,?) ON CONFLICT(creative) DO UPDATE '
                       'SET revision=excluded.revision,reviewer=excluded.reviewer,reviewed_at=excluded.reviewed_at',
                       (creative, revision, reviewer.strip(), now.isoformat()))

    def reviewed(self, campaign, ad, creative, revision):
        with closing(self.audit._connect()) as db:
            if db.execute('SELECT 1 FROM pilot_first_purchase_reviews WHERE creative=? AND revision=?', (creative, revision)).fetchone():
                return 'exact_owner_preview_review'
            # Reuse only a known, previously created owned ad/creative pair, not an unseen imported draft.
            for raw, in db.execute("SELECT payload_json FROM adtech_audit WHERE kind='meta_micro_campaign_partial' ORDER BY created_at DESC LIMIT 100"):
                row = json.loads(raw)
                if str(row.get('campaign_id')) == campaign and str(row.get('ad_id')) == ad and str(row.get('adcreative_id')) == creative:
                    return 'existing_previously_authorized_owned_ad_identity'
        return None


class FirstPurchaseController:
    def __init__(self, audit, *, env=None, client=None):
        self.audit, self.env, self.client = audit, os.environ if env is None else env, client
        self.store = FirstPurchaseStore(audit)

    async def cycle(self, *, now=None):
        now = now or datetime.now(UTC)
        env = self.env
        claim = await self.audit.get_meta_micro_campaign_claim()
        campaign = str((claim or {}).get('campaign_id') or '')
        scope = env.get('PILOT_FIRST_PURCHASE_CAMPAIGN_ID', '')
        if not re.fullmatch(r'\d{4,30}', scope) or campaign != scope:
            return {'status': 'blocked', 'reason': 'EXACT_OWNED_CAMPAIGN_SCOPE_REQUIRED', 'activation_performed': False}
        consent = self.store.authorize(campaign, now)
        account, token, pixel, page = (env.get(k, '') for k in ('META_AD_ACCOUNT_ID', 'META_ACCESS_TOKEN', 'META_PIXEL_ID', 'META_PAGE_ID'))
        version = env.get('META_API_VERSION', 'v26.0')
        if not re.fullmatch(r'act_\d{4,30}', account) or not token or not re.fullmatch(r'v\d+\.\d+', version):
            return {'status': 'blocked', 'reason': 'META_CONFIGURATION_INVALID', 'consent_recorded': True}
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
        base, headers = 'https://graph.facebook.com/' + version + '/', {'Authorization': 'Bearer ' + token}
        stage = 'campaign'
        snapshot = {'campaign_id': campaign, 'consent_recorded': True, 'prior_purchase_required': False,
                    'daily_ceiling_eur': '5.00', 'total_ceiling_eur': '35.00', 'automatic_increase': False,
                    'new_paid_generation_performed': False, 'activation_performed': False}

        async def get(path, fields=None, params=None):
            response = await client.get(base + path, headers=headers, params=params or {'fields': fields, 'limit': '100'})
            response.raise_for_status()
            data = response.json()
            if data.get('error') or (data.get('paging') or {}).get('next'):
                raise ValueError('PROVIDER_SCOPE_INCOMPLETE')
            return data

        async def pause(reason, *, latch=False):
            response = await client.post(base + campaign, headers=headers, data={'status': 'PAUSED'})
            response.raise_for_status()
            if response.json().get('success') is not True:
                raise ValueError('PAUSE_NOT_ACKNOWLEDGED')
            observed = await get(campaign, 'id,status,effective_status')
            if observed.get('status') != 'PAUSED':
                raise ValueError('PAUSE_NOT_CONFIRMED')
            if latch:
                self.store.stop(reason)
            return {**snapshot, 'status': 'paused_confirmed', 'reason': reason,
                    'effective_status': observed.get('effective_status'), 'consent': self.store.read()}

        try:
            remote = await get(campaign, 'id,account_id,name,objective,status,effective_status,updated_time,spend_cap')
            if str(remote.get('id')) != campaign or str(remote.get('account_id')) != account.removeprefix('act_') or remote.get('objective') != 'OUTCOME_SALES':
                return {**snapshot, 'status': 'blocked', 'reason': 'CAMPAIGN_OWNERSHIP_OR_OBJECTIVE_MISMATCH'}
            snapshot.update(campaign_status=remote.get('status'), effective_status=remote.get('effective_status'))
            if env.get('PILOT_EMERGENCY_STOP') == 'true':
                return await pause('OWNER_EMERGENCY_STOP', latch=True)
            if remote.get('status') == 'ACTIVE' and (live_ads_dry_run(env) or env.get('ALLOW_MICRO_BUDGET') != 'true' or env.get('PILOT_FIRST_PURCHASE_ACTIVATION_ENABLED') != 'true'):
                return await pause('SPEND_DISABLED')
            if consent['state'] == 'stopped' or claim.get('status') in STOPPED_CLAIMS:
                return await pause(consent.get('stop_reason') or 'EXISTING_STOP_LATCH', latch=True)
            if consent.get('expires_at') and now >= instant(consent['expires_at']):
                return await pause('TEST_EXPIRED', latch=True)
            backoff = self.store.provider_backoff(campaign, now)
            if backoff:
                # Independently read campaign status above on every cycle. A
                # cooldown must never leave an externally resumed ad spending.
                if remote.get('status') != 'PAUSED':
                    return {**await pause(backoff['reason']), **backoff}
                return {**snapshot, 'status': 'paused_confirmed', **backoff,
                        'activation_performed': False, 'provider_mutations_deferred': True}
            stage = 'spend'
            spends = {}
            for period in ('maximum', 'today'):
                data = (await get(campaign + '/insights', params={'fields': 'campaign_id,account_currency,spend', 'date_preset': period, 'level': 'campaign', 'limit': '2'})).get('data')
                if not isinstance(data, list) or len(data) > 1:
                    raise ValueError('SPEND_SCOPE_INVALID')
                if data and (str(data[0].get('campaign_id')) != campaign or data[0].get('account_currency') != 'EUR' or data[0].get('spend') is None):
                    raise ValueError('SPEND_SCOPE_OR_CURRENCY_INVALID')
                amount = Decimal(str(data[0]['spend'])) if data else Decimal(0)
                if not amount.is_finite() or amount < 0:
                    raise ValueError('SPEND_INVALID')
                spends[period] = str(amount)
            snapshot['observed_spend_eur'] = spends
            if Decimal(spends['maximum']) >= 35:
                return await pause('TEST_TOTAL_CAP_REACHED', latch=True)
            if Decimal(spends['today']) >= 5:
                return await pause('DAILY_CAP_REACHED')
            # The pre-existing conservative EUR15/no-purchase performance stop is not loosened.
            from .performance_loader import load_meta_performance, performance_decision
            decision = performance_decision(await load_meta_performance(self.audit, env=env, client=client))
            if decision.get('action') == 'pause':
                return await pause(decision['reason'], latch=True)
            stage = 'account_pixel'
            from .media_buyer import MetaPublisher
            readiness = await MetaPublisher(self.audit, env=env, client=client).check_readiness()
            ready = readiness.get('account') or {}
            if readiness.get('status') != 'checked' or ready.get('account_status') != 'active' or ready.get('currency') != 'EUR' or ready.get('pixel_access_verified') is not True or ready.get('billing_ready') is not True:
                snapshot['provider_readiness'] = readiness
                return await pause('META_ACCOUNT_PIXEL_OR_BILLING_NOT_READY')
            timezone = await get(account, 'id,timezone_name')
            accessible_pixels = await get(account+'/adspixels', 'id,name,is_unavailable')
            snapshot['accessible_account_pixel_ids'] = [str(p['id']) for p in accessible_pixels.get('data', []) if p.get('id') and not p.get('is_unavailable')]
            if timezone.get('timezone_name') not in {'Europe/Berlin', 'Europe/Vienna'}:
                return await pause('DAILY_SPEND_REPORTING_TIMEZONE_NOT_DE_AT')
            stage = 'adset'
            adsets = (await get(campaign + '/adsets', 'id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,targeting,promoted_object,optimization_goal')).get('data', [])
            if len(adsets) != 1:
                return await pause('SINGLE_OWNED_ADSET_REQUIRED')
            adset = adsets[0]
            if not re.fullmatch(r'\d{4,30}', str(adset.get('id'))):
                return await pause('ADSET_ID_NOT_VERIFIED')
            snapshot['adset_id'] = str(adset.get('id'))
            snapshot['adset_status'] = adset.get('status')
            snapshot['adset_effective_status'] = adset.get('effective_status')
            snapshot['observed_limits'] = {'daily_budget_cents': adset.get('daily_budget'), 'campaign_spend_cap_cents': remote.get('spend_cap'), 'start_time': adset.get('start_time'), 'end_time': adset.get('end_time'), 'countries': adset.get('targeting', {}).get('geo_locations', {}).get('countries', [])}
            frozen_lifetime_cap = self.store.lifetime_cap(str(adset['id']))
            native_lifetime = (frozen_lifetime_cap is not None and str(adset.get('lifetime_budget')) == str(frozen_lifetime_cap)
                               and adset.get('daily_budget') in (None, 0, '0'))
            daily_mode = str(adset.get('daily_budget')) == '500' and adset.get('lifetime_budget') in (None, 0, '0')
            end, start = instant(adset['end_time']), instant(adset['start_time'])
            if not (daily_mode or native_lifetime) or not start <= now < end or end - start > timedelta(days=7) or set(adset.get('targeting', {}).get('geo_locations', {}).get('countries', [])) != {'DE', 'AT'}:
                return await pause('ADSET_BUDGET_SCHEDULE_OR_DE_AT_TARGETING_INVALID')
            promoted = adset.get('promoted_object') or {}
            if str(promoted.get('pixel_id')) != pixel or promoted.get('custom_event_type') != 'PURCHASE' or adset.get('optimization_goal') != 'OFFSITE_CONVERSIONS':
                return await pause('PURCHASE_TRACKING_CONFIGURATION_NOT_VERIFIED')
            # Prepare a restrictive native cap while already paused, even when
            # creative/site review is outstanding. Discover provider rejection
            # before asking the owner to review. Never release a prior lower cap here.
            if remote.get('status') == 'PAUSED' and not native_lifetime:
                envelope = self.store.envelope(spends['maximum'], spends['today'], now)
                target_cap = envelope['cap_cents']
                cap = Decimal(str(remote.get('spend_cap') or '0'))
                if not cap.is_finite() or cap < 0 or cap != int(cap):
                    return await pause('PROVIDER_SPEND_CAP_INVALID')
                if cap == 0 or cap > target_cap:
                    stage = 'paused_native_cap_preparation'
                    response = await client.post(base + campaign, headers=headers, data={'spend_cap': str(target_cap)})
                    minimum_rejection = False
                    if response.status_code == 400:
                        error = response.json().get('error', {})
                        minimum_rejection = error.get('code') == 100 and error.get('error_subcode') == 2446307
                    if minimum_rejection:
                        # Never substitute a EUR100 provider cap for the owner's EUR35 hard ceiling.
                        # Meta may accept a frozen adset lifetime budget instead.
                        stage = 'paused_native_lifetime_spend_readback'
                        actual = (await get(str(adset['id'])+'/insights', params={'fields': 'adset_id,account_currency,spend', 'date_preset': 'maximum', 'level': 'adset', 'limit': '2'})).get('data')
                        if not isinstance(actual, list) or len(actual) > 1 or (actual and (str(actual[0].get('adset_id')) != str(adset['id']) or actual[0].get('account_currency') != 'EUR')):
                            return await pause('ADSET_LIFETIME_SPEND_SCOPE_UNVERIFIED')
                        adset_spent = Decimal(str(actual[0]['spend'])) if actual else Decimal(0)
                        if not adset_spent.is_finite() or adset_spent < 0 or adset_spent > Decimal(spends['maximum']):
                            return await pause('ADSET_LIFETIME_SPEND_INVALID')
                        remaining = min(Decimal(5)-Decimal(spends['today']), Decimal(35)-Decimal(spends['maximum']))
                        if remaining <= 0:
                            return await pause('TEST_SPEND_ALLOWANCE_EXHAUSTED', latch=True)
                        frozen_lifetime_cap = self.store.lifetime_cap(str(adset['id']), int((adset_spent+remaining)*100))
                        stage = 'paused_native_lifetime_budget_preparation'
                        response = await client.post(base+str(adset['id']), headers=headers,
                            data={'daily_budget': '0', 'lifetime_budget': str(frozen_lifetime_cap)})
                        response.raise_for_status()
                        confirmed = await get(str(adset['id']), 'id,daily_budget,lifetime_budget,start_time,end_time,status,effective_status')
                        if str(confirmed.get('id')) != str(adset['id']) or str(confirmed.get('lifetime_budget')) != str(frozen_lifetime_cap) or confirmed.get('daily_budget') not in (None, 0, '0') or instant(confirmed['end_time']) != end:
                            return await pause('PROVIDER_FROZEN_LIFETIME_BUDGET_NOT_CONFIRMED')
                        snapshot['observed_limits']['daily_budget_cents'] = confirmed.get('daily_budget') or '0'
                        native_lifetime = True
                    else:
                        response.raise_for_status()
                        confirmed = await get(campaign, 'id,spend_cap,status')
                        if str(confirmed.get('spend_cap')) != str(target_cap) or confirmed.get('status') != 'PAUSED':
                            return await pause('PROVIDER_PAUSED_CAP_PREPARATION_NOT_CONFIRMED')
                        remote['spend_cap'] = str(target_cap)
                        cap = Decimal(target_cap)
                if cap == target_cap and not native_lifetime:
                    self.store.confirm_envelope(envelope['day'], target_cap)
                if not native_lifetime:
                    snapshot['native_spend_cap_readback_cents'] = int(cap)
                snapshot['native_spend_envelope'] = envelope
            if native_lifetime:
                snapshot['native_budget_mode'] = 'frozen_remaining_whole_test_allowance_no_daily_refill'
                snapshot['native_adset_lifetime_budget_readback_cents'] = frozen_lifetime_cap
                snapshot['observed_limits']['lifetime_budget_cents'] = str(frozen_lifetime_cap)
                if Decimal(spends['maximum'])*100 >= frozen_lifetime_cap:
                    return await pause('FROZEN_LIFETIME_TEST_CAP_REACHED', latch=True)
            stage = 'creative'
            ads = (await get(str(adset['id']) + '/ads', 'id,status,effective_status,creative{id},ad_review_feedback')).get('data', [])
            if len(ads) != 1 or ads[0].get('ad_review_feedback') or ads[0].get('effective_status') not in {'ACTIVE', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PAUSED'}:
                return await pause('EXISTING_SINGLE_ELIGIBLE_REVIEWED_AD_REQUIRED')
            ad = ads[0]
            creative_id = str(ad['creative']['id'])
            if not all(re.fullmatch(r'\d{4,30}', str(value)) for value in (ad['id'], creative_id)):
                return await pause('AD_OR_CREATIVE_ID_NOT_VERIFIED')
            creative = await get(creative_id, 'id,object_story_spec')
            story = creative.get('object_story_spec') or {}
            if str(story.get('page_id')) != page or not isinstance(story.get('link_data'), dict):
                return await pause('EXISTING_CREATIVE_PAGE_OR_WEBSITE_DESTINATION_UNVERIFIED')
            revision = hashlib.sha256(json.dumps(story, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            data = story['link_data']
            cards = data.get('child_attachments') or [data]
            if not isinstance(cards, list) or not 1 <= len(cards) <= 10:
                return await pause('CREATIVE_CARD_SCOPE_INVALID')
            snapshot.update(ad_id=str(ad['id']), ad_status=ad.get('status'), ad_effective_status=ad.get('effective_status'), creative_id=creative_id, creative_revision=revision,
                            creative_preview={'message': data.get('message'), 'cards': [{'title': r.get('name'), 'image': r.get('picture'), 'destination': r.get('link', '').split('?')[0]} for r in cards]})
            try:
                from lxml import html

                previews = await get(str(ad['id']) + '/previews', params={'ad_format': 'DESKTOP_FEED_STANDARD'})
                frame = html.fromstring(previews['data'][0]['body']).xpath('//iframe/@src')[0]
                target = urlsplit(frame)
                if target.scheme == 'https' and target.hostname in {'www.facebook.com', 'facebook.com', 'business.facebook.com'} and not target.username and 'access_token' not in parse_qs(target.query):
                    snapshot['creative_preview']['meta_preview_url'] = frame
                else:
                    snapshot['preview_read_error'] = {'endpoint': '/'+str(ad['id'])+'/previews', 'reason': 'UNTRUSTED_OR_CREDENTIAL_BEARING_PREVIEW_URL', 'host': target.hostname}
            except Exception as exc:
                snapshot['preview_read_error'] = {'endpoint': '/'+str(ad['id'])+'/previews', 'error_type': type(exc).__name__}
                if isinstance(exc, httpx.HTTPStatusError):
                    snapshot['preview_read_error']['http_status'] = exc.response.status_code
            review = self.store.reviewed(campaign, str(ad['id']), creative_id, revision)
            snapshot['creative_review_basis'] = review
            from .website_ads import owner_excluded, product_path

            paths = [product_path(row.get('link', '')) for row in cards]
            excluded = [i+1 for i, row in enumerate(cards) if owner_excluded(row)]
            snapshot['owner_policy'] = {'excluded_card_numbers': excluded, 'duplicate_product_cards': len(paths)-len(set(paths))}
            blockers = []
            if excluded:
                blockers.append('OWNER_EXCLUDED_CREATIVE_PRODUCT')
            if len(set(paths)) != len(paths):
                blockers.append('DUPLICATE_PRODUCT_CARDS')
            if not review:
                blockers.append('EXACT_CREATIVE_PREVIEW_REVIEW_REQUIRED')
            if not env.get('SHOPIFY_WEBHOOK_SECRET') or not (env.get('PILOT_ATTRIBUTION_SECRET') or env.get('PILOT_ADMIN_KEY')):
                blockers.append('EXISTING_SIGNED_TRACKING_CONFIGURATION_REQUIRED')
            stage = 'landing_checkout'
            source_cards = cards + ([data] if data.get('link') and data.get('link') not in {r.get('link') for r in cards} else [])
            source_blockers = await self.sources(client, source_cards, campaign, str(ad['id']), pixel, now)
            blockers.extend(source_blockers)
            snapshot['site_diagnostics'] = getattr(self, 'site_diagnostics', [])
            snapshot['review_proposals'] = getattr(self, 'review_proposals', [])
            snapshot['technical_gates_passed'] = not any(b != 'EXACT_CREATIVE_PREVIEW_REVIEW_REQUIRED' for b in blockers)
            snapshot['creative_review_passed'] = bool(review)
            snapshot['tracking_configuration_verified'] = not source_blockers and not any(b == 'EXISTING_SIGNED_TRACKING_CONFIGURATION_REQUIRED' for b in blockers)
            if blockers:
                return {**await pause('READINESS_GATES_NOT_PASSED'), 'blockers': blockers}
            if env.get('PILOT_LAUNCH_POLICY') != POLICY or env.get('PILOT_FIRST_PURCHASE_TEST_AUTHORIZED') != 'true' or env.get('PILOT_FIRST_PURCHASE_ACTIVATION_ENABLED') != 'true' or live_ads_dry_run(env) or env.get('ALLOW_MICRO_BUDGET') != 'true' or configured_daily_budget_limit_eur(env) != 5:
                return await pause('EXPLICIT_BOUNDED_ACTIVATION_SWITCHES_REQUIRED')
            if not native_lifetime:
                stage = 'provider_native_daily_and_total_cap'
                # Daily budget alone can overdeliver. A native cumulative campaign cap
                # limits this Berlin day's additional spend, never above EUR35 total.
                # Tomorrow's pre-authorized EUR5 allowance is not a daily-budget increase.
                envelope = self.store.envelope(spends['maximum'], spends['today'], now)
                snapshot['native_spend_envelope'] = envelope
                target_cap = envelope['cap_cents']
                cap = Decimal(str(remote.get('spend_cap') or '0'))
                if not cap.is_finite() or cap < 0 or cap != int(cap):
                    return await pause('PROVIDER_SPEND_CAP_INVALID')
                may_release_next_day = cap < target_cap and self.store.previous_envelope_confirmed(int(cap), envelope['day'])
                if cap == 0 or cap > target_cap or may_release_next_day:
                    response = await client.post(base + campaign, headers=headers, data={'spend_cap': str(target_cap)})
                    response.raise_for_status()
                    confirmed = await get(campaign, 'id,spend_cap,status')
                    if str(confirmed.get('spend_cap')) != str(target_cap):
                        return await pause('PROVIDER_DAILY_AND_TOTAL_CAP_NOT_CONFIRMED')
                    self.store.confirm_envelope(envelope['day'], target_cap)
                    snapshot['native_spend_cap_readback_cents'] = target_cap
                elif cap == target_cap:
                    self.store.confirm_envelope(envelope['day'], target_cap)
                    snapshot['native_spend_cap_readback_cents'] = int(cap)
                else:
                    snapshot['native_spend_cap_readback_cents'] = int(cap)
                    if Decimal(spends['maximum'])*100 >= cap:
                        return await pause('EXISTING_LOWER_TOTAL_CAP_REACHED', latch=True)
            if remote.get('status') == 'ACTIVE':
                if consent['state'] == 'activation_intent':
                    updated = instant(remote['updated_time'])
                    if updated < instant(consent['activation_intent_at']) - timedelta(seconds=60):
                        return await pause('ACTIVATION_TIME_UNCONFIRMED')
                    consent = self.store.activated(updated)
                if consent['state'] != 'active':
                    return await pause('UNRECORDED_PRIOR_ACTIVATION')
                return {**snapshot, 'status': 'active_confirmed', 'consent': consent}
            if remote.get('status') != 'PAUSED':
                return await pause('CAMPAIGN_NOT_RESUMABLE')
            stage = 'activation'
            consent = self.store.intent(now, end)
            # Children are resumed only after every creative/source/tracking gate passed.
            for object_id, status in [(str(adset['id']), adset.get('status')), (str(ad['id']), ad.get('status'))]:
                if status != 'ACTIVE':
                    reply = await client.post(base + object_id, headers=headers, data={'status': 'ACTIVE'})
                    reply.raise_for_status()
                    if reply.json().get('success') is not True:
                        raise ValueError('CHILD_ACTIVATION_UNCONFIRMED')
            response = await client.post(base + campaign, headers=headers, data={'status': 'ACTIVE'})
            response.raise_for_status()
            if response.json().get('success') is not True:
                raise ValueError('ACTIVATION_UNCONFIRMED')
            observed = await get(campaign, 'id,status,effective_status,updated_time')
            if observed.get('status') != 'ACTIVE':
                raise ValueError('ACTIVATION_NOT_READ_BACK')
            consent = self.store.activated(instant(observed['updated_time']))
            ad_readback = await get(str(ad['id']), 'id,status,effective_status,creative{id}')
            snapshot['ad_effective_status'] = ad_readback.get('effective_status')
            if str(ad_readback.get('id')) != str(ad['id']) or str((ad_readback.get('creative') or {}).get('id')) != creative_id:
                return await pause('ACTIVATED_AD_IDENTITY_READBACK_MISMATCH')
            return {**snapshot, 'status': 'active_confirmed', 'activation_performed': True,
                    'effective_status': observed.get('effective_status'), 'consent': consent}
        except asyncio.CancelledError:
            await asyncio.shield(pause('CONTROLLER_INTERRUPTED'))
            raise
        except Exception as exc:
            detail = {'stage': stage, 'error_type': type(exc).__name__}
            if isinstance(exc, httpx.HTTPStatusError):
                detail['http_status'] = exc.response.status_code
                try:
                    error = exc.response.json().get('error', {})
                    detail.update({k: error[k] for k in ('code', 'error_subcode') if type(error.get(k)) is int})
                    if error.get('code') in {4, 17, 32, 613, 80004}:
                        self.store.defer_provider(campaign, 'META_API_RATE_LIMIT_BACKOFF', now, 900)
                    elif error.get('code') == 100 and error.get('error_subcode') == 2446307:
                        self.store.defer_provider(campaign, 'META_NATIVE_CAP_MINIMUM_EXCEEDS_AUTHORIZATION', now, 21600)
                    elif (error.get('code') == 100 and error.get('error_subcode') == 1885058
                          and stage == 'paused_native_100eur_cap_fallback'):
                        # Meta rejected the fallback cap. Stop the minute-by-minute
                        # retry loop and retain a sanitized provider explanation.
                        self.store.defer_provider(campaign, 'META_NATIVE_100EUR_CAP_FALLBACK_REJECTED', now, 21600)
                    if error.get('code') == 100 and stage in {'paused_native_cap_preparation', 'paused_native_lifetime_budget_preparation', 'paused_native_100eur_cap_fallback'}:
                        # Parameter errors may explain a provider minimum. Keep
                        # bounded human labels only, never payloads/URLs/credentials.
                        for key in ('error_user_title', 'error_user_msg', 'message'):
                            value = error.get(key)
                            if isinstance(value, str):
                                value = re.sub(r'https?://\S+|\b[A-Za-z0-9_-]{40,}\b|\bEA[A-Za-z0-9]{15,}\b|sk-[A-Za-z0-9_-]+', '[redacted]', value)
                                detail[key] = value[:800]
                except (ValueError, TypeError, AttributeError):
                    pass
            try:
                return {**await pause('ACQUISITION_READINESS_OR_CONTROL_FAILED'), **detail}
            except Exception:
                # A failed redundant pause write is not evidence the campaign
                # became active. Obtain independent provider status readback.
                try:
                    observed = await get(campaign, 'id,status,effective_status')
                    if observed.get('status') == 'PAUSED':
                        return {**snapshot, 'status': 'paused_confirmed', 'effective_status': observed.get('effective_status'),
                                'reason': 'ACQUISITION_READINESS_OR_CONTROL_FAILED', 'pause_write_failed': True,
                                'consent': self.store.read(), **detail}
                except Exception:
                    pass
                return {**snapshot, 'status': 'pause_unconfirmed', 'reason': 'ACQUISITION_FAIL_CLOSED_PAUSE_UNCONFIRMED', **detail}
        finally:
            if self.client is None:
                await client.aclose()

    async def sources(self, client, cards, campaign, ad, pixel, now):
        env = self.env
        feed_url = env.get('HOMESTRO_PRODUCT_FEED_URL', '')
        host = urlsplit(feed_url)
        if host.scheme != 'https' or host.hostname not in {'homestro.de', 'www.homestro.de', 'homestro-ai-api-fixed-current-production.up.railway.app'} or host.username or host.password:
            return ['CURRENT_VALIDATED_FEED_REQUIRED']
        response = await client.get(feed_url)
        response.raise_for_status()
        if len(response.content) > 12 * 1024 * 1024:
            return ['CURRENT_FEED_SIZE_LIMIT']
        feed = ProductFeedManager().parse(response.content, response.headers.get('content-type'))
        from .payment_webhooks import PaymentWebhookStore, payment_database
        from .product_selection import read_cost_candidates
        from .website_ads import owner_excluded, product_path

        self.review_proposals = []
        try:
            candidates, _ = read_cost_candidates(PaymentWebhookStore(payment_database(env)), [p.model_dump(mode='json') for p in feed.products], now=now)
            # Prefer simple household/travel products for review; no new media/object is made.
            candidates.sort(key=lambda p: (bool(re.search(r'lenovo|bluetooth|kopfhörer|headphone', p['title'], re.I)), p['title']))
            seen = set()
            for candidate in candidates:
                if owner_excluded(candidate) or product_path(candidate['link']) in seen:
                    continue
                seen.add(product_path(candidate['link']))
                self.review_proposals.append({'source_id': candidate['id'], 'title': candidate['title'],
                    'image_url': candidate['image_link'], 'product_url': candidate['link'], 'price_eur': str(candidate['price']),
                    'german_copy': candidate['title']+': Details, Varianten und aktuelle Preise findest du bei Homestro.',
                    'existing_source_media': True, 'draft_only': True, 'requires_exact_review': True, 'creative_created': False})
                if len(self.review_proposals) == 3:
                    break
        except Exception:
            pass  # Missing cost evidence never invents a proposal or blocks existing valid-source reads.
        blockers = []
        runtime_pixel_checked, runtime_pixel_verified = False, False
        self.site_diagnostics = []
        if not isinstance(cards, list) or not 1 <= len(cards) <= 11:
            return ['CREATIVE_CARD_SCOPE_INVALID']
        for card in cards:
            url = urlsplit(str(card.get('link') or ''))
            if url.scheme != 'https' or url.hostname not in {'homestro.de', 'www.homestro.de'} or url.username or url.password:
                blockers.append('CREATIVE_DESTINATION_NOT_OWN_STORE')
                continue
            matches = [p for p in feed.products if urlsplit(p.link).path.rstrip('/') == url.path.rstrip('/') and p.availability == 'in_stock']
            if matches and any(owner_excluded(p.model_dump(mode='json')) for p in matches):
                blockers.append('OWNER_EXCLUDED_CREATIVE_PRODUCT')
            if not matches:
                blockers.append('CREATIVE_SOURCE_NOT_CURRENT_IN_STOCK')
                continue
            if card.get('picture') and card['picture'] not in {p.image_link for p in matches}:
                blockers.append('CREATIVE_IMAGE_NOT_CURRENT_SOURCE')
            tag = parse_qs(url.query).get('pilot_ref', [None])[0]
            ref = decode_ref(tag, secret=env.get('PILOT_ATTRIBUTION_SECRET') or env.get('PILOT_ADMIN_KEY', ''), at=now)
            if not ref or ref['channel'] != 'meta' or ref['campaign'] != campaign or ref['ad'] != ad:
                blockers.append('SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED')
            landing = await client.get(card['link'])
            if landing.status_code != 200 or len(landing.content) > 2 * 1024 * 1024 or '<form' not in landing.text or '/cart/add' not in landing.text:
                blockers.append('LANDING_OR_ADD_TO_CART_NOT_AVAILABLE')
                continue
            configured_pixels = sorted(set(re.findall(r'"pixel_id"\s*:\s*"(\d{4,30})"', landing.text.replace('\\"', '"'))))
            diagnostic = {'product_path': url.path, 'landing_http_status': landing.status_code, 'pixel_in_initial_html': pixel in landing.text, 'configured_storefront_pixel_ids': configured_pixels, 'checkout_hops': []}
            self.site_diagnostics.append(diagnostic)
            if pixel not in landing.text and not runtime_pixel_verified:
                # Shopify app pixels may be deferred and absent from initial HTML.
                # Use the existing own-store publisher browser; do not invent an event.
                key = env.get('PILOT_ORGANIC_API_KEY')
                configured = False
                if key and not runtime_pixel_checked:
                    runtime_pixel_checked = True
                    probe = await client.post('https://homestro-ai-api-fixed-current-production.up.railway.app/api/marketing/v2/tracking/site-check',
                        headers={'Authorization': 'Bearer '+key}, json={'url': card['link'], 'expectedPixelId': pixel}, timeout=httpx.Timeout(40, connect=5))
                    diagnostic['runtime_probe_http_status'] = probe.status_code
                    if probe.status_code == 200 and len(probe.content) <= 32768:
                        proof = probe.json()
                        configured = (proof.get('configured') is True and proof.get('expectedPixelId') == pixel
                            and proof.get('pixelBeaconsSuppressed') is True and proof.get('purchaseEventDelivered') is False)
                        diagnostic['observed_pixel_ids'] = proof.get('observedPixelIds', [])
                        runtime_pixel_verified = configured
                if not configured:
                    blockers.append('STOREFRONT_PIXEL_ID_MISMATCH' if configured_pixels and pixel not in configured_pixels else 'STOREFRONT_PIXEL_CONFIGURATION_NOT_OBSERVED')
            variant = next((parse_qs(urlsplit(p.link).query).get('variant', [None])[0] for p in matches if parse_qs(urlsplit(p.link).query).get('variant')), None)
            if not variant or not re.fullmatch(r'\d+', variant):
                blockers.append('CHECKOUT_VARIANT_NOT_IDENTIFIED')
                continue
            # Anonymous cart permalink performs no order/payment; retain no checkout token or customer data.
            current = 'https://homestro.de/cart/' + variant + ':1?checkout&source=pilot_readiness_probe'
            shop = env.get('SHOPIFY_STORE_DOMAIN', '').removeprefix('https://').rstrip('/')
            allowed_hosts = {'homestro.de', 'www.homestro.de', 'checkout.shopify.com', 'shop.app'}
            if re.fullmatch(r'[a-zA-Z0-9-]+\.myshopify\.com', shop):
                allowed_hosts.add(shop)
            checkout_ok = False
            checkout_failure = 'REAL_CHECKOUT_REDIRECT_NOT_VERIFIED'
            for _ in range(8):
                checkout = await client.get(current, follow_redirects=False, headers={'User-Agent': 'HomestroReadinessProbe/1.0'})
                target = urlsplit(current)
                diagnostic['checkout_hops'].append({'host': target.hostname, 'status': checkout.status_code, 'kind': 'checkout' if '/checkout' in target.path else 'cart' if '/cart' in target.path else 'other'})
                if '/checkout' in target.path:
                    checkout_failure = 'REAL_CHECKOUT_PAGE_NOT_AVAILABLE'
                if checkout.status_code == 200:
                    checkout_ok = (len(checkout.content) <= 2*1024*1024 and '/checkout' in target.path
                        and 'checkout' in checkout.text.lower())
                    break
                if checkout.status_code not in {301, 302, 303, 307, 308}:
                    break
                target = urlsplit(urljoin(current, checkout.headers.get('location', '')))
                if target.scheme != 'https' or target.hostname not in allowed_hosts or target.username or target.password or target.port not in (None, 443) or (target.hostname == 'shop.app' and not target.path.startswith('/checkout/')):
                    diagnostic['checkout_rejected_redirect'] = {'host': target.hostname, 'scheme': target.scheme, 'reason': 'UNTRUSTED_CHECKOUT_REDIRECT'}
                    break
                current = target.geturl()
            if not checkout_ok:
                blockers.append(checkout_failure)
        return sorted(set(blockers))
