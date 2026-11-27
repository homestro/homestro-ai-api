#!/usr/bin/env python3
"""Unified Homestro/MS Handwerk operational brain (stdlib only).

This module syncs the public Shopify catalog, diagnoses compare-at prices,
applies safe Shopify fixes only with a working Admin API token, and persists
rotation/content state. Social publication remains delegated to the reviewed
Meta/Zernio publisher in the Node runtime.
"""
from __future__ import annotations
import json, os, random, re, sys, tempfile, traceback, unicodedata
from urllib.parse import urlencode
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DATA_DIR = Path(os.getenv("BRAIN_DATA_DIR", "/data"))
CTA = "Jetzt entdecken auf homestro.de – sicher bestellen mit 30 Tagen Rückgaberecht."
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
    body = urlencode({"client_id":client_id,"client_secret":secret,
                       "grant_type":"client_credentials"}).encode()
    data = request_json(f"https://{domain}/admin/oauth/access_token", method="POST",
        headers={"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"}, body=body)
    token = data.get("access_token")
    if not token:
        return None, "token_exchange_rejected"
    return str(token), "client_credentials"

def admin_catalog(token, domain):
    query = """query ActiveProducts($after:String) {
      products(first:250,after:$after,query:"status:active") {
        nodes { id title handle status productType onlineStoreUrl tags variants(first:250) {
          nodes { id price compareAtPrice }
        } }
        pageInfo { hasNextPage endCursor }
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

def infer_product_type(product):
    title = str(product.get("title") or "").casefold()
    tags = " ".join(map(str, product.get("tags") or [])).casefold()
    text = title + " " + tags
    categories = [
        (r"hund|katze|tier|haustier|futterspender|fell|pfote", "Haustierbedarf"),
        (r"trinkflasche|wasserflasche|thermos|isolierflasche", "Trinkflaschen"),
        (r"fitness|massage|hantel|haltung|posture|faszien|sport|yoga", "Fitness & Gesundheit"),
        (r"auto|kfz|fahrzeug|reise|travel|rucksack|gepäck|koffer", "Auto & Reise"),
        (r"kopfhörer|headphone|earbud|übersetzer|elektronik|bluetooth|technik", "Elektronik & Technik"),
        (r"küche|küchen|kochen|backen|geschirr|haushalt", "Küche & Haushalt"),
        (r"garten|terrasse|pflanze|bewässer", "Garten"),
        (r"beauty|pflege|haare|haut|kosmetik", "Beauty & Pflege"),
        (r"baby|kind|spielzeug|spiel", "Baby & Spielzeug"),
        (r"wohn|möbel|deko|licht|lampe|aufbewahrung", "Wohnen & Einrichtung"),
    ]
    for pattern, category in categories:
        if re.search(pattern, text):
            return category
    return "Alltag & Haushalt"

def clean_handle(title, product_id, reserved):
    value = str(title or "").casefold().replace("ä","ae").replace("ö","oe").replace("ü","ue").replace("ß","ss").replace("™"," ")
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    base = re.sub(r"[^a-z0-9]+", "-", value).strip("-")[:90].strip("-") or "homestro-produkt"
    if base in reserved:
        suffix = re.sub(r"\D", "", str(product_id))[-7:] or "produkt"
        base = (base[:80].rstrip("-") + "-" + suffix).strip("-")
    return base

def plan_handle_updates(products):
    reserved = {str(p.get("handle") or "") for p in products}
    updates = {}
    for product in products:
        old = str(product.get("handle") or "")
        if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", old):
            continue
        reserved.discard(old)
        new = clean_handle(product.get("title"), product.get("id"), reserved)
        reserved.add(new)
        if new != old:
            updates[str(product.get("id") or "")] = new
    return updates

def risky_compare_anchor(price, anchor):
    try:
        price, anchor = float(price), float(anchor)
    except (TypeError, ValueError):
        return False
    if price <= 0:
        return False
    if anchor <= price:
        return True
    ratio = anchor / price
    tiny_discount = (anchor - price) / anchor < 0.05
    artificial_double = 1.98 <= ratio <= 2.02
    return tiny_discount or artificial_double

def fix_product(product, token, domain, new_handle=None):
    pid = product.get("id")
    variants = (product.get("variants") or {}).get("nodes", [])
    invalid = []
    for variant in variants:
        if risky_compare_anchor(variant.get("price"), variant.get("compareAtPrice")):
            invalid.append({"id":variant["id"], "compareAtPrice":None})
    errors = []
    fixed_count = 0
    if invalid:
        mutation = """mutation FixAnchors($productId:ID!,$variants:[ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId:$productId,variants:$variants) {
            productVariants { id price compareAtPrice } userErrors { field message }
          }
        }"""
        verify_query = """query VerifyProductAnchors($id:ID!) {
          product(id:$id) { variants(first:250) { nodes { id price compareAtPrice } } }
        }"""
        try:
            result = shopify_graphql(mutation, {"productId":pid,"variants":invalid}, token, domain)
            payload = result.get("productVariantsBulkUpdate") or {}
            if payload.get("userErrors"):
                errors.append("PRICE_FIX_REJECTED")
            verified = shopify_graphql(verify_query, {"id":pid}, token, domain)
            current = (((verified.get("product") or {}).get("variants") or {}).get("nodes") or [])
            current_by_id = {str(row.get("id")):row for row in current}
            requested = {str(row["id"]) for row in invalid}
            remaining = [row for row in invalid if
                str(row["id"]) not in current_by_id or risky_compare_anchor(
                    current_by_id[str(row["id"])].get("price"),
                    current_by_id[str(row["id"])].get("compareAtPrice"))]
            if remaining:
                retry = shopify_graphql(mutation, {"productId":pid,"variants":remaining}, token, domain)
                if (retry.get("productVariantsBulkUpdate") or {}).get("userErrors"):
                    errors.append("PRICE_FIX_RETRY_REJECTED")
                verified = shopify_graphql(verify_query, {"id":pid}, token, domain)
                current = (((verified.get("product") or {}).get("variants") or {}).get("nodes") or [])
                current_by_id = {str(row.get("id")):row for row in current}
            remaining_ids = {str(row["id"]) for row in invalid if
                str(row["id"]) not in current_by_id or risky_compare_anchor(
                    current_by_id[str(row["id"])].get("price"),
                    current_by_id[str(row["id"])].get("compareAtPrice"))}
            fixed_count = len(requested - remaining_ids)
            for variant in variants:
                live = current_by_id.get(str(variant.get("id")))
                if live:
                    variant["price"] = live.get("price")
                    variant["compareAtPrice"] = live.get("compareAtPrice")
            if remaining_ids:
                errors.append("PRICE_FIX_UNVERIFIED:" + str(len(remaining_ids)))
        except Exception as exc:
            errors.append(str(exc)[:100] or "PRICE_FIX_FAILED")

    tags = [str(t) for t in (product.get("tags") or [])]
    clean = [t for t in tags if t not in {"⚠️-chybi-foto","⚠️-nizka-cena"}]
    product_type = str(product.get("productType") or "").strip()
    new_type = infer_product_type(product) if not product_type else product_type
    metadata = {"id":pid}
    changed_type = not product_type
    if changed_type:
        metadata["productType"] = new_type
    changed_handle = bool(new_handle and new_handle != product.get("handle"))
    if changed_handle:
        metadata["handle"] = new_handle
        metadata["redirectNewHandle"] = True
    if clean != tags:
        metadata["tags"] = clean
    saved_metadata = False
    if len(metadata) > 1:
        mutation = """mutation StoreDoctorUpdate($product:ProductInput!) {
          productUpdate(input:$product) { product { id handle productType tags } userErrors { field message } }
        }"""
        try:
            result = shopify_graphql(mutation, {"product":metadata}, token, domain)
            errs = (result.get("productUpdate") or {}).get("userErrors") or []
            if errs:
                errors.append("PRODUCT_METADATA_FIX_REJECTED")
            else:
                saved_metadata = True
                if changed_handle:
                    product["handle"] = new_handle
                if changed_type:
                    product["productType"] = new_type
                product["tags"] = clean
        except Exception as exc:
            errors.append(str(exc)[:100] or "PRODUCT_METADATA_FIX_FAILED")

    return {"price_variants_fixed":fixed_count,
        "obsolete_tags_removed":int(saved_metadata and clean != tags),
        "product_type_filled":int(saved_metadata and changed_type),
        "handles_cleaned":int(saved_metadata and changed_handle),
        "product_cleaned":bool(fixed_count or (saved_metadata and (clean != tags or changed_type or changed_handle))),
        "fix_errors":errors}
def diagnostics(products):
    issues = []
    for product in products:
        if not str(product.get("productType") or "").strip():
            issues.append({"product_id":product.get("id"),"handle":product.get("handle"),"issue":"MISSING_PRODUCT_TYPE"})
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(product.get("handle") or "")):
            issues.append({"product_id":product.get("id"),"handle":product.get("handle"),"issue":"NON_SEO_HANDLE"})
        variants = product.get("variants") or []
        if isinstance(variants, dict):
            variants = variants.get("nodes") or []
        for variant in variants:
            anchor = variant.get("compareAtPrice", variant.get("compare_at_price"))
            if anchor is not None and risky_compare_anchor(variant.get("price"), anchor):
                try:
                    price, compare = float(variant.get("price") or 0), float(anchor)
                except (TypeError, ValueError):
                    continue
                kind = "ARTIFICIAL_2X_ANCHOR" if price > 0 and 1.98 <= compare / price <= 2.02 else "RISKY_COMPARE_AT_PRICE"
                issues.append({"product_id":product.get("id"),"handle":product.get("handle"),
                    "variant_id":variant.get("id"),"price":price,"compare_at_price":compare,"issue":kind})
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
    admin_status, admin_source = "unavailable", "none"
    fixed = cleaned = types_filled = handles_cleaned = products_cleaned = 0
    fix_errors = []
    products, source = [], "public_products_json"
    issues_before = []
    if domain:
        try:
            token, admin_source = admin_token(domain)
            if token:
                products = admin_catalog(token, domain)
                source, admin_status = "shopify_admin_active", "authenticated"
                issues_before = diagnostics(products)
                handle_updates = plan_handle_updates(products)
                for p in products:
                    counts = fix_product(p, token, domain, handle_updates.get(str(p.get("id") or "")))
                    fixed += counts["price_variants_fixed"]
                    cleaned += counts["obsolete_tags_removed"]
                    types_filled += counts["product_type_filled"]
                    handles_cleaned += counts["handles_cleaned"]
                    products_cleaned += int(counts["product_cleaned"])
                    fix_errors.extend({"product_id":p.get("id"),"reason":reason} for reason in counts["fix_errors"])
        except HTTPError as exc:
            admin_status = "authentication_required" if exc.code in (401,403) else f"http_{exc.code}"
        except Exception as exc:
            message = str(exc).casefold()
            admin_status = "authentication_required" if "authentication required" in message or "unauthorized" in message else "request_failed"
    if not products:
        products = public_catalog()
        source = "public_products_json_fallback"
        issues_before = diagnostics(products)
    feed = {"generated_at":now_iso(),"source":source,"products":products}
    atomic_json(DATA_DIR / "active-feed.json", feed)
    issues_after = diagnostics(products)
    atomic_json(DATA_DIR / "store-diagnostics.json", {
        "generated_at":now_iso(),"active_products":len(products),"issues_found":len(issues_before),
        "issues_remaining":len(issues_after),"issues_fixed_this_run":max(0,len(issues_before)-len(issues_after)),
        "products_cleaned_count":products_cleaned,"price_fixes":fixed,
        "obsolete_tags_removed":cleaned,"product_types_filled":types_filled,
        "handles_cleaned":handles_cleaned,"fix_errors":fix_errors,
        "admin_auth":admin_status,"admin_credential_source":admin_source,
        "issues":issues_after
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
            "last_prepared_at":event["at"],"rotation_history":rotation[-500:]})
    ms = update_ms_campaigns()
    prior.update({"status":"ACTIVE","last_run_at":now_iso(),"products_synced":len(products),
        "diagnostics_issues_found":len(issues_after),"price_fixes":fixed,"obsolete_tags_removed":cleaned,"products_cleaned_count":products_cleaned,"product_types_filled":types_filled,"handles_cleaned":handles_cleaned,
        "catalog_source":source,"admin_auth":admin_status,"ad_spend_eur":0.0,
        "ms_handwerk_ready":True,"last_post_ids":prior.get("last_post_ids",[])})
    atomic_json(state_path, prior)
    return {"status":"ACTIVE","products_synced":len(products),"diagnostics_issues_found":len(issues_after),
        "price_fixes":fixed,"obsolete_tags_removed":cleaned,"products_cleaned_count":products_cleaned,
        "product_types_filled":types_filled,"handles_cleaned":handles_cleaned,
        "issues_fixed_this_run":max(0,len(issues_before)-len(issues_after)),"admin_auth":admin_status,
        "catalog_source":source,"selected_product":candidate.get("title") if candidate else None,
        "selected_product_id":candidate.get("id") if candidate else None,
        "hook":hook,"caption":caption,"ms_handwerk_ready":bool(ms),"ad_spend_eur":0.0}

def main():
    command = sys.argv[1] if len(sys.argv)>1 else "run"
    if command == "status":
        state = read_json(DATA_DIR/"brain-state.json", {})
        print(json.dumps(state,ensure_ascii=False))
        return
    try:
        result = run()
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        frames = traceback.extract_tb(sys.exc_info()[2])
        origin = frames[-1] if frames else None
        detail = str(exc)[:140]
        if origin:
            detail += " at " + origin.name + ":" + str(origin.lineno)
        print(json.dumps({"status":"FAILED","reason":detail},ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
