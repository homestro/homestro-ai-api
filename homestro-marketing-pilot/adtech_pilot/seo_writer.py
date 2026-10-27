"""Durable, missing-only Shopify SEO revisions; never changes product/theme content."""
from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import closing
from urllib.parse import unquote, urlsplit

import httpx

from .content_engine import product_draft

READ = '''query PilotSEOProduct($id: ID!) { productVariant(id:$id) { product {
 id title handle status onlineStoreUrl updatedAt seo { title description } } } }'''
WRITE = '''mutation PilotSEOUpdate($product: ProductUpdateInput!) { productUpdate(product:$product) {
 product { id seo { title description } } userErrors { field message } } }'''


class SEORevisionWriter:
    def __init__(self, audit, *, env=None, client=None):
        self.audit, self.env, self.client = audit, os.environ if env is None else env, client
        with closing(audit._connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS pilot_seo_revisions (product TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS pilot_seo_cursor (name TEXT PRIMARY KEY, position INTEGER NOT NULL)')

    def load(self, product):
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT payload FROM pilot_seo_revisions WHERE product=?', (product,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, product, record, *, reserve=False):
        with closing(self.audit._connect()) as db, db:
            if reserve:
                return db.execute('INSERT OR IGNORE INTO pilot_seo_revisions VALUES (?,?)',
                                  (product, json.dumps(record))).rowcount == 1
            db.execute('UPDATE pilot_seo_revisions SET payload=? WHERE product=?', (json.dumps(record), product))
        return True

    async def cycle(self, products, *, limit=5):
        if self.env.get('PILOT_SEO_AUTOPUBLISH', 'true') != 'true':
            return {'status': 'disabled', 'mutations_performed': False}
        domain = self.env.get('SHOPIFY_STORE_DOMAIN', '').removeprefix('https://').rstrip('/')
        version = self.env.get('SHOPIFY_API_VERSION', '2026-07')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com', domain) or not re.fullmatch(r'20\d{2}-(01|04|07|10)', version):
            return {'status': 'blocked', 'reason': 'SEO_STORE_CONFIGURATION_UNAVAILABLE'}
        own = self.client is None
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
        results = []
        try:
            token = self.env.get('SHOPIFY_ACCESS_TOKEN', '')
            if not token:
                if not self.env.get('SHOPIFY_CLIENT_ID') or not self.env.get('SHOPIFY_CLIENT_SECRET'):
                    return {'status': 'blocked', 'reason': 'SEO_EXISTING_APP_CREDENTIALS_UNAVAILABLE'}
                response = await client.post(f'https://{domain}/admin/oauth/access_token', data={
                    'grant_type': 'client_credentials', 'client_id': self.env['SHOPIFY_CLIENT_ID'],
                    'client_secret': self.env['SHOPIFY_CLIENT_SECRET']})
                response.raise_for_status()
                token = response.json()['access_token']
            async def graphql(query, variables):
                response = await client.post(f'https://{domain}/admin/api/{version}/graphql.json',
                    headers={'X-Shopify-Access-Token': token}, json={'query': query, 'variables': variables})
                response.raise_for_status()
                body = response.json()
                if body.get('errors'):
                    raise ValueError('SEO_GRAPHQL_REJECTED')
                return body['data']
            with closing(self.audit._connect()) as db:
                row = db.execute("SELECT position FROM pilot_seo_cursor WHERE name='catalog'").fetchone()
            position = (row[0] if row else 0) % max(len(products), 1)
            for offset in range(min(limit, len(products))):
                raw = products[(position + offset) % len(products)]
                try:
                    # Source eligibility is local. A sold-out/rejected row must not
                    # poison the persisted cursor or prevent valid later products.
                    product_draft(raw)
                    eligible_source = True
                except (ValueError, KeyError, TypeError):
                    eligible_source = False
                    results.append({'status': 'skipped', 'reason': 'SOURCE_PRODUCT_NOT_ELIGIBLE'})
                if eligible_source and not re.fullmatch(r'gid://shopify/ProductVariant/[1-9]\d*', str(raw.get('id', ''))):
                    eligible_source = False
                    results.append({'status': 'skipped', 'reason': 'SEO_VARIANT_IDENTITY_REQUIRED'})
                if eligible_source:
                    try:
                        result = await self.revise(raw, graphql)
                        results.append(result)
                    except (ValueError, KeyError, TypeError, httpx.HTTPError) as exc:
                        reason = 'SEO_GRAPHQL_REJECTED' if str(exc) == 'SEO_GRAPHQL_REJECTED' else 'SEO_REMOTE_REQUEST_UNCONFIRMED'
                        results.append({'status': 'unavailable', 'error_type': type(exc).__name__, 'reason': reason})
                        # Keep this cursor on provider/network failures. Never replay
                        # an uncertain write; revise() reconciles its durable intent.
                        break
                with closing(self.audit._connect()) as db, db:
                    db.execute("INSERT INTO pilot_seo_cursor VALUES ('catalog',?) ON CONFLICT(name) DO UPDATE SET position=excluded.position",
                               ((position + offset + 1) % len(products),))
            return {'status': 'checked', 'items': results, 'checked': len(results),
                    'confirmed_revisions': sum(item['status'] == 'confirmed' for item in results),
                    'ineligible_sources_skipped': sum(item['status'] == 'skipped' for item in results),
                    'policy': 'fill_missing_only', 'theme_writes': False, 'geo_theme_publication': False,
                    'concurrency_guard': 'read_before_write_not_atomic_provider_cas'}
        finally:
            if own:
                await client.aclose()

    async def revise(self, raw, graphql):
        draft = product_draft(raw)
        async def read():
            data = await graphql(READ, {'id': draft['product_id']})
            return data['productVariant']['product']
        product = await read()
        product_id = product['id']
        state = await asyncio.to_thread(self.load, product_id)
        if state:
            if state['status'] in {'pending', 'uncertain'}:
                if all(product['seo'].get(key) == value for key, value in state['patch'].items()):
                    state['status'] = 'confirmed'
                    await asyncio.to_thread(self.save, product_id, state)
                    return {'status': 'confirmed', 'product_id': product_id, 'reconciled': True}
                return {'status': 'hold', 'product_id': product_id, 'reason': 'UNCERTAIN_REVISION_NO_RETRY'}
            return {'status': 'preserved', 'product_id': product_id, 'reason': 'REVISION_ALREADY_RECORDED'}
        target = urlsplit(product.get('onlineStoreUrl') or '')
        source = urlsplit(draft['source_url'])
        if (product['status'] != 'ACTIVE' or target.hostname not in {'homestro.de', 'www.homestro.de'}
                or unquote(target.path) != unquote(source.path) or product['title'] != raw['title']):
            return {'status': 'hold', 'product_id': product_id, 'reason': 'SOURCE_PRODUCT_CHANGED_OR_UNPUBLISHED'}
        before = product['seo']
        patch = {key: value for key, value in {'title': draft['seo']['title'],
                 'description': draft['seo']['meta_description']}.items() if not (before.get(key) or '').strip()}
        if not patch:
            return {'status': 'preserved', 'product_id': product_id, 'reason': 'EXISTING_SEO_PRESERVED'}
        fresh = await read()
        if fresh != product:
            return {'status': 'hold', 'product_id': product_id, 'reason': 'CONCURRENT_PRODUCT_CHANGE'}
        state = {'status': 'pending', 'before': before, 'patch': patch,
                 'source_updated_at': product['updatedAt'], 'brief_hash': draft['brief_hash']}
        if not await asyncio.to_thread(self.save, product_id, state, reserve=True):
            return {'status': 'hold', 'product_id': product_id, 'reason': 'REVISION_RESERVED'}
        try:
            data = await graphql(WRITE, {'product': {'id': product_id, 'seo': patch}})
            payload = data['productUpdate']
            if payload['userErrors']:
                state['status'] = 'rejected'
                await asyncio.to_thread(self.save, product_id, state)
                return {'status': 'rejected', 'product_id': product_id, 'reason': 'SEO_PRODUCT_UPDATE_REJECTED'}
            verified = await read()
            if not all(verified['seo'].get(key) == value for key, value in patch.items()):
                raise ValueError('SEO_READBACK_MISMATCH')
            state['status'] = 'confirmed'
            await asyncio.to_thread(self.save, product_id, state)
            return {'status': 'confirmed', 'product_id': product_id, 'fields': list(patch)}
        except (ValueError, KeyError, TypeError, httpx.HTTPError):
            state['status'] = 'uncertain'
            await asyncio.to_thread(self.save, product_id, state)
            return {'status': 'hold', 'product_id': product_id, 'reason': 'UNCERTAIN_REVISION_NO_RETRY'}
