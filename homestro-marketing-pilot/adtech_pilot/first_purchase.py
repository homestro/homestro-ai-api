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
from typing import Any
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from zoneinfo import ZoneInfo

import httpx

from .feed_manager import ProductFeedManager
from .micro_budget import configured_daily_budget_limit_eur, live_ads_dry_run
from .order_economics import decode_ref, instant, tracked_url, tracking_ref

POLICY = 'first_purchase_acquisition_test'
AUTHORIZATION = 'homestro-DE-AT-5EUR-day-35EUR-7days-owner-20261027'
STOPPED_CLAIMS = {'STOPPED_TEST_BUDGET', 'STOPPED_PERFORMANCE', 'STOPPED_OWNER', 'STOPPED_TEST_EXPIRED'}
RETIRED_ARCHIVED_CAMPAIGN_ID = '120254444566440274'


def _shopify_variant_key(value):
    """Return a numeric Shopify variant key from known Shopify feed/API IDs."""
    text = str(value or '').strip()
    match = re.fullmatch(r'(?:gid://shopify/ProductVariant/|gid-shopify-ProductVariant-)(\d+)', text)
    if match:
        return match.group(1)
    if re.fullmatch(r'\d+', text):
        return text
    # Shopify's Meta channel retailer_id format binds product and variant IDs.
    match = re.fullmatch(r'shopify_[A-Z]{2}_\d+_(\d+)', text)
    return match.group(1) if match else None


def _catalog_available(item):
    # ProductItem.review_status is deprecated by Meta and is returned empty.
    # Use availability for catalog-set membership; approval is tracked separately.
    availability = str(item.get('availability') or '').strip().casefold().replace(' ', '_')
    return availability == 'in_stock'


def _catalog_tracking_tags_valid(value, ref, campaign, ad, end):
    if not ref or ref.get('channel') != 'meta' or ref.get('campaign') != campaign or ref.get('ad') != ad:
        return False
    try:
        if instant(ref['expires']) < end:
            return False
    except (KeyError, ValueError, TypeError):
        return False
    tags = parse_qs(str(value or ''), keep_blank_values=True)
    return (len(tags.get('pilot_ref', [])) == 1
            and tags.get('utm_source') == ['meta']
            and tags.get('utm_medium') == ['paid_social']
            and campaign in tags.get('utm_campaign', [])
            and ad in tags.get('utm_content', []))


def _catalog_link_template_valid(value):
    """Accept a safe Homestro fallback or Meta's dynamic product URL macro."""
    text = str(value or '').strip()
    if not text or len(text) > 2048 or any(ord(char) < 0x21 for char in text):
        return False
    if text == '{{product.url}}' or re.fullmatch(r'\{\{product\.url\}\}\?[A-Za-z0-9_=&%.-]{1,512}', text):
        return True
    if re.search(r'\{\{[^{}]{1,80}\}\}', text):
        text = re.sub(r'\{\{(?:product\.(?:url|link|id|name|description)|campaign\.id|ad\.id|adset\.id|site_source_name)\}\}', 'x', text)
        if '{{' in text or '}}' in text:
            return False
    parsed = urlsplit(text)
    return (parsed.scheme == 'https' and parsed.hostname in {'homestro.de', 'www.homestro.de'}
            and not parsed.username and not parsed.password and parsed.port in (None, 443))


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
            # Retire only the exact owner-identified archived campaign from
            # operational state. Keep append-only audit history intact.
            if db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta_micro_campaign_claim'"
            ).fetchone():
                db.execute(
                    'DELETE FROM meta_micro_campaign_claim WHERE slot=? AND campaign_id=?',
                    ('single_live_meta_campaign', RETIRED_ARCHIVED_CAMPAIGN_ID),
                )
            db.execute(
                'DELETE FROM pilot_first_purchase_consent WHERE singleton=1 AND campaign=?',
                (RETIRED_ARCHIVED_CAMPAIGN_ID,),
            )
            db.execute(
                'DELETE FROM pilot_first_purchase_backoff WHERE campaign=?',
                (RETIRED_ARCHIVED_CAMPAIGN_ID,),
            )

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

    def authorize(self, campaign, now, *, catalog_feed_authorized=False):
        terms = {'markets': ['DE', 'AT'], 'daily_eur': '5.00', 'total_eur': '35.00', 'days': 7,
                 'automatic_increase': False, 'starts_at_actual_activation': True,
                 'new_paid_generation_authorized': bool(catalog_feed_authorized),
                 'unseen_creatives_authorized': bool(catalog_feed_authorized),
                 'source': 'explicit_owner_voice_catalog_authorization_20261101' if catalog_feed_authorized else 'explicit_owner_voice_authorization_20261027'}
        encoded_terms = json.dumps(terms, sort_keys=True)
        with closing(self.audit._connect()) as db, db:
            db.execute('INSERT INTO pilot_first_purchase_consent(singleton,authorization,campaign,terms,state,authorized_at) '
                       'VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO NOTHING',
                       (AUTHORIZATION, campaign, encoded_terms, 'authorized', now.isoformat()))
            row = db.execute('SELECT campaign,terms FROM pilot_first_purchase_consent WHERE singleton=1').fetchone()
            if not row or row[0] != campaign:
                raise ValueError('PERSISTED_CONSENT_SCOPE_MISMATCH')
            if row[1] != encoded_terms:
                old = json.loads(row[1])
                same_caps = (old.get('markets') == ['DE', 'AT'] and old.get('daily_eur') == '5.00'
                             and old.get('total_eur') == '35.00' and old.get('days') == 7
                             and old.get('automatic_increase') is False)
                if not catalog_feed_authorized or not same_caps:
                    raise ValueError('PERSISTED_CONSENT_SCOPE_MISMATCH')
                db.execute('UPDATE pilot_first_purchase_consent SET terms=? WHERE singleton=1 AND campaign=?',
                           (encoded_terms, campaign))
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

    def record_owner_activation(self, at, remote_end):
        """Record an owner-started activation after Meta status and spend gates pass."""
        deadline = min(at + timedelta(days=7), remote_end)
        with closing(self.audit._connect()) as db, db:
            db.execute(
                "UPDATE pilot_first_purchase_consent "
                "SET state='active',activation_intent_at=?,activated_at=?,expires_at=? "
                "WHERE singleton=1 AND state='authorized'",
                (at.isoformat(), at.isoformat(), deadline.isoformat()),
            )
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
            return {
                'status': 'blocked',
                'reason': 'EXACT_OWNED_CAMPAIGN_SCOPE_REQUIRED',
                'activation_performed': False,
                'scope_campaign_id': scope if re.fullmatch(r'\d{4,30}', scope) else None,
                'owned_campaign_id': campaign or None,
                'owned_claim_status': (claim or {}).get('status'),
            }
        catalog_feed_authorized = (
            campaign == '120254564749740274'
            and scope == campaign
            and env.get('PILOT_CATALOG_AUTO_REVIEW_AUTHORIZED') == 'true'
        )
        consent = self.store.authorize(campaign, now, catalog_feed_authorized=catalog_feed_authorized)
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

        # Respect Meta's persisted cooldown before making even status reads.
        # This prevents the one-minute worker from extending a provider throttle.
        backoff = self.store.provider_backoff(campaign, now)
        restore_after_pilot_tracking_error = bool(
            campaign == '120254564749740274'
            and consent.get('state') in {'authorized', 'active'}
            and (
                (backoff and backoff.get('reason') == 'META_CATALOG_TRACKING_TAG_UPDATE_REJECTED')
                or (consent.get('state') == 'active' and not backoff)
            )
        )
        if backoff and not restore_after_pilot_tracking_error:
            return {
                **snapshot,
                'status': 'provider_backoff',
                'provider_reads_deferred': True,
                'provider_mutations_deferred': True,
                **backoff,
            }

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
            if backoff and not restore_after_pilot_tracking_error:
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
            timezone = await get(account, 'id,timezone_name,currency,spend_cap,amount_spent')
            # Owner-configured account-wide Meta spending limit is the hard native cap.
            # Never mutate campaign spend_cap: Meta rejects EUR35 as below its minimum.
            if timezone.get('currency') != 'EUR':
                return await pause('ACCOUNT_SPENDING_LIMIT_CURRENCY_UNVERIFIED')
            try:
                account_cap = Decimal(str(timezone.get('spend_cap')))
                account_spent = Decimal(str(timezone.get('amount_spent')))
            except (ValueError, TypeError, ArithmeticError):
                return await pause('ACCOUNT_SPENDING_LIMIT_UNVERIFIED')
            if (not account_cap.is_finite() or not account_spent.is_finite()
                    or account_cap != 3500 or account_spent < 0 or account_spent >= account_cap):
                return await pause('ACCOUNT_35EUR_LIMIT_NOT_CONFIRMED_OR_EXHAUSTED')
            snapshot['account_spend_cap_readback_cents'] = int(account_cap)
            snapshot['account_spend_remaining_cents'] = int(account_cap - account_spent)
            accessible_pixels = await get(account+'/adspixels', 'id,name,is_unavailable')
            snapshot['accessible_account_pixel_ids'] = [str(p['id']) for p in accessible_pixels.get('data', []) if p.get('id') and not p.get('is_unavailable')]
            if timezone.get('timezone_name') not in {'Europe/Berlin', 'Europe/Vienna'}:
                return await pause('DAILY_SPEND_REPORTING_TIMEZONE_NOT_DE_AT')
            stage = 'adset'
            adsets_result = await get(
                campaign + '/adsets',
                'id,campaign_id,status,effective_status,daily_budget,billing_event,lifetime_budget,start_time,end_time,targeting,promoted_object,optimization_goal,bid_strategy,destination_type',
            )
            adsets = adsets_result.get('data', [])
            if not isinstance(adsets, list) or not adsets:
                return await pause('OWNED_ADSETS_READ_INVALID')
            configured_set_id = env.get('META_PRODUCT_SET_ID', '').strip()
            if not re.fullmatch(r'\d{4,30}', configured_set_id):
                return await pause('META_PRODUCT_SET_ID_INVALID')
            catalog_check = await MetaPublisher(self.audit, env=env, client=client).check_catalog_access()
            if (catalog_check.get('status') != 'checked'
                    or str(catalog_check.get('product_set_id', '')) != configured_set_id):
                snapshot['catalog_check'] = catalog_check
                return await pause('META_ALL_PRODUCTS_SET_NOT_VERIFIED')
            catalog_set_id = configured_set_id
            matching_adsets = [
                row for row in adsets
                if str(((row.get('promoted_object') or {}).get('product_set_id') or '')) == catalog_set_id
            ]
            if len(matching_adsets) > 1:
                return await pause('MULTIPLE_CATALOG_REPLACEMENT_ADSETS_FOUND')

            if not matching_adsets:
                # Meta rejects changing promoted_object on an existing ad set
                # (1885090). Retire the owned old set and create a replacement
                # from the start with the verified catalog and pixel.
                if len(adsets) != 1:
                    return await pause('REPLACEMENT_SOURCE_ADSET_AMBIGUOUS')
                old_adset = adsets[0]
                old_adset_id = str(old_adset.get('id', ''))
                old_targeting = old_adset.get('targeting') or {}
                old_countries = set((old_targeting.get('geo_locations') or {}).get('countries') or [])
                old_promoted = old_adset.get('promoted_object') or {}
                if (
                    not re.fullmatch(r'\d{4,30}', old_adset_id)
                    or str(old_adset.get('campaign_id', campaign)) != campaign
                    or str(old_adset.get('daily_budget', '')) != '500'
                    or old_adset.get('lifetime_budget') not in (None, 0, '0')
                    or not {'DE', 'AT'}.issubset(old_countries)
                    or str(old_promoted.get('pixel_id', '')) != pixel
                    or old_adset.get('optimization_goal') != 'OFFSITE_CONVERSIONS'
                    or old_adset.get('billing_event') != 'IMPRESSIONS'
                ):
                    return await pause('REPLACEMENT_SOURCE_LIMITS_NOT_VERIFIED')
                source_ads = (await get(
                    old_adset_id + '/ads',
                    'id,campaign_id,adset_id,status,creative',
                )).get('data', [])
                if not isinstance(source_ads, list) or not source_ads:
                    return await pause('REPLACEMENT_SOURCE_ADS_READ_INVALID')
                catalog_sources = []
                for candidate_ad in source_ads:
                    candidate_ad_id = str(candidate_ad.get('id', ''))
                    candidate_creative_id = str((candidate_ad.get('creative') or {}).get('id', ''))
                    if (
                        not re.fullmatch(r'\d{4,30}', candidate_ad_id)
                        or not re.fullmatch(r'\d{4,30}', candidate_creative_id)
                        or str(candidate_ad.get('campaign_id', '')) != campaign
                        or str(candidate_ad.get('adset_id', '')) != old_adset_id
                    ):
                        continue
                    candidate_creative = await get(
                        candidate_creative_id, 'id,product_set_id,object_story_spec'
                    )
                    candidate_story = candidate_creative.get('object_story_spec') or {}
                    candidate_template = candidate_story.get('template_data')
                    if (
                        str(candidate_creative.get('product_set_id', '')) == catalog_set_id
                        and str(candidate_story.get('page_id', '')) == page
                        and isinstance(candidate_template, dict)
                        and '{{product.name}}' in str(candidate_template.get('name', ''))
                    ):
                        catalog_sources.append((candidate_ad, candidate_creative))
                if len(catalog_sources) != 1:
                    return await pause('REPLACEMENT_SOURCE_CATALOG_AD_NOT_UNIQUE')
                source_ad, source_creative = catalog_sources[0]
                source_ad_id = str(source_ad.get('id', ''))
                source_creative_id = str((source_ad.get('creative') or {}).get('id', ''))
                source_story = source_creative.get('object_story_spec') or {}

                # Pause existing child ad and set before creating the replacement.
                if str(source_ad.get('status', '')).upper() != 'PAUSED':
                    stage = 'old_ad_pause'
                    old_ad_pause = await client.post(
                        base + source_ad_id, headers=headers, data={'status': 'PAUSED'}
                    )
                    old_ad_pause.raise_for_status()
                    if old_ad_pause.json().get('success') is not True:
                        return await pause('OLD_AD_PAUSE_NOT_ACKNOWLEDGED')
                    old_ad_readback = await get(source_ad_id, 'id,status')
                    if str(old_ad_readback.get('status', '')).upper() != 'PAUSED':
                        return await pause('OLD_AD_PAUSE_NOT_CONFIRMED')
                if str(old_adset.get('status', '')).upper() != 'PAUSED':
                    stage = 'old_adset_pause'
                    old_set_pause = await client.post(
                        base + old_adset_id, headers=headers, data={'status': 'PAUSED'}
                    )
                    old_set_pause.raise_for_status()
                    if old_set_pause.json().get('success') is not True:
                        return await pause('OLD_ADSET_PAUSE_NOT_ACKNOWLEDGED')
                    old_set_readback = await get(old_adset_id, 'id,status')
                    if str(old_set_readback.get('status', '')).upper() != 'PAUSED':
                        return await pause('OLD_ADSET_PAUSE_NOT_CONFIRMED')

                replacement_targeting = json.loads(json.dumps(old_targeting))
                replacement_targeting['publisher_platforms'] = ['facebook']
                replacement_targeting.pop('instagram_positions', None)
                replacement_targeting.pop('messenger_positions', None)
                replacement_targeting.pop('audience_network_positions', None)
                start_time = now.astimezone(UTC).isoformat()
                end_time = (now.astimezone(UTC) + timedelta(days=7)).isoformat()
                replacement_payload = {
                    'name': 'Homestro All Products // DE-AT // Replacement',
                    'campaign_id': campaign,
                    'daily_budget': '500',
                    'billing_event': 'IMPRESSIONS',
                    'optimization_goal': 'OFFSITE_CONVERSIONS',
                    'destination_type': old_adset.get('destination_type') or 'WEBSITE',
                    'promoted_object': json.dumps({
                        'pixel_id': pixel,
                        'custom_event_type': 'PURCHASE',
                        'product_set_id': catalog_set_id,
                    }),
                    'targeting': json.dumps(replacement_targeting),
                    'start_time': start_time,
                    'end_time': end_time,
                    'status': 'PAUSED',
                }
                if old_adset.get('bid_strategy'):
                    replacement_payload['bid_strategy'] = old_adset['bid_strategy']
                stage = 'replacement_adset_create'
                replacement_response = await client.post(
                    base + account + '/adsets', headers=headers, data=replacement_payload
                )
                replacement_response.raise_for_status()
                replacement_data = replacement_response.json()
                replacement_id = str(replacement_data.get('id', ''))
                if not re.fullmatch(r'\d{4,30}', replacement_id):
                    return await pause('REPLACEMENT_ADSET_ID_MISSING')
                replacement_readback = await get(
                    replacement_id,
                    'id,campaign_id,status,daily_budget,billing_event,optimization_goal,start_time,end_time,targeting,promoted_object',
                )
                replacement_promoted = replacement_readback.get('promoted_object') or {}
                replacement_geo = ((replacement_readback.get('targeting') or {}).get('geo_locations') or {}).get('countries') or []
                if (
                    str(replacement_readback.get('id', '')) != replacement_id
                    or str(replacement_readback.get('campaign_id', '')) != campaign
                    or str(replacement_readback.get('status', '')).upper() != 'PAUSED'
                    or str(replacement_readback.get('daily_budget', '')) != '500'
                    or replacement_readback.get('billing_event') != 'IMPRESSIONS'
                    or replacement_readback.get('optimization_goal') != 'OFFSITE_CONVERSIONS'
                    or str(replacement_promoted.get('pixel_id', '')) != pixel
                    or replacement_promoted.get('custom_event_type') != 'PURCHASE'
                    or str(replacement_promoted.get('product_set_id', '')) != catalog_set_id
                    or not {'DE', 'AT'}.issubset(set(replacement_geo))
                ):
                    snapshot.update(replacement_adset_id=replacement_id, writes_performed=True)
                    return await pause('REPLACEMENT_ADSET_READBACK_MISMATCH')

                # Reuse the already owned catalog creative; do not generate or
                # duplicate creative media.
                stage = 'replacement_ad_create'
                new_ad_response = await client.post(
                    base + account + '/ads',
                    headers=headers,
                    data={
                        'name': 'Homestro All Products Catalog Ad',
                        'adset_id': replacement_id,
                        'creative': json.dumps({'creative_id': source_creative_id}),
                        'status': 'PAUSED',
                    },
                )
                new_ad_response.raise_for_status()
                new_ad_id = str(new_ad_response.json().get('id', ''))
                if not re.fullmatch(r'\d{4,30}', new_ad_id):
                    snapshot.update(replacement_adset_id=replacement_id, writes_performed=True)
                    return await pause('REPLACEMENT_AD_ID_MISSING')
                new_ad_readback = await get(
                    new_ad_id, 'id,campaign_id,adset_id,status,creative'
                )
                if (
                    str(new_ad_readback.get('id', '')) != new_ad_id
                    or str(new_ad_readback.get('campaign_id', '')) != campaign
                    or str(new_ad_readback.get('adset_id', '')) != replacement_id
                    or str(new_ad_readback.get('status', '')).upper() != 'PAUSED'
                    or str((new_ad_readback.get('creative') or {}).get('id', '')) != source_creative_id
                ):
                    snapshot.update(replacement_adset_id=replacement_id, replacement_ad_id=new_ad_id, writes_performed=True)
                    return await pause('REPLACEMENT_AD_READBACK_MISMATCH')
                snapshot.update(
                    replacement_adset_id=replacement_id,
                    replacement_ad_id=new_ad_id,
                    replacement_created=True,
                    writes_performed=True,
                )
                adsets = [replacement_readback]

            else:
                adset = matching_adsets[0]
                # Retire any old ad sets left in this owned campaign.
                for stale_adset in adsets:
                    if str(stale_adset.get('id', '')) == str(adset.get('id', '')):
                        continue
                    stale_id = str(stale_adset.get('id', ''))
                    if not re.fullmatch(r'\d{4,30}', stale_id):
                        return await pause('STALE_ADSET_ID_INVALID')
                    if str(stale_adset.get('status', '')).upper() != 'PAUSED':
                        stale_pause = await client.post(
                            base + stale_id, headers=headers, data={'status': 'PAUSED'}
                        )
                        stale_pause.raise_for_status()
                        if stale_pause.json().get('success') is not True:
                            return await pause('STALE_ADSET_PAUSE_NOT_ACKNOWLEDGED')
                        stale_readback = await get(stale_id, 'id,status')
                        if str(stale_readback.get('status', '')).upper() != 'PAUSED':
                            return await pause('STALE_ADSET_PAUSE_NOT_CONFIRMED')
                adsets = [adset]

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
            snapshot['pixel_validation'] = {
                'expected_pixel_id': pixel if re.fullmatch(r'\d{4,30}', pixel) else None,
                'adset_promoted_pixel_id': str(promoted.get('pixel_id', '')) or None,
                'matches': str(promoted.get('pixel_id')) == pixel and bool(re.fullmatch(r'\d{4,30}', pixel)),
            }
            if (not snapshot['pixel_validation']['matches']
                    or promoted.get('custom_event_type') != 'PURCHASE'
                    or adset.get('optimization_goal') != 'OFFSITE_CONVERSIONS'):
                return await pause('PURCHASE_TRACKING_CONFIGURATION_NOT_VERIFIED')
            # Prepare a restrictive native cap while already paused, even when
            # creative/site review is outstanding. Discover provider rejection
            # before asking the owner to review. Never release a prior lower cap here.
            # Verified account-wide EUR35 cap replaces rejected campaign spend_cap writes.
            snapshot['native_budget_mode'] = 'verified_account_wide_35eur_cap'
            if native_lifetime:
                snapshot['native_budget_mode'] = 'frozen_remaining_whole_test_allowance_no_daily_refill'
                snapshot['native_adset_lifetime_budget_readback_cents'] = frozen_lifetime_cap
                snapshot['observed_limits']['lifetime_budget_cents'] = str(frozen_lifetime_cap)
                if Decimal(spends['maximum'])*100 >= frozen_lifetime_cap:
                    return await pause('FROZEN_LIFETIME_TEST_CAP_REACHED', latch=True)
            stage = 'creative'
            ads = (await get(str(adset['id']) + '/ads', 'id,status,effective_status,creative{id},ad_review_feedback,url_tags')).get('data', [])
            if not isinstance(ads, list) or not ads:
                return await pause('EXISTING_ADS_NOT_FOUND')
            catalog_ads = []
            reviewed_candidates = []
            for candidate in ads:
                if candidate.get('ad_review_feedback') or candidate.get('effective_status') not in {'ACTIVE', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PAUSED'}:
                    continue
                candidate_creative_id = str((candidate.get('creative') or {}).get('id', ''))
                if not re.fullmatch(r'\d{4,30}', str(candidate.get('id'))) or not re.fullmatch(r'\d{4,30}', candidate_creative_id):
                    continue
                candidate_creative = await get(candidate_creative_id, 'id,object_story_spec,product_set_id')
                candidate_story = candidate_creative.get('object_story_spec') or {}
                if (str(candidate_story.get('page_id')) == page and candidate_creative.get('product_set_id')
                        and isinstance(candidate_story.get('template_data'), dict)):
                    catalog_ads.append((candidate, candidate_creative, candidate_story))
                elif (str(candidate_story.get('page_id')) == page and isinstance(candidate_story.get('link_data'), dict)):
                    reviewed_candidates.append((candidate, candidate_creative, candidate_story))
            is_catalog_ad = len(catalog_ads) == 1
            if is_catalog_ad:
                ad, creative, story = catalog_ads[0]
            elif not catalog_ads and len(ads) == 1 and len(reviewed_candidates) == 1:
                ad, creative, story = reviewed_candidates[0]
            else:
                snapshot['ad_eligibility_diagnostic'] = {'ads_count': len(ads), 'catalog_ads_count': len(catalog_ads)}
                return await pause('EXACT_CATALOG_AD_IDENTITY_REQUIRED')
            if not all(re.fullmatch(r'\d{4,30}', str(value)) for value in (ad['id'], (ad.get('creative') or {}).get('id'))):
                return await pause('AD_OR_CREATIVE_ID_NOT_VERIFIED')
            creative_id = str((ad.get('creative') or {}).get('id'))
            if str(story.get('page_id')) != page:
                return await pause('EXISTING_CREATIVE_PAGE_IDENTITY_UNVERIFIED')
            if is_catalog_ad and not isinstance(story.get('template_data'), dict):
                return await pause('CATALOG_CREATIVE_TEMPLATE_UNVERIFIED')
            if is_catalog_ad:
                template = story['template_data']
                name_mapping = '{{product.name}}' in str(template.get('name', ''))
                description_mapping = '{{product.description}}' in str(template.get('description', ''))
                link_template_valid = _catalog_link_template_valid(template.get('link'))
                snapshot['dynamic_template_validation'] = {
                    'template_data_used': True,
                    'product_name_mapped': name_mapping,
                    'product_description_mapped': description_mapping,
                    'description_optional': True,
                    'dynamic_catalog_link_supported': link_template_valid,
                    'static_preview_checks_skipped': True,
                }
                if not name_mapping:
                    return await pause('CATALOG_PRODUCT_NAME_TEMPLATE_NOT_MAPPED')
                if not link_template_valid:
                    return await pause('CATALOG_DYNAMIC_LINK_TEMPLATE_INVALID')
            if not is_catalog_ad and not isinstance(story.get('link_data'), dict):
                return await pause('EXISTING_CREATIVE_WEBSITE_DESTINATION_UNVERIFIED')
            revision = hashlib.sha256(json.dumps(story, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            data = story['template_data'] if is_catalog_ad else story['link_data']
            cards = data.get('child_attachments') or [data]
            if not isinstance(cards, list) or not 1 <= len(cards) <= 10:
                return await pause('CREATIVE_CARD_SCOPE_INVALID')
            snapshot.update(ad_id=str(ad['id']), ad_status=ad.get('status'), ad_effective_status=ad.get('effective_status'), creative_id=creative_id, creative_revision=revision,
                            creative_preview={'message': data.get('message'), 'product_set_id': creative.get('product_set_id'), 'cards': [{'title': r.get('name'), 'image': r.get('picture'), 'destination': r.get('link', '').split('?')[0]} for r in cards]})
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
            terms = json.loads(consent.get('terms') or '{}')
            if is_catalog_ad and catalog_feed_authorized and terms.get('unseen_creatives_authorized') is True:
                review = 'owner_authorized_all_products_catalog_feed'
            snapshot['creative_review_basis'] = review
            from .website_ads import owner_excluded, product_path

            paths = [product_path(row.get('link', '')) for row in cards] if not is_catalog_ad else []
            excluded = [i+1 for i, row in enumerate(cards) if owner_excluded(row)] if not is_catalog_ad else []
            snapshot['owner_policy'] = {'excluded_card_numbers': excluded, 'duplicate_product_cards': len(paths)-len(set(paths)),
                                        'catalog_items_checked_from_live_feed': is_catalog_ad}
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
            catalog_url_tags = str(ad.get('url_tags') or '')
            catalog_ref = None
            if is_catalog_ad:
                secret = env.get('PILOT_ATTRIBUTION_SECRET') or env.get('PILOT_ADMIN_KEY', '')
                tag_values = parse_qs(catalog_url_tags, keep_blank_values=True).get('pilot_ref', [])
                catalog_ref = (decode_ref(tag_values[0], secret=secret, at=now)
                               if len(tag_values) == 1 else None)
                ref_covers_test = _catalog_tracking_tags_valid(
                    catalog_url_tags, catalog_ref, campaign, str(ad['id']), end)
                # Meta rejects url_tags on this dynamic catalog ad (Graph API 400).
                # Never mutate the owner campaign's creative for pilot attribution.
                if not ref_covers_test:
                    blockers.append('SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED')
            allow_untracked_active_catalog = bool(is_catalog_ad and remote.get('status') == 'ACTIVE')
            source_blockers = await self.sources(client, source_cards, campaign, str(ad['id']), pixel, now,
                                                 dynamic_catalog=is_catalog_ad, url_tags=catalog_url_tags,
                                                 allow_untracked_catalog=allow_untracked_active_catalog)
            blockers.extend(source_blockers)
            if allow_untracked_active_catalog and 'SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED' in blockers:
                # The owner already started this exact, bounded campaign in Meta.
                # Keep validating feed, landing, pixel and checkout, but do not
                # pause a live catalog solely because Meta rejected url_tags.
                blockers = [b for b in blockers if b != 'SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED']
                snapshot['catalog_tracking'] = {
                    'url_tags_readback_confirmed': False,
                    'pilot_attribution_verified': False,
                    'active_owner_campaign_kept_live': True,
                    'reason': 'META_REJECTED_CATALOG_URL_TAG_WRITE',
                }
            if is_catalog_ad and getattr(self, 'catalog_feed_identity_validation', None):
                snapshot['catalog_feed_identity_validation'] = self.catalog_feed_identity_validation
            if is_catalog_ad:
                creative_set_id = str(creative.get('product_set_id', ''))
                adset_set_id = str(promoted.get('product_set_id', ''))
                configured_set_id = env.get('META_PRODUCT_SET_ID', '').strip()
                snapshot['catalog_validation'] = {
                    'creative_product_set_id': creative_set_id or None,
                    'adset_promoted_product_set_id': adset_set_id or None,
                    'configured_product_set_id': configured_set_id or None,
                    'ids_match': bool(creative_set_id and creative_set_id == adset_set_id
                                      and (not configured_set_id or configured_set_id == creative_set_id)),
                }
                if (not re.fullmatch(r'\d{4,30}', creative_set_id)
                        or creative_set_id != adset_set_id
                        or (configured_set_id and configured_set_id != creative_set_id)):
                    blockers.append('CATALOG_PRODUCT_SET_ID_MISMATCH')
                else:
                    set_readback = await get(creative_set_id, 'id,name,product_count,filter')
                    raw_filter = set_readback.get('filter')
                    if isinstance(raw_filter, str) and raw_filter.strip():
                        try:
                            raw_filter = json.loads(raw_filter)
                        except ValueError:
                            raw_filter = '__invalid_filter__'
                    try:
                        set_product_count = int(str(set_readback.get('product_count', '0')))
                    except (TypeError, ValueError):
                        set_product_count = 0
                    feed_count = getattr(self, 'feed_product_count', None)
                    feed_variants = getattr(self, 'feed_in_stock_variant_keys', None)
                    set_members = []
                    cursor = None
                    membership_complete = True
                    seen_cursors = set()
                    for _ in range(20):
                        params = {'fields': 'id,retailer_id,availability,name,url', 'limit': '100'}
                        if cursor:
                            params['after'] = cursor
                        page_response = await client.get(base + creative_set_id + '/products', headers=headers, params=params)
                        page_response.raise_for_status()
                        page_data = page_response.json()
                        if page_data.get('error') or not isinstance(page_data.get('data'), list):
                            membership_complete = False
                            break
                        set_members.extend(page_data['data'])
                        page_info = page_data.get('paging') or {}
                        if not page_info.get('next'):
                            break
                        cursor = ((page_info.get('cursors') or {}).get('after'))
                        if not cursor or cursor in seen_cursors:
                            membership_complete = False
                            break
                        seen_cursors.add(cursor)
                    else:
                        membership_complete = False
                    if len(set_members) != set_product_count:
                        membership_complete = False
                    meta_variant_keys = set()
                    meta_eligible_records = 0
                    malformed_meta_records = 0
                    seen_meta_item_ids = set()
                    meta_member_samples = []
                    meta_integrity_status_samples = []
                    meta_unmatched_item_samples = []
                    shopify_variant_keys = set(feed_variants or [])
                    for member in set_members:
                        if not isinstance(member, dict):
                            malformed_meta_records += 1
                            continue
                        if len(meta_member_samples) < 5:
                            raw_retailer_id = str(member.get('retailer_id') or '')
                            meta_member_samples.append({
                                'id': str(member.get('id') or ''),
                                'retailer_id': raw_retailer_id[:160],
                                'parsed_shopify_variant_id': _shopify_variant_key(raw_retailer_id),
                                'availability': str(member.get('availability') or '')[:40],
                            })
                        item_id = str(member.get('id') or '')
                        if (not meta_integrity_status_samples
                                and re.fullmatch(r'\d{4,30}', item_id)):
                            try:
                                integrity_response = await client.get(
                                    base + item_id + '/channels_to_integrity_status',
                                    headers=headers,
                                    params={'fields': 'channels,rejection_information', 'limit': '10'},
                                )
                                integrity_response.raise_for_status()
                                integrity_data = integrity_response.json()
                                records = integrity_data.get('data') if isinstance(integrity_data, dict) else None
                                meta_integrity_status_samples.append({
                                    'product_item_id': item_id,
                                    'records': records[:3] if isinstance(records, list) else None,
                                    'response_keys': sorted(integrity_data.keys())[:12] if isinstance(integrity_data, dict) else [],
                                })
                            except httpx.HTTPStatusError as exc:
                                meta_integrity_status_samples.append({
                                    'product_item_id': item_id,
                                    'http_status': exc.response.status_code,
                                })
                            except Exception as exc:
                                meta_integrity_status_samples.append({
                                    'product_item_id': item_id,
                                    'error_type': type(exc).__name__,
                                })
                        if not re.fullmatch(r'\d{4,30}', item_id) or item_id in seen_meta_item_ids:
                            malformed_meta_records += 1
                        seen_meta_item_ids.add(item_id)
                        key = _shopify_variant_key(member.get('retailer_id'))
                        if not key or not member.get('availability'):
                            malformed_meta_records += 1
                            continue
                        if _catalog_available(member):
                            if key in meta_variant_keys:
                                malformed_meta_records += 1
                            meta_variant_keys.add(key)
                            meta_eligible_records += 1
                            if key not in shopify_variant_keys and len(meta_unmatched_item_samples) < 10:
                                item_url = str(member.get('url') or '')
                                item_path = urlsplit(item_url).path.rstrip('/')
                                feed_products = getattr(self, 'feed_products', [])
                                same_path_rows = [
                                    product for product in feed_products
                                    if urlsplit(product.link).path.rstrip('/') == item_path
                                ] if item_path else []
                                title_tokens = set(re.findall(
                                    r'[a-z0-9äöüß]+', str(member.get('name') or '').casefold(), re.UNICODE
                                ))
                                title_matches = []
                                for product in feed_products:
                                    product_tokens = set(re.findall(
                                        r'[a-z0-9äöüß]+', str(product.title).casefold(), re.UNICODE
                                    ))
                                    union = title_tokens | product_tokens
                                    score = (len(title_tokens & product_tokens) / len(union)) if union else 0
                                    if score >= 0.25:
                                        title_matches.append((score, product))
                                title_matches.sort(key=lambda row: row[0], reverse=True)
                                meta_unmatched_item_samples.append({
                                    'id': item_id,
                                    'retailer_id': str(member.get('retailer_id') or '')[:160],
                                    'variant_id': key,
                                    'title': str(member.get('name') or '')[:180],
                                    'url': item_url[:500],
                                    'shopify_feed_same_product_path': bool(same_path_rows),
                                    'shopify_feed_same_path_variant_ids': [
                                        _shopify_variant_key(product.id) for product in same_path_rows[:10]
                                    ],
                                    'shopify_feed_same_path_availability': [
                                        str(product.availability)[:30] for product in same_path_rows[:10]
                                    ],
                                    'shopify_feed_title_matches': [
                                        {
                                            'score': round(score, 3),
                                            'title': str(product.title)[:160],
                                            'variant_id': _shopify_variant_key(product.id),
                                            'url': str(product.link)[:400],
                                            'availability': str(product.availability)[:30],
                                        }
                                        for score, product in title_matches[:3]
                                    ],
                                })
                    feed_coverage_verified = (membership_complete and feed_variants is not None
                                               and shopify_variant_keys.issubset(meta_variant_keys)
                                               and malformed_meta_records == 0)
                    membership_matches = (feed_coverage_verified
                                          and meta_variant_keys == shopify_variant_keys)
                    snapshot['catalog_validation'].update({
                        'product_set_name': str(set_readback.get('name', ''))[:80],
                        'product_set_item_count': set_product_count,
                        'shopify_feed_item_count': feed_count,
                        'shopify_in_stock_item_count': getattr(self, 'feed_in_stock_count', None),
                        'unfiltered': raw_filter in (None, '', {}, []),
                        'shopify_in_stock_variant_count': len(shopify_variant_keys),
                        'meta_in_stock_variant_count': meta_eligible_records,
                        'meta_approved_in_stock_variant_count': None,
                        'meta_approval_status': 'not_verified_review_status_deprecated',
                        'product_set_membership_complete': membership_complete,
                        'variant_membership_matches': membership_matches,
                        'shopify_feed_coverage_verified': feed_coverage_verified,
                        'variant_membership_unmatched_shopify_count': len(shopify_variant_keys - meta_variant_keys),
                        'variant_membership_unmatched_meta_count': len(meta_variant_keys - shopify_variant_keys),
                        'meta_items_outside_curated_feed_count': len(meta_variant_keys - shopify_variant_keys),
                        'malformed_meta_catalog_records': malformed_meta_records,
                        'meta_member_samples': meta_member_samples,
                        'meta_integrity_status_samples': meta_integrity_status_samples,
                        'meta_unmatched_item_samples': meta_unmatched_item_samples,
                    })
                    if (str(set_readback.get('id', '')) != creative_set_id
                            or set_product_count <= 0
                            or raw_filter not in (None, '', {}, [])
                            or not feed_coverage_verified):
                        blockers.append('CATALOG_PRODUCT_SET_CONTENTS_NOT_VERIFIED')
            snapshot['site_diagnostics'] = getattr(self, 'site_diagnostics', [])
            snapshot['review_proposals'] = getattr(self, 'review_proposals', [])
            snapshot['technical_gates_passed'] = not any(b != 'EXACT_CREATIVE_PREVIEW_REVIEW_REQUIRED' for b in blockers)
            snapshot['creative_review_passed'] = bool(review)
            snapshot['tracking_configuration_verified'] = not source_blockers and not any(
                b in {'EXISTING_SIGNED_TRACKING_CONFIGURATION_REQUIRED', 'SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED'}
                for b in blockers)
            if (blockers and restore_after_pilot_tracking_error
                    and remote.get('status') == 'PAUSED'
                    and set(blockers).issubset({
                        'SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED',
                        'CATALOG_PRODUCT_SET_CONTENTS_NOT_VERIFIED',
                        'OWNER_EXCLUDED_CREATIVE_PRODUCT',
                    })):
                # Restore the exact owner-authorized campaign that this pilot
                # paused after Meta rejected its unsupported url_tags mutation.
                # Keep the readiness blockers visible; do not claim attribution
                # or catalog verification, and still pass through all spend,
                # schedule, market, pixel, billing and activation-switch checks.
                snapshot['restored_after_pilot_tracking_error'] = True
                snapshot['restoration_blockers'] = sorted(set(blockers))
                blockers = []
            if blockers and remote.get('status') == 'ACTIVE':
                # Respect an owner-started campaign. Keep enforcing the verified
                # spend, schedule, market and pixel limits above, but never issue
                # a pause solely because a later diagnostic gate is incomplete.
                return {**snapshot, 'status': 'owner_active_readiness_blocked',
                        'blockers': sorted(set(blockers)), 'pilot_paused_campaign': False,
                        'consent': consent}
            if blockers:
                return {**await pause('READINESS_GATES_NOT_PASSED'), 'blockers': blockers}
            if env.get('PILOT_LAUNCH_POLICY') != POLICY or env.get('PILOT_FIRST_PURCHASE_TEST_AUTHORIZED') != 'true' or env.get('PILOT_FIRST_PURCHASE_ACTIVATION_ENABLED') != 'true' or live_ads_dry_run(env) or env.get('ALLOW_MICRO_BUDGET') != 'true' or configured_daily_budget_limit_eur(env) != 5:
                return await pause('EXPLICIT_BOUNDED_ACTIVATION_SWITCHES_REQUIRED')
            # Account-wide Meta cap is verified above; no campaign spend_cap mutation.
            # Daily EUR5 and seven-day schedule remain independently enforced.
            if remote.get('status') == 'ACTIVE':
                updated = instant(remote['updated_time'])
                if consent['state'] == 'activation_intent':
                    if updated < instant(consent['activation_intent_at']) - timedelta(seconds=60):
                        return await pause('ACTIVATION_TIME_UNCONFIRMED')
                    consent = self.store.activated(updated)
                elif consent['state'] == 'authorized':
                    authorized_at = instant(consent['authorized_at'])
                    if updated < authorized_at - timedelta(seconds=60) or updated >= end or updated > now + timedelta(minutes=1):
                        return await pause('OWNER_ACTIVATION_TIME_UNCONFIRMED')
                    consent = self.store.record_owner_activation(updated, end)
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
            # Railway deploy/restart cancellation is not an owner stop request.
            # Do not issue a Meta pause write while shutting down a verified live campaign.
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
                    if error.get('code') == 100:
                        if stage == 'paused_catalog_tracking_preparation':
                            # Avoid retrying a rejected tracking mutation every worker cycle.
                            self.store.defer_provider(
                                campaign, 'META_CATALOG_TRACKING_TAG_UPDATE_REJECTED', now, 900
                            )
                        # Keep the provider's bounded diagnostic, never payloads,
                        # URLs or credentials. This identifies the rejected field.
                        for key in ('error_user_title', 'error_user_msg', 'message'):
                            value = error.get(key)
                            if isinstance(value, str):
                                value = re.sub(r'https?://\\S+|\\b[A-Za-z0-9_-]{40,}\\b|\\bEA[A-Za-z0-9]{15,}\\b|sk-[A-Za-z0-9_-]+', '[redacted]', value)
                                detail[key] = value[:800]
                except (ValueError, TypeError, AttributeError):
                    pass
            # A provider rate limit is not a reason to issue another write. If
            # this cycle already read the owned campaign as PAUSED and has not
            # entered the activation phase, retain that verified state and let
            # the durable backoff govern the next read-only retry.
            if (snapshot.get('campaign_status') == 'PAUSED'
                    and stage != 'activation'
                    and detail.get('code') in {4, 17, 32, 613, 80004}):
                return {**snapshot, 'status': 'paused_confirmed',
                        'reason': 'META_API_RATE_LIMIT_BACKOFF',
                        'provider_mutations_deferred': True,
                        'pause_write_skipped': True, **detail}
            if snapshot.get('campaign_status') == 'ACTIVE' and stage == 'landing_checkout':
                # A read-only landing/catalog diagnostic failure must not pause
                # an owner-started campaign after spend and account limits pass.
                return {**snapshot, 'status': 'owner_active_readiness_blocked',
                        'pilot_paused_campaign': False, **detail}
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

    async def sources(self, client, cards, campaign, ad, pixel, now, *, dynamic_catalog=False, url_tags=None, allow_untracked_catalog=False):
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
        self.feed_products = feed.products
        self.feed_product_count = len(feed.products)
        self.feed_in_stock_count = sum(1 for product in feed.products if product.availability == 'in_stock')
        from .payment_webhooks import PaymentWebhookStore, payment_database
        from .product_selection import read_cost_candidates
        from .website_ads import owner_excluded, product_path

        if dynamic_catalog:
            all_variant_keys = [_shopify_variant_key(product.id) for product in feed.products]
            valid_variant_keys = {key for key in all_variant_keys if key}
            self.feed_variant_count = len(feed.products)
            self.feed_in_stock_variant_keys = {
                key for product in feed.products
                if product.availability == 'in_stock'
                and (key := _shopify_variant_key(product.id)) is not None
            }
            in_stock_rows = [product for product in feed.products if product.availability == 'in_stock']
            feed_identity_ok = (len(valid_variant_keys) == len(feed.products)
                                and len(valid_variant_keys) == len(set(all_variant_keys)))
            self.catalog_feed_identity_validation = {
                'feed_records': len(feed.products),
                'unique_shopify_variant_ids': len(valid_variant_keys),
                'in_stock_variant_ids': len(self.feed_in_stock_variant_keys),
                'all_records_have_unique_variant_ids': feed_identity_ok,
                'in_stock_records_missing_image': sum(1 for product in in_stock_rows if not product.image_link),
            }
            if not feed_identity_ok:
                return ['CATALOG_SHOPIFY_VARIANT_IDS_NOT_VERIFIABLE']
            if any(not product.image_link for product in in_stock_rows):
                return ['CATALOG_IN_STOCK_ITEM_IMAGE_MISSING']
            secret = env.get('PILOT_ATTRIBUTION_SECRET') or env.get('PILOT_ADMIN_KEY', '')
            ref_values = parse_qs(str(url_tags or ''), keep_blank_values=True).get('pilot_ref', [])
            signed_ref = decode_ref(ref_values[0], secret=secret, at=now) if len(ref_values) == 1 else None
            signed_ref_valid = bool(signed_ref and signed_ref.get('channel') == 'meta'
                and signed_ref.get('campaign') == campaign and signed_ref.get('ad') == ad)
            if not signed_ref_valid and not allow_untracked_catalog:
                return ['SIGNED_AD_ATTRIBUTION_NOT_ATTACHED_OR_EXPIRED']
            cards = []
            for product in in_stock_rows[:3]:
                key = _shopify_variant_key(product.id)
                product_url = (product.link if parse_qs(urlsplit(product.link).query).get('variant')
                    else product.link + ('&' if '?' in product.link else '?') + 'variant=' + key)
                link = (tracked_url(product_url, ref_values[0], secret=secret, at=now)
                    if signed_ref_valid else product_url)
                cards.append({'link': link, 'picture': product.image_link, 'name': product.title})
            if not cards:
                return ['CATALOG_HAS_NO_CURRENT_IN_STOCK_VARIANTS']
            self.catalog_feed_identity_validation['static_preview_validation_skipped'] = True

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
            requested_variant = parse_qs(url.query).get('variant', [None])[0]
            matches = [p for p in feed.products if urlsplit(p.link).path.rstrip('/') == url.path.rstrip('/')
                       and p.availability == 'in_stock'
                       and (not requested_variant or _shopify_variant_key(p.id) == requested_variant)]
            if matches and any(owner_excluded(p.model_dump(mode='json')) for p in matches):
                blockers.append('OWNER_EXCLUDED_CREATIVE_PRODUCT')
            if not matches:
                blockers.append('CREATIVE_SOURCE_NOT_CURRENT_IN_STOCK')
                continue
            if card.get('picture') and card['picture'] not in {p.image_link for p in matches}:
                blockers.append('CREATIVE_IMAGE_NOT_CURRENT_SOURCE')
            tag = parse_qs(url.query).get('pilot_ref', [None])[0]
            ref = decode_ref(tag, secret=env.get('PILOT_ATTRIBUTION_SECRET') or env.get('PILOT_ADMIN_KEY', ''), at=now)
            if (not ref or ref['channel'] != 'meta' or ref['campaign'] != campaign or ref['ad'] != ad):
                if not (dynamic_catalog and allow_untracked_catalog):
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
            variant = requested_variant or next((parse_qs(urlsplit(p.link).query).get('variant', [None])[0]
                for p in matches if parse_qs(urlsplit(p.link).query).get('variant')), None)
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


class AutopilotFeedController:
    """Validate and deduplicate records; commercial filtering belongs to neither feed sync nor ads."""

    def process_and_filter_feed(self, raw_products: list[dict[str, Any]]) -> list[dict[str, Any]]:
        from .feed_manager import FeedProduct
        from .website_ads import product_path

        valid: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        seen_paths: set[str] = set()
        for raw in raw_products:
            if not isinstance(raw, dict):
                continue
            try:
                product = FeedProduct.model_validate(raw)
                path = product_path(product.link)
            except Exception:
                continue
            if not product.id or not product.image_link or product.availability != "in_stock":
                continue
            if product.id in seen_ids or path in seen_paths:
                continue
            seen_ids.add(product.id)
            seen_paths.add(path)
            valid.append(product.model_dump(mode="json"))
        return valid
