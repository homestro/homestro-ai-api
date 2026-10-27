"""Persistent marketing strategy, funnel drafts and evidence-aware work queue.

The director coordinates existing consumers. A delegated task is never a publication receipt.
"""
from __future__ import annotations

import hashlib
import html
import json
from contextlib import closing
from datetime import UTC, datetime, timedelta
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from .brand_memory import BrandMemory
from .content_engine import BRIEF, BRIEF_HASH, product_draft

KINDS = {'meta_experiment', 'google_search', 'bing_search', 'social_content',
         'landing_content', 'email_sequence', 'seo_geo', 'media_review'}
OWNERS = {'meta_experiment': 'existing_meta_brain', 'seo_geo': 'existing_seo_writer',
          'social_content': 'existing_organic_publisher', 'landing_content': 'existing_seo_guides',
          'email_sequence': 'email_delivery', 'google_search': 'google_ads',
          'bing_search': 'microsoft_ads', 'media_review': 'existing_media_review'}
BLOCKERS = {'google_search': ['GOOGLE_ADS_ACCOUNT_CONNECTION_UNVERIFIED', 'ADDITIONAL_CHANNEL_SPEND_NOT_AUTHORIZED'],
            'bing_search': ['MICROSOFT_ADS_ACCOUNT_CONNECTION_UNVERIFIED', 'ADDITIONAL_CHANNEL_SPEND_NOT_AUTHORIZED'],
            'email_sequence': ['RECIPIENT_CONSENT_SMTP_CONFIGURATION_AND_EXPLICIT_SEND_AUTHORIZATION'],
            'landing_content': ['EXISTING_SEO_GUIDE_CONSUMER_RECEIPT'],
            'social_content': ['EXISTING_ORGANIC_CONSUMER_RECEIPT'],
            'seo_geo': ['GEO_THEME_PUBLICATION_READBACK'],
            'meta_experiment': [], 'media_review': ['PRODUCT_AND_VISUAL_REVIEW_REQUIRED']}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def canonical(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in {'homestro.de', 'www.homestro.de'} or parsed.username or parsed.password:
        raise ValueError('UNTRUSTED_PRODUCT_URL')
    return unquote(parsed.path).rstrip('/')


def campaign_pack(raw):
    draft = product_draft(raw)
    title = draft['seo']['h1']
    link = draft['source_url']
    escape = html.escape
    landing = ('<article lang="de"><h1>' + escape(title) + '</h1><p>' + escape(draft['seo']['meta_description'])
               + '</p><h2>Produktdetails und Varianten</h2><p>Vergleiche die aktuellen Angaben auf der Produktseite.</p>'
               + '<a rel="noopener" href="' + escape(link, quote=True) + '">Produkt im Shop ansehen</a></article>')
    return {
        'meta_experiment': {'ad': draft['ad'], 'product_url': link,
                            'execution': 'existing_campaign_only', 'budget_increase_authorized': False},
        'social_content': draft['social'],
        'seo_geo': {'seo': draft['seo'], 'geo': draft['geo']},
        'landing_content': {'title': title, 'body_html': landing, 'source_url': link,
                            'publication_status': 'draft', 'existing_consumer': '/api/marketing/v2/seo/guides'},
        'email_sequence': {'recipient_count': 0, 'send_enabled': False,
            'messages': [
                {'stage': 'discovery', 'subject': f'{title[:65]} bei Homestro entdecken',
                 'body': f'Du möchtest dir {title} genauer ansehen? Produktdetails und aktuelle Varianten findest du hier: {link}'},
                {'stage': 'consideration', 'subject': 'Passt der Artikel zu deinem Alltag?',
                 'body': f'Vergleiche vor dem Kauf die Beschreibung und verfügbaren Varianten von {title}: {link}'},
                {'stage': 'decision', 'subject': 'Alle Produktinformationen an einem Ort',
                 'body': f'Die aktuellen Preise und die Verfügbarkeit findest du direkt im Homestro-Shop: {link}'},
            ]},
        'google_search': {'status': 'draft', 'language': 'de', 'countries': ['DE', 'AT'],
            'headline_candidates': ['Bei Homestro entdecken', 'Produktdetails ansehen'],
            'keyword_hypotheses': [title], 'search_volume': None, 'keyword_demand_verified': False,
            'destination': link, 'daily_budget_eur': 0, 'live_activation_authorized': False},
        'bing_search': {'status': 'draft', 'language': 'de', 'countries': ['DE', 'AT'],
            'headline_candidates': ['Bei Homestro entdecken', 'Varianten im Shop ansehen'],
            'keyword_hypotheses': [title], 'search_volume': None, 'keyword_demand_verified': False,
            'destination': link, 'daily_budget_eur': 0, 'live_activation_authorized': False},
    }


class MarketingDirector:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS pilot_marketing_work (
                id TEXT PRIMARY KEY, brand TEXT NOT NULL, product_path TEXT NOT NULL, kind TEXT NOT NULL,
                revision TEXT NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL,
                created_at TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS pilot_work_state ON pilot_marketing_work(state,priority)')
            db.execute('CREATE TABLE IF NOT EXISTS pilot_marketing_strategy (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')

    def reconcile(self, products, evidence, *, now=None):
        now = now or datetime.now(UTC)
        if now.tzinfo is None:
            raise ValueError('TIMEZONE_REQUIRED')
        local_day = now.astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
        brand_context = BrandMemory(self.audit).context()
        selected, seen, rejected = [], set(), 0
        for raw in products:
            try:
                path = canonical(raw['link'])
                pack = campaign_pack(raw)
            except (ValueError, TypeError, KeyError):
                rejected += 1
                continue
            if path in seen:
                continue
            seen.add(path)
            selected.append((raw, path, pack))
        cognitive = evidence.get('cognitive') or {}
        preferred = (cognitive.get('decision') or {}).get('editorial_product_priority', [])
        selected.sort(key=lambda item: (preferred.index(str(item[0]['id'])) if str(item[0]['id']) in preferred else len(preferred)))
        catalog = evidence.get('catalog_work') or {}
        consumers = {}
        try:
            checked = datetime.fromisoformat(str(catalog.get('generated_at', '')).replace('Z', '+00:00'))
            fresh_catalog = (catalog.get('status') == 'observed' and catalog.get('enabled') is True
                             and checked.tzinfo is not None and -60 <= (now - checked).total_seconds() <= 900)
        except (ValueError, TypeError):
            fresh_catalog = False
        if fresh_catalog:
            for item in catalog.get('products', [])[:2000]:
                try:
                    path = canonical(item['source_url'])
                    if item.get('eligible') is True and item.get('revision') and item.get('product_id'):
                        consumers[path] = item
                except (ValueError, TypeError, KeyError):
                    continue
        at = now.isoformat()
        expires = (now + timedelta(hours=6)).isoformat()
        created, refreshed = 0, 0
        with closing(self.audit._connect()) as db, db:
            for raw, path, pack in selected:
                revision = digest({'brief': BRIEF_HASH, 'pack': pack, 'brand_memory': brand_context['revision']})
                db.execute("UPDATE pilot_marketing_work SET state='superseded' WHERE product_path=? AND revision<>? AND state<>'superseded'",
                           (path, revision))
                for kind, content in pack.items():
                    key = digest(['Homestro', path, kind, revision])
                    blockers = list(BLOCKERS[kind])
                    receipt = None
                    if kind in {'google_search', 'bing_search'}:
                        channel = 'google' if kind == 'google_search' else 'microsoft'
                        if (evidence.get('search_channels') or {}).get(channel, {}).get('status') == 'observed':
                            blockers = [b for b in blockers if 'ACCOUNT_CONNECTION_UNVERIFIED' not in b]
                    if kind == 'social_content' and path in consumers:
                        consumer = consumers[path]
                        rows = consumer.get('receipts') or []
                        if any(row.get('status') in {'draft_queued', 'approved', 'publishing', 'remote_pending', 'published'}
                               and type(row.get('count')) is int and row['count'] > 0 for row in rows):
                            receipt = {'observed_at': at, 'source_product_id': consumer['product_id'],
                                'source_revision': consumer['revision'], 'source_url': consumer['source_url'],
                                'queues': rows, 'evidence_level': 'exact_publisher_source_revision_database_readback',
                                'platform_visibility_independently_verified': False,
                                'feed_revision_equivalence_verified': False, 'fresh': True}
                            blockers = []
                    claim = evidence.get('claim') or {}
                    if kind == 'meta_experiment':
                        if not claim.get('campaign_id'):
                            blockers.append('EXISTING_MANAGED_CAMPAIGN_REQUIRED')
                        if str(claim.get('status', '')).startswith('STOPPED_'):
                            blockers.append('DURABLE_CAMPAIGN_STOP')
                    state = ('consumer_evidence_observed' if receipt else
                             'blocked' if blockers else 'managed_by_existing_consumer')
                    if receipt is None:
                        saved = db.execute('SELECT payload FROM pilot_marketing_work WHERE id=?', (key,)).fetchone()
                        if saved:
                            historical = json.loads(saved[0]).get('receipt')
                            if historical:
                                receipt = {**historical, 'fresh': False}

                    priority = 70 if str(raw['id']) in preferred else 40 if kind == 'seo_geo' else 20
                    payload = {'brand': 'Homestro', 'source_product_id': str(raw['id']), 'source_url': raw['link'],
                        'brief_version': BRIEF['version'], 'brief_hash': BRIEF_HASH, 'owner': OWNERS[kind],
                        'brand_context': brand_context,
                        'blockers': blockers, 'content': content, 'publication_confirmed': False,
                        'receipt': receipt, 'paid_generation_performed': False,
                        'dispatch': 'existing_consumer_only_no_external_write'}
                    inserted = db.execute('INSERT OR IGNORE INTO pilot_marketing_work VALUES (?,?,?,?,?,?,?,?,?,?)',
                        (key, 'Homestro', path, kind, revision, state, priority,
                         at, expires, json.dumps(payload, ensure_ascii=False))).rowcount
                    created += inserted
                    if not inserted:
                        # No public API can mark a task published or manufacture a receipt.
                        db.execute('UPDATE pilot_marketing_work SET state=?,expires_at=?,payload=?,priority=? WHERE id=?',
                                   (state, expires, json.dumps(payload, ensure_ascii=False), priority, key))
                        refreshed += 1
            # Product disappearance/unavailability retires its old proposals immediately.
            rows = db.execute("SELECT DISTINCT product_path FROM pilot_marketing_work WHERE state<>'superseded'").fetchall()
            for (path,) in rows:
                if path not in seen:
                    db.execute("UPDATE pilot_marketing_work SET state='superseded' WHERE product_path=?", (path,))
            counts = dict(db.execute('SELECT state,count(*) FROM pilot_marketing_work GROUP BY state').fetchall())
            control = evidence.get('controller') or {}
            action = ('KEEP_DURABLE_STOP' if str((evidence.get('claim') or {}).get('status', '')).startswith('STOPPED_')
                      else control.get('next_action', 'REFRESH_FEED_AND_PERFORMANCE'))
            strategy = {'status': 'planned', 'checked_at': at, 'brand': BRIEF.copy(), 'local_day': local_day,
                'source_product_count': len(products), 'distinct_eligible_products': len(selected),
                'invalid_candidates': rejected, 'new_tasks': created, 'refreshed_tasks': refreshed,
                'queue_counts': counts, 'next_action': action,
                'decision_basis': 'validated_catalog_cost_policy_provider_evidence_and_existing_controller',
                'objectives': ['qualified_product_visits', 'measured_purchases', 'contribution_after_actual_costs'],
                'funnel': ['discovery', 'consideration', 'decision'],
                'calendar': [{'date': (now.astimezone(ZoneInfo('Europe/Berlin')).date() + timedelta(days=day)).isoformat(),
                    'product_ids': [str(item[0]['id']) for item in selected[day::7][:3]],
                    'channels': ['facebook', 'instagram', 'pinterest', 'tiktok'], 'state': 'proposal',
                    'existing_publisher_limits_apply': True} for day in range(7)],
                'single_paid_budget_eur_per_day': 5, 'additional_channel_budget_eur': 0,
                'budget_increase_authorized': False, 'full_vendor_parity_verified': False,
                'queue_is_not_publication': True, 'email_send_enabled': False,
                'observed_organic_publisher': evidence.get('organic', {'status': 'not_observed'}),
                'catalog_consumer_evidence': {'fresh': fresh_catalog, 'matched_product_count': len(consumers),
                    'coverage_complete': catalog.get('coverage_complete') is True, 'pages_read': catalog.get('pages_read')},
                'search_channel_observations': evidence.get('search_channels', {}),
                'cognitive_strategy': cognitive,
                'sales_goals': evidence.get('sales_goals', {'status': 'not_observed'}),
                'brand_memory': {'revision': brand_context['revision'], 'evidence_ids': brand_context['evidence_ids'],
                                 'evidence_level': brand_context['evidence_level']},
                'integration_dependencies': sorted({b for row in db.execute("SELECT payload FROM pilot_marketing_work WHERE state<>'superseded'").fetchall() for b in json.loads(row[0]).get('blockers', [])})}
            db.execute('INSERT INTO pilot_marketing_strategy VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
                       (json.dumps(strategy, ensure_ascii=False),))
        return strategy

    def report(self, *, limit=50, now=None):
        now = now or datetime.now(UTC)
        limit = max(1, min(limit, 100))
        with closing(self.audit._connect()) as db:
            stored = db.execute('SELECT payload FROM pilot_marketing_strategy WHERE id=1').fetchone()
            rows = db.execute("SELECT id,kind,state,expires_at,payload FROM pilot_marketing_work WHERE state<>'superseded' ORDER BY priority DESC,id LIMIT ?", (limit,)).fetchall()
        tasks = []
        for key, kind, state, expires_at, raw in rows:
            payload = json.loads(raw)
            tasks.append({'id': key, 'kind': kind, 'state': state,
                          'stale': datetime.fromisoformat(expires_at) < now, **payload})
        return {'strategy': json.loads(stored[0]) if stored else None, 'tasks': tasks,
                'full_vendor_parity_verified': False, 'publication_performed_by_this_endpoint': False}
