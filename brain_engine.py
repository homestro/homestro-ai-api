#!/usr/bin/env python3
"""Unified Homestro/MS Handwerk operational brain (stdlib only).

This module syncs the public Shopify catalog, diagnoses compare-at prices,
applies safe Shopify fixes only with a working Admin API token, and persists
rotation/content state. Social publication remains delegated to the reviewed
Meta/Zernio publisher in the Node runtime.
"""
from __future__ import annotations
import json, os, random, re, sys, tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DATA_DIR = Path(os.getenv("BRAIN_DATA_DIR", "/data"))
CTA = "Jetzt entdecken auf homestro.de – bequem mit PayPal & Klarna."
HOOK_FILE = Path(os.getenv("JARVIS_USED_HOOKS_PATH", str(DATA_DIR / "jarvis-used-hooks.json")))
SHOP = "https://homestro.de"

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def read_json(path, fallback):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass

def request_json(url, *, method="GET", headers=None, body=None, timeout=25):
    req = Request(url, data=body, headers=headers or {}, method=method)
    with urlopen(req, timeout=timeout) as res:
        raw = res.read(12 * 1024 * 1024 + 1)
        if len(raw) > 12 * 1024 * 1024:
            raise ValueError("RESPONSE_TOO_LARGE")
        return json.loads(raw.decode("utf-8"))

def public_catalog():
    data = request_json(SHOP + "/products.json?limit=250",
        headers={"Accept": "application/json", "User-Agent": "HomestroBrain/1.0"})
    rows = data.get("products") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ValueError("PUBLIC_CATALOG_MISSING_PRODUCTS")
    return [p for p in rows if isinstance(p, dict) and p.get("handle")
        and (not p.get("status") or str(p.get("status")).upper() == "ACTIVE")]

def shopify_graphql(query, variables, token, domain):
    body = json.dumps({"query": query, "variables": variables}).encode()
    envelope = request_json(f"https://{domain}/admin/api/2026-07/graphql.json", method="POST",
        headers={"Accept":"application/json","Content-Type":"application/json",
                 "X-Shopify-Access-Token":token}, body=body)
    errors = envelope.get("errors") or []
    if errors:
        message = " ".join(str(row.get("message") or "") for row in errors if isinstance(row, dict))
        if "authentication required" in message.casefold() or "unauthorized" in message.casefold():
            raise ValueError("Authentication required")
        raise ValueError("ADMIN_GRAPHQL_QUERY_FAILED")
    return envelope.get("data") or {}

def admin_token(domain):
    direct = (os.getenv("SHOPIFY_ACCESS_TOKEN") or
              os.getenv("SHOPIFY_ADMIN_API_ACCESS_TOKEN") or "").strip()
    if direct:
        return direct, "direct_token"
    client_id = (os.getenv("SHOPIFY_CLIENT_ID") or "").strip()
    secret = (os.getenv("SHOPIFY_CLIENT_SECRET") or "").strip()
    if not client_id or not secret:
        return None, "credentials_missing"
    body = ("client_id=" + client_id + "&client_secret=" + secret +
            "&grant_type=client_credentials").encode()
    data = request_json(f"https://{domain}/admin/oauth/access_token", method="POST",
        headers={"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"}, body=body)
    token = data.get("access_token")
    if not token:
        return None, "token_exchange_rejected"
    return str(token), "client_credentials"

def admin_catalog(token, domain):
    query = """query ActiveProducts($after:String) {
      products(first:250,after:$after,query:"status:active") {
        nodes { id title handle status onlineStoreUrl tags variants(first:100) {
          nodes { id price compareAtPrice }
        } pageInfo { hasNextPage endCursor }
      }
    }"""
    rows, after = [], None
    while True:
        data = shopify_graphql(query, {"after":after}, token, domain)
        connection = data.get("products") if isinstance(data, dict) else None
        if not connection:
            raise ValueError("ADMIN_CATALOG_QUERY_FAILED")
        rows.extend(connection.get("nodes") or [])
        page = connection.get("pageInfo") or {}
        if not page.get("hasNextPage"):
            return rows
        after = page.get("endCursor")
        if not after or len(rows) > 5000:
            raise ValueError("ADMIN_CATALOG_PAGINATION_INVALID")

def fix_product(product, token, domain):
    pid = product.get("id")
    invalid = []
    for variant in (product.get("variants") or {}).get("nodes", []):
        price, anchor = variant.get("price"), variant.get("compareAtPrice")
        try:
            if anchor is not None and float(anchor) <= float(price):
                invalid.append({"id":variant["id"], "compareAtPrice":None})
        except (TypeError, ValueError, KeyError):
            continue
    if invalid:
        mutation = """mutation FixAnchors($productId:ID!,$variants:[ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId:$productId,variants:$variants) {
            productVariants { id price compareAtPrice } userErrors { field message }
          }
        }"""
        result = shopify_graphql(mutation, {"productId":pid,"variants":invalid}, token, domain)
        errs = (result.get("productVariantsBulkUpdate") or {}).get("userErrors") or []
        if errs:
            raise ValueError("PRICE_FIX_REJECTED")
    tags = [str(t) for t in (product.get("tags") or [])]
    clean = [t for t in tags if t not in {"⚠️-chybi-foto","⚠️-nizka-cena"}]
    if clean != tags:
        mutation = """mutation CleanTags($product:ProductInput!) {
          productUpdate(input:$product) { product { id tags } userErrors { field message } }
        }"""
        result = shopify_graphql(mutation, {"product":{"id":pid,"tags":clean}}, token, domain)
        errs = (result.get("productUpdate") or {}).get("userErrors") or []
        if errs:
            raise ValueError("TAG_CLEANUP_REJECTED")
    return len(invalid), int(clean != tags)

def diagnostics(products):
    issues = []
    for product in products:
        variants = product.get("variants") or []
        if isinstance(variants, dict):
            variants = variants.get("nodes") or []
        for variant in variants:
            try:
                price = float(variant.get("price") or 0)
                anchor = variant.get("compareAtPrice", variant.get("compare_at_price"))
                if anchor is not None and float(anchor) <= price:
                    issues.append({"product_id":product.get("id"),"handle":product.get("handle"),
                        "variant_id":variant.get("id"),"price":price,"compare_at_price":float(anchor),
                        "issue":"COMPARE_AT_NOT_ABOVE_PRICE"})
            except (TypeError, ValueError):
                continue
    return issues

def select_product(products, state, hooks):
    history = state.get("rotation_history", [])
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    recent = []
    for row in history:
        try:
            ts = datetime.fromisoformat(str(row.get("at","")).replace("Z","+00:00"))
            if ts >= cutoff:
                recent.append(row)
        except (ValueError, TypeError):
            pass
    blocked = {str(x.get("product_id")) for x in recent}
    last_four = {str(x.get("product_id")) for x in history[-4:]}
    candidates = [p for p in products if str(p.get("id")) not in blocked and str(p.get("id")) not in last_four]
    if not candidates:
        candidates = [p for p in products if str(p.get("id")) not in last_four]
    if not candidates:
        return None, None, None
    candidate = candidates[0]
    stem = re.sub(r"\s+", " ", re.sub(r"[^\w\säöüÄÖÜß-]", "", str(candidate.get("title") or "dieses Produkt"))).strip()
    stem = stem[:75] or "dieses Produkt"
    recipes = [
        f"Wenn {stem} im Alltag Zeit kostet: Diese Lösung macht den nächsten Schritt leichter.",
        f"Genug von kleinen Umwegen bei {stem}? So wird die tägliche Nutzung einfacher.",
        f"Du brauchst bei {stem} eine praktische Lösung statt zusätzlichem Aufwand?",
        f"Mehr Ruhe bei {stem}: Entdecke eine einfache Lösung für deinen Alltag.",
        f"Der Alltag ist schon voll genug. {stem} kann dir einen Handgriff abnehmen.",
        f"Schluss mit unnötigem Aufwand rund um {stem} – entdecke die praktische Alternative."
    ]
    used = {str(x.get("hook","")).casefold().strip() for x in hooks}
    random.shuffle(recipes)
    hook = next((x for x in recipes if x.casefold().strip() not in used), None)
    if not hook:
        return candidate, None, None
    caption = hook + "\n\n" + CTA
    return candidate, hook, caption

def update_ms_campaigns():
    path = DATA_DIR / "ms-handwerk-campaigns.json"
    safe = {
      "business":"MS Handwerkservice",
      "location":"Kempten 87xxx",
      "services":["Renovierung","Spachtelarbeiten","Laminat und Vinyl","Kleinreparaturen","Terrassen"],
      "claims":["Saubere und zuverlässige Arbeit","Faire Preise","Kurzfristige Termine möglich","Kostenlose Besichtigung"],
      "banned_claims":["Maler","Malerarbeiten"],
      "updated_at":now_iso(),
      "status":"ready_for_review"
    }
    atomic_json(path, safe)
    return safe

def run():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state_path = DATA_DIR / "brain-state.json"
    prior = read_json(state_path, {})
    domain = (os.getenv("SHOPIFY_STORE_DOMAIN") or "").strip().removeprefix("https://").removeprefix("http://").strip("/")
    admin_status, admin_source, fixed, cleaned = "unavailable", "none", 0, 0
    products, source = [], "public_products_json"
    if domain:
        try:
            token, admin_source = admin_token(domain)
            if token:
                products = admin_catalog(token, domain)
                source, admin_status = "shopify_admin_active", "authenticated"
                for p in products:
                    f, c = fix_product(p, token, domain)
                    fixed += f; cleaned += c
        except HTTPError as exc:
            admin_status = "authentication_required" if exc.code in (401,403) else f"http_{exc.code}"
        except Exception as exc:
            message = str(exc).casefold()
            admin_status = "authentication_required" if "authentication required" in message or "unauthorized" in message else "request_failed"
    if not products:
        products = public_catalog()
        source = "public_products_json_fallback"
    feed = {"generated_at":now_iso(),"source":source,"products":products}
    atomic_json(DATA_DIR / "active-feed.json", feed)
    issues = diagnostics(products)
    atomic_json(DATA_DIR / "store-diagnostics.json", {
        "generated_at":now_iso(),"active_products":len(products),"issues_found":len(issues),
        "price_fixes":fixed,"obsolete_tags_removed":cleaned,"admin_auth":admin_status,
        "admin_credential_source":admin_source,"issues":issues
    })
    hooks = read_json(HOOK_FILE, [])
    if isinstance(hooks, dict): hooks = hooks.get("events", [])
    if not isinstance(hooks, list): hooks = []
    candidate, hook, caption = select_product(products, prior, hooks)
    if candidate and hook:
        product_id = str(candidate.get("id") or "")
        event = {"at":now_iso(),"product_id":product_id,"hook":hook,"status":"prepared"}
        hooks.append(event)
        hooks = hooks[-20000:]
        atomic_json(HOOK_FILE, hooks)
        rotation = (prior.get("rotation_history") or []) + [event]
        prior.update({"last_selected_product":candidate.get("title"),
            "last_selected_product_id":product_id,"last_hook":hook,"last_caption":caption,
            "last_prepared_at":event["at"],"rotation_history":rotation[-500]})
    ms = update_ms_campaigns()
    prior.update({"status":"ACTIVE","last_run_at":now_iso(),"products_synced":len(products),
        "diagnostics_issues_found":len(issues),"price_fixes":fixed,"obsolete_tags_removed":cleaned,
        "catalog_source":source,"admin_auth":admin_status,"ad_spend_eur":0.0,
        "ms_handwerk_ready":True,"last_post_ids":prior.get("last_post_ids",[])})
    atomic_json(state_path, prior)
    return {"status":"ACTIVE","products_synced":len(products),"diagnostics_issues_found":len(issues),
        "price_fixes":fixed,"obsolete_tags_removed":cleaned,"admin_auth":admin_status,
        "catalog_source":source,"selected_product":candidate.get("title") if candidate else None,
        "hook":hook,"caption":caption,"ms_handwerk_ready":bool(ms),"ad_spend_eur":0.0}

def main():
    command = sys.argv[1] if len(sys.argv)>1 else "run"
    if command == "status":
        state = read_json(DATA_DIR/"brain-state.json", {})
        print(json.dumps(state,ensure_ascii=False))
        return
    result = run()
    print(json.dumps(result,ensure_ascii=False))

if __name__ == "__main__":
    main()
