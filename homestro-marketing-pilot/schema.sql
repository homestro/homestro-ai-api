CREATE TABLE IF NOT EXISTS marketing_products (
  id text PRIMARY KEY, document jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('pending_marketing','ready','error')),
  reasons jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_posts (
  id uuid PRIMARY KEY, product_id text NOT NULL REFERENCES marketing_products(id),
  channel text NOT NULL CHECK(channel IN ('facebook','instagram')),
  revision text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL CHECK(status IN
    ('draft_queued','approved','publishing','published','recovery_required','rejected','superseded')),
  remote jsonb NOT NULL DEFAULT '{}', error_code text,
  approved_by text, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, channel, revision)
);
CREATE INDEX IF NOT EXISTS marketing_queue ON marketing_posts(status,created_at);
CREATE TABLE IF NOT EXISTS marketing_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id uuid REFERENCES marketing_posts(id), code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_inputs (
  product_id text PRIMARY KEY, inputs jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing_posts ADD COLUMN IF NOT EXISTS published_at timestamptz;
-- Preserve the oldest recorded publication event; later link checks cannot reset quotas.
UPDATE marketing_posts s SET published_at=COALESCE(
  (SELECT min(e.created_at) FROM marketing_events e WHERE e.post_id=s.id AND e.code='published'),s.updated_at)
WHERE s.status='published' AND s.published_at IS NULL;

CREATE TABLE IF NOT EXISTS marketing_seo_articles (
  handle text PRIMARY KEY,
  content_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('creating','draft_created','published','failed','recovery_required','external_exists')),
  shopify_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE marketing_seo_articles DROP CONSTRAINT IF EXISTS marketing_seo_articles_status_check;
ALTER TABLE marketing_seo_articles ADD CONSTRAINT marketing_seo_articles_status_check
  CHECK(status IN ('creating','draft_created','published','failed','recovery_required','external_exists'));

CREATE TABLE IF NOT EXISTS marketing_clicks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id text NOT NULL REFERENCES marketing_products(id),
  channel text NOT NULL CHECK(channel IN ('facebook','instagram','tiktok','pinterest')),
  format text NOT NULL CHECK(format IN ('image','carousel','reels')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_clicks_created ON marketing_clicks(created_at,channel);

CREATE TABLE IF NOT EXISTS marketing_seo_pages (
  handle text PRIMARY KEY,content_hash text NOT NULL,body_hash text,
  status text NOT NULL CHECK(status IN ('creating','published','paused','failed','recovery_required')),
  product_ids jsonb NOT NULL DEFAULT '[]',shopify_id text,url text,
  attempted_at timestamptz,published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_performance (
  window_days integer PRIMARY KEY,payload jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_pilot_state (
  key text PRIMARY KEY,value text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_seo_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle text NOT NULL REFERENCES marketing_seo_pages(handle),attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_seo_attempts_time ON marketing_seo_attempts(attempted_at);

