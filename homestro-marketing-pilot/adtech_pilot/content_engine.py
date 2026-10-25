"""Grounded German marketing/search drafts from validated catalog facts.

No external model, publishing, search inclusion or ranking guarantee.
"""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlsplit, urlunsplit

from .feed_manager import FeedProduct
from .website_ads import website_story

BRIEF = {
    'brand': 'Homestro', 'language': 'de', 'markets': ['DE', 'AT'],
    'voice': 'sachlich, klar, nachvollziehbar', 'version': '2026-10-25.1',
    'claims_policy': 'Only validated feed facts; no invented benefits, guarantees, delivery promises or reviews.',
}
BRIEF_HASH = hashlib.sha256(json.dumps(BRIEF, sort_keys=True).encode()).hexdigest()[:16]


def product_draft(raw):
    """Build a reviewable search/ad pack; original product name is never translated by guesswork."""
    website_story([raw], '12345')
    product = FeedProduct.model_validate(raw)
    title = ' '.join(re.sub(r'<[^>]*>', '', product.title).split())[:180]
    if not title:
        raise ValueError('EMPTY_PRODUCT_NAME')
    parsed = urlsplit(product.link)
    # A canonical suggestion targets the product page, not campaign/variant parameters.
    canonical = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))
    description = f'{title} bei Homestro entdecken. Produktdetails, Varianten und den aktuellen Preis im Shop ansehen.'
    schema = {'@context': 'https://schema.org', '@type': 'Product', 'name': title,
              'url': product.link, 'image': [product.image_link],
              'offers': {'@type': 'Offer', 'url': product.link, 'priceCurrency': 'EUR',
                         'price': str(product.price), 'availability': 'https://schema.org/InStock'}}
    return {
        'product_id': product.id, 'brief_version': BRIEF['version'], 'brief_hash': BRIEF_HASH,
        'source': 'validated_shopify_feed', 'source_url': product.link, 'language': 'de',
        'product_name_language_verified': False,
        'ad': {'primary_text': f'{title}: Details und aktuelle Preise bei Homestro entdecken.',
               'headline': 'Bei Homestro entdecken', 'call_to_action': 'SHOP_NOW'},
        'social': {'text': f'{title} bei Homestro. Schau dir die Produktdetails und verfügbaren Varianten im Shop an.',
                   'destination': product.link, 'publication_status': 'draft'},
        'seo': {'title': (title[:45] + ' | Homestro'), 'meta_description': description[:155],
                'h1': title, 'canonical_suggestion': canonical, 'publication_status': 'draft'},
        'geo': {'answer': f'Wo finde ich {title}? Bei Homestro: {product.link}',
                'product_json_ld': schema, 'basis': 'explicit_product_name_price_currency_availability_and_own_url',
                'ai_search_inclusion_verified': False, 'publication_status': 'draft'},
        'unsupported_claims_added': False, 'paid_generation_performed': False,
        'storefront_mutations_performed': False, 'publication_performed': False,
        'requires_refresh_before_publication': True,
    }


def content_batch(products, *, limit=3):
    drafts, seen, rejected = [], set(), 0
    for raw in products:
        try:
            draft = product_draft(raw)
        except (ValueError, TypeError, KeyError):
            rejected += 1
            continue
        canonical = draft['seo']['canonical_suggestion']
        if canonical in seen:
            continue
        seen.add(canonical)
        drafts.append(draft)
        if len(drafts) >= limit:
            break
    return {'status': 'drafted', 'brief': BRIEF.copy(), 'brief_hash': BRIEF_HASH,
            'draft_count': len(drafts), 'invalid_candidates_skipped': rejected, 'drafts': drafts,
            'publication_performed': False, 'ai_search_inclusion_verified': False,
            'remaining_publication_dependency': 'SHOPIFY_REVIEWED_CONTENT_REVISION_WRITER'}
