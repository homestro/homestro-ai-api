"""Durable product exploration on one owned ad, without generation or budget writes."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from contextlib import closing
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import parse_qsl, urlsplit

import httpx

from .performance_loader import load_meta_performance, performance_decision
from .website_ads import website_story


def next_product_batch(products, counts, limit=10, trend_candidates=None):
    """Explore eligible products fairly, diversifying available feed categories.

    Counts are exposure selections, never sales scores or inferred demand.
    """
    signals = {}
    for candidate in trend_candidates or []:
        try:
            age = int(candidate['observed_longest_ad_age_days'])
            if age >= 14:
                signals[str(candidate['product_id'])] = min(age, 365)
        except (KeyError, TypeError, ValueError):
            continue
    candidates = []
    seen = set()
    for product in products:
        try:
            _, ids = website_story([product], '12345')
        except (ValueError, TypeError):
            continue
        link = product['link']
        if link in seen:
            continue
        seen.add(link)
        category = str(product.get('product_type') or product.get('google_product_category') or 'unknown')[:160]
        candidates.append((product, ids[0], category))
    selected, categories = [], {}
    while candidates and len(selected) < limit:
        candidates.sort(key=lambda item: (counts.get(item[1], 0), categories.get(item[2], 0),
                                          -signals.get(item[1], 0), -Decimal(str(item[0].get('pilot_gross_headroom_eur', '0'))),
                                          str(item[0].get('title', '')).casefold(), item[1]))
        product, product_id, category = candidates.pop(0)
        selected.append(product)
        categories[category] = categories.get(category, 0) + 1
    return selected


class BrainMemory:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as connection, connection:
            connection.execute('CREATE TABLE IF NOT EXISTS pilot_brain_memory (campaign TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            connection.execute('CREATE TABLE IF NOT EXISTS pilot_brain_intents (intent TEXT PRIMARY KEY, payload TEXT NOT NULL)')

    def state(self, campaign):
        with closing(self.audit._connect()) as connection:
            row = connection.execute('SELECT payload FROM pilot_brain_memory WHERE campaign=?', (campaign,)).fetchone()
        return json.loads(row[0]) if row else None

    def initialize(self, campaign, state):
        with closing(self.audit._connect()) as connection, connection:
            connection.execute('INSERT OR IGNORE INTO pilot_brain_memory VALUES (?,?)', (campaign, json.dumps(state)))
        return self.state(campaign)

    def reserve(self, campaign, state, proposal):
        key = hashlib.sha256(json.dumps([campaign, state['creative_id'], proposal], sort_keys=True).encode()).hexdigest()
        with closing(self.audit._connect()) as connection, connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT payload FROM pilot_brain_memory WHERE campaign=?', (campaign,)).fetchone()
            current = json.loads(row[0])
            if current.get('inflight') or current['creative_id'] != state['creative_id']:
                return None
            intent = {'key': key, 'status': 'RESERVED', 'previous_creative_id': state['creative_id'], **proposal}
            connection.execute('INSERT INTO pilot_brain_intents VALUES (?,?)', (key, json.dumps(intent)))
            current['inflight'] = key
            connection.execute('UPDATE pilot_brain_memory SET payload=? WHERE campaign=?', (json.dumps(current), campaign))
        return intent

    def intent(self, key):
        with closing(self.audit._connect()) as connection:
            row = connection.execute('SELECT payload FROM pilot_brain_intents WHERE intent=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def created(self, intent, creative_id):
        intent = {**intent, 'status': 'CREATED', 'creative_id': creative_id}
        with closing(self.audit._connect()) as connection, connection:
            connection.execute('UPDATE pilot_brain_intents SET payload=? WHERE intent=?', (json.dumps(intent), intent['key']))
        return intent

    def confirm_absence(self, intent, now):
        """One bounded recovery retry after two complete negative reads over time.

        Never creates another ad/campaign, and never retries an ambiguous match.
        """
        with closing(self.audit._connect()) as connection, connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT payload FROM pilot_brain_intents WHERE intent=?', (intent['key'],)).fetchone()
            current = json.loads(row[0])
            if current.get('creative_id') or current.get('recovery_retry_reserved'):
                return current, False
            first = current.get('first_confirmed_absent_at') or now.isoformat()
            current['first_confirmed_absent_at'] = first
            current['negative_reads'] = current.get('negative_reads', 0) + 1
            planned = datetime.fromisoformat(current['planned_at'])
            eligible = (current['negative_reads'] >= 2 and now - planned >= timedelta(minutes=15)
                        and now - datetime.fromisoformat(first) >= timedelta(minutes=5))
            if eligible:
                current['recovery_retry_reserved'] = True
            connection.execute('UPDATE pilot_brain_intents SET payload=? WHERE intent=?', (json.dumps(current), intent['key']))
        return current, eligible

    def finish(self, campaign, state, intent):
        counts = dict(state['counts'])
        for product_id in intent['product_ids']:
            if not intent.get('tracking_only'):
                counts[product_id] = counts.get(product_id, 0) + 1
        state = {**state, 'counts': counts, 'creative_id': intent['creative_id'], 'inflight': None,
                 'last_rotation_at': datetime.now(UTC).isoformat(), 'baseline_spend_eur': intent['spend_eur'],
                 'current_product_ids': intent['product_ids'], 'tracking_installed': True}
        with closing(self.audit._connect()) as connection, connection:
            connection.execute('UPDATE pilot_brain_memory SET payload=? WHERE campaign=?', (json.dumps(state), campaign))
            connection.execute('UPDATE pilot_brain_intents SET payload=? WHERE intent=?',
                               (json.dumps({**intent, 'status': 'CONFIRMED'}), intent['key']))


class AutonomousBrain:
    def __init__(self, audit, *, env=None, client=None):
        self.audit = audit
        self.env = os.environ if env is None else env
        self.client = client
        self.memory = BrainMemory(audit)

    async def cycle(self, products, *, now=None, trend_candidates=None, candidate_products=None):
        from .media_buyer import MetaPublisher
        from .purchase_guard import timestamp

        now = now or datetime.now(UTC)
        claim = await self.audit.get_meta_micro_campaign_claim()
        if not claim or claim.get('status') not in {'ACTIVE_PENDING_REVIEW', 'RECONCILED_EXISTING_CAMPAIGN'}:
            return {'status': 'hold', 'reason': 'NO_RUNNING_MANAGED_TEST'}
        publisher = MetaPublisher(self.audit, env=self.env, client=self.client)
        config = publisher._configuration()
        if isinstance(config, dict) or self.env.get('PILOT_AD_MODE') != 'website_sales':
            return {'status': 'hold', 'reason': 'LIVE_WEBSITE_TEST_REQUIRED'}
        if self.env.get('PILOT_LAUNCH_POLICY') != 'bounded_acquisition_test':
            return {'status': 'hold', 'reason': 'BOUNDED_TEST_REQUIRED'}
        account, page, _, token, version, *_ = config
        campaign = str(claim['campaign_id'])
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
        headers = {'Authorization': f'Bearer {token}'}
        base = f'https://graph.facebook.com/{version}'

        async def get(object_id, fields):
            response = await client.get(f'{base}/{object_id}', headers=headers, params={'fields': fields, 'limit': '100'})
            response.raise_for_status()
            result = response.json()
            if 'error' in result or (result.get('paging') or {}).get('next'):
                raise ValueError('unreadable scope')
            return result

        stage = 'read'
        try:
            remote = await get(campaign, 'id,account_id,name,status,objective')
            if (str(remote.get('account_id')) != account.removeprefix('act_')
                    or remote.get('name') != publisher._campaign_name() or remote.get('objective') != 'OUTCOME_SALES'
                    or remote.get('status') != 'ACTIVE'):
                return {'status': 'hold', 'reason': 'CAMPAIGN_SCOPE_OR_STATUS'}
            adsets = (await get(campaign + '/adsets', 'id,status,daily_budget,lifetime_budget,start_time,end_time,targeting'))['data']
            if len(adsets) != 1:
                return {'status': 'hold', 'reason': 'ADSET_SCOPE_AMBIGUOUS'}
            adset = adsets[0]
            if (str(adset.get('daily_budget')) != '500' or adset.get('lifetime_budget') not in (None, 0, '0')
                    or adset.get('status') != 'ACTIVE'
                    or set(adset.get('targeting', {}).get('geo_locations', {}).get('countries', [])) != {'DE', 'AT'}
                    or not timestamp(adset['start_time']) <= now < timestamp(adset['end_time'])
                    or timestamp(adset['end_time']) - timestamp(adset['start_time']) > timedelta(days=7)):
                return {'status': 'hold', 'reason': 'TEST_NOT_STARTED_OR_BUDGET_SCHEDULE_UNSAFE'}
            ads = (await get(adset['id'] + '/ads', 'id,status,effective_status,creative{id}'))['data']
            if len(ads) != 1 or ads[0].get('status') != 'ACTIVE':
                return {'status': 'hold', 'reason': 'SINGLE_ACTIVE_AD_REQUIRED'}
            ad = ads[0]
            creative_id = str(ad['creative']['id'])
            performance = await load_meta_performance(self.audit, env=self.env, client=client)
            decision = performance_decision(performance)
            if decision['action'] == 'pause':
                return {'status': 'hold', 'reason': decision['reason'], 'performance': decision,
                        'ad_effective_status': ad.get('effective_status')}
            spend = Decimal(str(performance['metrics'][0]['spend_eur'])) if performance.get('metrics') else Decimal('0')
            state = await asyncio.to_thread(self.memory.state, campaign)
            if state is None:
                creative = await get(creative_id, 'id,object_story_spec')
                story = creative.get('object_story_spec') or {}
                if str(story.get('page_id')) != page:
                    return {'status': 'hold', 'reason': 'CREATIVE_PAGE_NOT_VERIFIED'}
                data = story.get('link_data') or {}
                urls = {item.get('link') for item in data.get('child_attachments', [])} | {data.get('link')}
                def path(url):
                    return urlsplit(str(url)).path.rstrip('/')
                used = [str(p['id']) for p in products if path(p.get('link')) in {path(url) for url in urls if url}]
                if not used:
                    return {'status': 'hold', 'reason': 'CURRENT_PRODUCTS_NOT_RECONCILED'}
                state = await asyncio.to_thread(self.memory.initialize, campaign, {
                    'creative_id': creative_id, 'ad_id': ad['id'], 'counts': dict.fromkeys(used, 1),
                    'last_rotation_at': now.isoformat(), 'baseline_spend_eur': float(spend), 'inflight': None,
                    'current_product_ids': used, 'tracking_installed': False})
            if state['ad_id'] != ad['id']:
                return {'status': 'hold', 'reason': 'AD_ID_CHANGED_EXTERNALLY'}
            intent = await asyncio.to_thread(self.memory.intent, state['inflight']) if state.get('inflight') else None
            if intent:
                if not intent.get('creative_id'):
                    stage = 'reconcile_creative'
                    matches, cursor, seen, named_candidates = [], None, set(), 0
                    def links(story):
                        data = story.get('link_data') or {}
                        def canonical(value):
                            parsed = urlsplit(str(value))
                            return (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path,
                                    tuple(sorted(parse_qsl(parsed.query, keep_blank_values=True))), parsed.fragment)
                        return sorted(canonical(item.get('link', '')) for item in [data, *data.get('child_attachments', [])])
                    for _ in range(5):
                        params = {'fields': 'id,name,object_story_spec', 'limit': '100'}
                        if cursor:
                            params['after'] = cursor
                        response = await client.get(f'{base}/{account}/adcreatives', headers=headers, params=params)
                        response.raise_for_status()
                        body = response.json()
                        if not isinstance(body.get('data'), list) or body.get('error'):
                            raise ValueError('creative reconciliation unreadable')
                        for candidate in body['data']:
                            observed = candidate.get('object_story_spec') or {}
                            expected = intent['story']
                            if candidate.get('name') == 'Homestro Exploration ' + intent['key'][:16]:
                                named_candidates += 1
                            if (candidate.get('name') == 'Homestro Exploration ' + intent['key'][:16]
                                    and str(observed.get('page_id')) == str(expected['page_id'])
                                    and links(observed) == links(expected)
                                    and (observed.get('link_data') or {}).get('message') == expected['link_data']['message']
                                    and str(candidate.get('id', '')).isdigit()):
                                matches.append(str(candidate['id']))
                        paging = body.get('paging') or {}
                        if not paging.get('next'):
                            break
                        cursor = (paging.get('cursors') or {}).get('after')
                        if not cursor or cursor in seen or len(cursor) > 2048:
                            raise ValueError('creative reconciliation incomplete')
                        seen.add(cursor)
                    else:
                        raise ValueError('creative reconciliation page limit')
                    if len(set(matches)) == 1:
                        intent = await asyncio.to_thread(self.memory.created, intent, matches[0])
                    elif not matches and named_candidates == 0:
                        intent, retry_allowed = await asyncio.to_thread(self.memory.confirm_absence, intent, now)
                        if not retry_allowed:
                            return {'status': 'blocked', 'reason': 'CREATIVE_CREATE_UNCERTAIN_NO_RETRY',
                                    'matches': 0, 'named_candidates': 0, 'intent': intent['key'],
                                    'negative_reads': intent.get('negative_reads', 0),
                                    'recovery_retry_already_used': bool(intent.get('recovery_retry_reserved'))}
                        stage = 'create_creative_after_confirmed_absence'
                        response = await client.post(f'{base}/{account}/adcreatives', headers=headers, data={
                            'name': 'Homestro Exploration ' + intent['key'][:16],
                            'object_story_spec': json.dumps(intent['story'], ensure_ascii=False)}, timeout=60)
                        response.raise_for_status()
                        created = response.json()
                        if not str(created.get('id', '')).isdigit():
                            raise ValueError('recovered creative id missing')
                        intent = await asyncio.to_thread(self.memory.created, intent, str(created['id']))
                    else:
                        return {'status': 'blocked', 'reason': 'CREATIVE_RECONCILIATION_AMBIGUOUS',
                                'matches': len(set(matches)), 'named_candidates': named_candidates}
                if creative_id == intent['creative_id']:
                    await asyncio.to_thread(self.memory.finish, campaign, state, {**intent, 'spend_eur': float(spend)})
                    return {'status': 'rotation_confirmed', 'selected_product_ids': intent['product_ids'], 'ad_id': ad['id']}
                if creative_id != intent['previous_creative_id']:
                    return {'status': 'blocked', 'reason': 'EXTERNAL_CREATIVE_CHANGE'}
            else:
                if creative_id != state['creative_id']:
                    return {'status': 'hold', 'reason': 'EXTERNAL_CREATIVE_CHANGE'}
                if ad.get('effective_status') != 'ACTIVE':
                    return {'status': 'hold', 'reason': 'AD_REVIEW_OR_DELIVERY_NOT_ACTIVE', 'effective_status': ad.get('effective_status')}
                tracking_only = not state.get('tracking_installed', False)
                if not tracking_only and not performance.get('metrics'):
                    return {'status': 'hold', 'reason': 'NO_DELIVERY_DATA', 'ad_effective_status': ad.get('effective_status')}
                if (not tracking_only and decision.get('reported_purchases', 0) >= 1
                        and (decision.get('reported_roas') or 0) >= 1.5):
                    return {'status': 'hold', 'reason': 'PRESERVE_CAMPAIGN_WITH_REPORTED_PURCHASES',
                            'performance': decision}
                if not tracking_only and now - timestamp(state['last_rotation_at']) < timedelta(hours=24):
                    return {'status': 'learning', 'reason': 'MINIMUM_24H_EXPERIMENT', 'next_eligible_at':
                            (timestamp(state['last_rotation_at']) + timedelta(hours=24)).isoformat()}
                if not tracking_only and spend - Decimal(str(state['baseline_spend_eur'])) < Decimal('2.50'):
                    return {'status': 'learning', 'reason': 'MINIMUM_2_50_EUR_EXPERIMENT_SPEND'}
                batch = ([p for p in products if str(p.get('id')) in state.get('current_product_ids', [])]
                         if tracking_only else next_product_batch(
                             products if candidate_products is None else candidate_products,
                             state['counts'], trend_candidates=trend_candidates))
                if not batch:
                    return {'status': 'hold', 'reason': 'NO_COST_ELIGIBLE_EXPERIMENT_PRODUCTS'}
                story, ids = website_story(batch, page)
                if not tracking_only:
                    from .content_engine import product_draft

                    # Preserve the already-reserved tracking bootstrap story verbatim.
                    story['link_data']['message'] = (product_draft(batch[0])['ad']['primary_text']
                        if len(batch) == 1 else 'Neue Ideen bei Homestro: Produktdetails und aktuelle Preise im Shop entdecken.')
                if not tracking_only and set(ids) == set(state.get('current_product_ids', [])):
                    return {'status': 'hold', 'reason': 'NO_NEW_PRODUCT_BATCH'}
                from .order_economics import tracked_story, tracking_ref

                experiment = hashlib.sha256((campaign + ad['id'] + creative_id + now.isoformat()).encode()).hexdigest()[:24]
                ref = tracking_ref(campaign, ad['id'], experiment,
                                   secret=self.env.get('PILOT_ATTRIBUTION_SECRET') or self.env.get('PILOT_ADMIN_KEY', ''),
                                   expires_at=timestamp(adset['end_time']), issued_at=now)
                story = tracked_story(story, ref, campaign, ad['id'])
                intent = await asyncio.to_thread(self.memory.reserve, campaign, state, {
                    'tracking_only': tracking_only, 'experiment': experiment,
                    'product_ids': ids, 'story': story, 'planned_at': now.isoformat(), 'spend_eur': float(spend)})
                if intent is None:
                    return {'status': 'hold', 'reason': 'ROTATION_ALREADY_RESERVED'}
                stage = 'create_creative'
                response = await client.post(f'{base}/{account}/adcreatives', headers=headers, data={
                    'name': 'Homestro Exploration ' + intent['key'][:16],
                    'object_story_spec': json.dumps(intent['story'], ensure_ascii=False)}, timeout=60)
                response.raise_for_status()
                created = response.json()
                if not str(created.get('id', '')).isdigit():
                    raise ValueError('creative id missing')
                intent = await asyncio.to_thread(self.memory.created, intent, str(created['id']))
            # Recheck durable stop before any ad update. Never activates or edits a budget.
            current_claim = await self.audit.get_meta_micro_campaign_claim()
            if not current_claim or current_claim != claim:
                return {'status': 'hold', 'reason': 'TEST_STATE_CHANGED'}
            stage = 'attach_creative'
            response = await client.post(f'{base}/{ad["id"]}', headers=headers,
                                         data={'creative': json.dumps({'creative_id': intent['creative_id']})})
            response.raise_for_status()
            if response.json().get('success') is not True:
                raise ValueError('ad update not acknowledged')
            confirmed = await get(ad['id'], 'id,creative{id},effective_status')
            if str(confirmed.get('creative', {}).get('id')) != intent['creative_id']:
                return {'status': 'pending_reconciliation', 'reason': 'CREATIVE_ATTACHMENT_NOT_CONFIRMED'}
            await asyncio.to_thread(self.memory.finish, campaign, state, {**intent, 'spend_eur': float(spend)})
            return {'status': 'rotation_confirmed', 'ad_id': ad['id'], 'creative_id': intent['creative_id'],
                    'selected_product_ids': intent['product_ids'], 'effective_status': confirmed.get('effective_status'),
                    'reason': 'TRACKING_BOOTSTRAP' if intent.get('tracking_only') else 'LEAST_EXPLORED_ELIGIBLE_PRODUCTS',
                    'tracking_installed': True, 'budget_writes': False, 'paid_generation': False}
        except Exception as exc:
            diagnostics = {}
            if isinstance(exc, httpx.HTTPStatusError):
                diagnostics['http_status'] = exc.response.status_code
                try:
                    error = exc.response.json().get('error') or {}
                    for key in ('code', 'error_subcode'):
                        if type(error.get(key)) is int:
                            diagnostics['meta_' + key] = error[key]
                except (ValueError, TypeError, AttributeError):
                    pass
            return {'status': 'blocked', 'reason': 'BRAIN_PROVIDER_OR_STATE_UNAVAILABLE',
                    'stage': stage, 'error_type': type(exc).__name__, **diagnostics}
        finally:
            if self.client is None:
                await client.aclose()
