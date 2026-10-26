"""Versioned owner-reviewed brand evidence. Stored text is data, never authority.

No generation, sending, publication or budget permission can be granted here.
Product facts remain bound to the exact current product source revision.
"""
from __future__ import annotations

import hashlib
import json
from contextlib import closing
from datetime import UTC, datetime
from urllib.parse import urlsplit

KINDS = {'positioning', 'audience', 'voice', 'story', 'product_fact'}


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def validate_entries(entries):
    if not isinstance(entries, list) or len(entries) > 100:
        raise ValueError('BRAND_MEMORY_ENTRY_LIMIT')
    clean, seen = [], set()
    fields = {'id', 'kind', 'text_de', 'source_url', 'reviewed', 'product_id', 'source_revision'}
    for row in entries:
        if not isinstance(row, dict) or set(row) - fields:
            raise ValueError('BRAND_MEMORY_INVALID_ENTRY')
        key = row.get('id')
        if not isinstance(key, str) or not 1 <= len(key) <= 80 or not all(c.isascii() and (c.isalnum() or c in '-_') for c in key) or key in seen:
            raise ValueError('BRAND_MEMORY_INVALID_ID')
        seen.add(key)
        if row.get('kind') not in KINDS or row.get('reviewed') is not True:
            raise ValueError('BRAND_MEMORY_REVIEW_REQUIRED')
        text = row.get('text_de')
        if not isinstance(text, str) or not 5 <= len(text.strip()) <= 700 or any(ord(c) < 32 for c in text):
            raise ValueError('BRAND_MEMORY_INVALID_TEXT')
        source = row.get('source_url')
        if not isinstance(source, str) or len(source) > 1024:
            raise ValueError('BRAND_MEMORY_SOURCE_REQUIRED')
        url = urlsplit(source)
        if url.scheme != 'https' or url.hostname not in {'homestro.de', 'www.homestro.de'} or url.username or url.password or url.port not in {None, 443} or url.query or url.fragment:
            raise ValueError('BRAND_MEMORY_SOURCE_REQUIRED')
        product_id, source_revision = row.get('product_id'), row.get('source_revision')
        if row['kind'] == 'product_fact':
            if not isinstance(product_id, str) or not 1 <= len(product_id) <= 128 or not isinstance(source_revision, str) or len(source_revision) != 64 or any(c not in '0123456789abcdef' for c in source_revision):
                raise ValueError('BRAND_MEMORY_PRODUCT_REVISION_REQUIRED')
        elif product_id is not None or source_revision is not None:
            raise ValueError('BRAND_MEMORY_UNEXPECTED_PRODUCT_SCOPE')
        clean.append({'id': key, 'kind': row['kind'], 'text_de': text.strip(), 'source_url': source,
                      'reviewed': True, 'product_id': product_id, 'source_revision': source_revision})
    return sorted(clean, key=lambda row: row['id'])


class BrandMemory:
    def __init__(self, audit):
        self.audit = audit
        with closing(audit._connect()) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS pilot_brand_memory (
                revision TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS pilot_brand_memory_head (
                id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL)''')

    def read(self):
        with closing(self.audit._connect()) as db:
            row = db.execute('SELECT m.payload FROM pilot_brand_memory m JOIN pilot_brand_memory_head h ON h.revision=m.revision WHERE h.id=1').fetchone()
        return json.loads(row[0]) if row else {'brand': 'Homestro', 'revision': revision([]), 'entries': [], 'created_at': None}

    def replace(self, entries, *, expected_revision, now=None):
        entries = validate_entries(entries)
        now = now or datetime.now(UTC)
        if now.tzinfo is None:
            raise ValueError('TIMEZONE_REQUIRED')
        payload = {'brand': 'Homestro', 'revision': revision(entries), 'entries': entries, 'created_at': now.isoformat()}
        with closing(self.audit._connect()) as db, db:
            db.execute('BEGIN IMMEDIATE')
            head = db.execute('SELECT revision FROM pilot_brand_memory_head WHERE id=1').fetchone()
            if expected_revision != (head[0] if head else revision([])):
                raise ValueError('BRAND_MEMORY_REVISION_CONFLICT')
            db.execute('INSERT OR IGNORE INTO pilot_brand_memory VALUES (?,?,?)',
                       (payload['revision'], payload['created_at'], json.dumps(payload, ensure_ascii=False)))
            db.execute('INSERT INTO pilot_brand_memory_head VALUES (1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision', (payload['revision'],))
            stored = db.execute('SELECT payload FROM pilot_brand_memory WHERE revision=?', (payload['revision'],)).fetchone()
        return json.loads(stored[0])

    def context(self, *, product_id=None, source_revision=None):
        stored = self.read()
        entries = [row for row in stored['entries'] if row['kind'] != 'product_fact' or
                   (row['product_id'] == product_id and row['source_revision'] == source_revision)]
        return {'brand': 'Homestro', 'revision': stored['revision'], 'entries': entries,
                'evidence_ids': ['brand:' + row['id'] for row in entries],
                'evidence_level': 'owner_reviewed_not_independently_verified',
                'publication_authorized': False, 'paid_generation_authorized': False}
