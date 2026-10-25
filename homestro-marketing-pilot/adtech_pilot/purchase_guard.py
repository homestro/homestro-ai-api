"""Fresh paid-order evidence and an independent, fail-closed campaign watchdog.

Never logs customer/order data. Shopify is the authority for actual payments;
pixel access and an environment boolean are not purchase evidence.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping

import httpx

from .micro_budget import configured_daily_budget_limit_eur, live_ads_dry_run

logger = logging.getLogger("uvicorn.error")
ORDER_QUERY = """query PilotPurchaseEvidence($query: String!, $after: String) {
  orders(first: 25, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes { id test cancelledAt displayFinancialStatus
      shippingAddress { countryCodeV2 }
      transactions(first: 10) { kind status test processedAt amountSet { shopMoney { amount currencyCode } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}"""


def timestamp(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed.astimezone(UTC)


def paid_in_window(order: dict[str, Any], now: datetime) -> bool:
    if (order.get("test") is not False or order.get("cancelledAt") is not None
            or order.get("displayFinancialStatus") != "PAID"
            or (order.get("shippingAddress") or {}).get("countryCodeV2") not in {"DE", "AT"}):
        return False
    for transaction in order.get("transactions") or []:
        if (transaction.get("status") != "SUCCESS" or transaction.get("test") is not False
                or transaction.get("kind") not in {"SALE", "CAPTURE"}):
            continue
        try:
            money = transaction["amountSet"]["shopMoney"]
            amount = Decimal(money["amount"])
            paid_at = timestamp(transaction["processedAt"])
            if (money["currencyCode"] == "EUR" and amount.is_finite() and amount > 0
                    and now - timedelta(minutes=15) <= paid_at <= now):
                return True
        except (KeyError, TypeError, ValueError, InvalidOperation):
            continue
    return False


class PurchaseEvidence:
    def __init__(self, *, env: Mapping[str, str] | None = None, client=None):
        self.env = os.environ if env is None else env
        self.client = client
        self._token = ""
        self._expires = datetime.min.replace(tzinfo=UTC)
        self._prefer_client_token = False
        self._client_refresh_attempted = False

    async def check(self, *, now: datetime | None = None) -> dict[str, Any]:
        if self.env.get("PILOT_PURCHASE_SOURCE", "shopify_api") == "shopify_webhook":
            from .payment_webhooks import PaymentWebhookStore, payment_database

            if not self.env.get("SHOPIFY_WEBHOOK_SECRET"):
                return {"verified": False, "source": "shopify_signed_payment_webhook",
                        "reason": "SHOPIFY_ADMIN_WEBHOOK_SIGNING_SECRET_REQUIRED", "qualifying_orders": 0}
            try:
                return await asyncio.to_thread(lambda: PaymentWebhookStore(payment_database(self.env)).evidence(now=now))
            except Exception as exc:
                return {"verified": False, "reason": "PAYMENT_STORE_UNAVAILABLE", "error_type": type(exc).__name__}
        try:
            async with asyncio.timeout(25):
                return await self._check(now=now)
        except TimeoutError:
            return {"verified": False, "reason": "SHOPIFY_ORDER_EVIDENCE_TIMEOUT",
                    "qualifying_orders": 0, "attribution_verified": False}

    async def _check(self, *, now: datetime | None = None) -> dict[str, Any]:
        fixed_now = now
        now = now or datetime.now(UTC)
        result = {"verified": False, "window_minutes": 15, "checked_at": now.isoformat(),
                  "source": "shopify_successful_payment", "qualifying_orders": 0,
                  "attribution_verified": False}
        domain = self.env.get("SHOPIFY_STORE_DOMAIN", "").strip().removeprefix("https://").rstrip("/")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com", domain):
            return {**result, "reason": "SHOPIFY_STORE_DOMAIN_REQUIRED"}
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
        try:
            token = self.env.get("SHOPIFY_ACCESS_TOKEN", "").strip()
            if self._prefer_client_token:
                token = self._token if now < self._expires else ""
            if not token:
                if now >= self._expires:
                    app_id, secret = self.env.get("SHOPIFY_CLIENT_ID"), self.env.get("SHOPIFY_CLIENT_SECRET")
                    if not app_id or not secret:
                        return {**result, "reason": "SHOPIFY_EXISTING_CREDENTIALS_NOT_REFERENCED"}
                    response = await client.post(f"https://{domain}/admin/oauth/access_token", data={
                        "grant_type": "client_credentials", "client_id": app_id, "client_secret": secret})
                    response.raise_for_status()
                    body = response.json()
                    self._token = body["access_token"]
                    self._expires = now + timedelta(seconds=max(0, int(body.get("expires_in", 0)) - 60))
                token = self._token
            version = self.env.get("SHOPIFY_API_VERSION", "2026-07")
            if not re.fullmatch(r"20\d{2}-(01|04|07|10)", version):
                return {**result, "reason": "SHOPIFY_API_VERSION_INVALID"}
            cursor = None
            seen: dict[str, dict[str, Any]] = {}
            for _ in range(20):
                response = await client.post(f"https://{domain}/admin/api/{version}/graphql.json",
                    headers={"X-Shopify-Access-Token": token}, json={"query": ORDER_QUERY, "variables": {
                        "query": "updated_at:>=" + (now - timedelta(minutes=15)).isoformat(), "after": cursor}})
                response.raise_for_status()
                body = response.json()
                if (any((error.get("extensions") or {}).get("code") == "ACCESS_DENIED"
                        for error in body.get("errors", []) if isinstance(error, dict))
                        and not self._client_refresh_attempted
                        and self.env.get("SHOPIFY_CLIENT_ID") and self.env.get("SHOPIFY_CLIENT_SECRET")):
                    # The same installed app can have a stale direct token after
                    # a scope update. Obtain one current client-credentials token;
                    # never reinstall the app or overwrite the existing secret.
                    self._client_refresh_attempted = True
                    refreshed = await client.post(f"https://{domain}/admin/oauth/access_token", data={
                        "grant_type": "client_credentials", "client_id": self.env["SHOPIFY_CLIENT_ID"],
                        "client_secret": self.env["SHOPIFY_CLIENT_SECRET"]})
                    if refreshed.is_success:
                        credentials = refreshed.json()
                        candidate = credentials.get("access_token")
                        if candidate:
                            self._token = token = candidate
                            self._expires = now + timedelta(seconds=max(0, int(credentials.get("expires_in", 0)) - 60))
                            self._prefer_client_token = True
                            response = await client.post(f"https://{domain}/admin/api/{version}/graphql.json",
                                headers={"X-Shopify-Access-Token": token}, json={"query": ORDER_QUERY,
                                "variables": {"query": "updated_at:>=" + (now - timedelta(minutes=15)).isoformat(), "after": cursor}})
                            response.raise_for_status()
                            body = response.json()
                if body.get("errors"):
                    errors = body["errors"]
                    # Schema/permission diagnostics only, never provider messages,
                    # query variables, order data or credential-bearing bodies.
                    diagnostics = [{
                        "code": str((error.get("extensions") or {}).get("code", ""))[:80],
                        "field": str((error.get("extensions") or {}).get("fieldName", ""))[:80],
                        "type": str((error.get("extensions") or {}).get("typeName", ""))[:80],
                        "path": [str(part)[:80] for part in (error.get("path") or [])[:5]],
                    } for error in errors[:5] if isinstance(error, dict)]
                    scope_response = await client.post(f"https://{domain}/admin/api/{version}/graphql.json",
                        headers={"X-Shopify-Access-Token": token}, json={"query":
                        "query PilotOrderAccess { currentAppInstallation { accessScopes { handle } } }"})
                    scope_response.raise_for_status()
                    scope_body = scope_response.json()
                    installation = (scope_body.get("data") or {}).get("currentAppInstallation") or {}
                    handles = [scope.get("handle") for scope in installation.get("accessScopes", [])]
                    return {**result, "reason": "SHOPIFY_ORDER_QUERY_REJECTED", "diagnostics": diagnostics,
                            "read_orders_granted_to_runtime_app": "read_orders" in handles}
                orders = body["data"]["orders"]
                for order in orders["nodes"]:
                    order_id = order.get("id")
                    if order_id:
                        seen[order_id] = order
                page = orders["pageInfo"]
                if not page["hasNextPage"]:
                    checked_at = fixed_now or datetime.now(UTC)
                    count = sum(paid_in_window(order, checked_at) for order in seen.values())
                    return {**result, "verified": count > 0, "qualifying_orders": count,
                            "checked_at": checked_at.isoformat(),
                            "reason": "FRESH_PAID_DE_AT_ORDER" if count else "NO_FRESH_PAID_DE_AT_ORDER"}
                next_cursor = page.get("endCursor")
                if not next_cursor or next_cursor == cursor:
                    break
                cursor = next_cursor
            return {**result, "reason": "SHOPIFY_ORDER_PAGINATION_INCOMPLETE"}
        except Exception as exc:
            return {**result, "reason": "SHOPIFY_ORDER_EVIDENCE_UNAVAILABLE", "error_type": type(exc).__name__}
        finally:
            if self.client is None:
                await client.aclose()


class PurchaseWatchdog:
    """Only controls the exact campaign owned by the durable Pilot claim.

    Dry-run disables activation, never emergency pausing. No campaign creation,
    budget increase, consent bypass, or edits to other account campaigns.
    """
    def __init__(self, audit, *, evidence=None, env=None, client=None):
        self.audit = audit
        self.env = os.environ if env is None else env
        self.evidence = evidence or PurchaseEvidence(env=self.env)
        self.client = client
        self.lock = asyncio.Lock()
        self.last_result: dict[str, Any] = {"status": "not_checked"}

    async def cycle(self) -> dict[str, Any]:
        async with self.lock:
            evidence = await self.evidence.check()
            claim = await self.audit.get_meta_micro_campaign_claim()
            result: dict[str, Any] = {"purchase": evidence, "status": "no_managed_campaign"}
            if claim and claim.get("campaign_id"):
                result = {**result, **await self._control(str(claim["campaign_id"]), evidence)}
            self.last_result = result
            await self.audit.record("purchase_watchdog", result)
            logger.info("purchase_watchdog %s", json.dumps(result, separators=(",", ":")))
            return result

    async def _control(self, campaign: str, evidence: dict[str, Any]) -> dict[str, Any]:
        account = self.env.get("META_AD_ACCOUNT_ID", "")
        version = self.env.get("META_API_VERSION", "v26.0")
        token = self.env.get("META_ACCESS_TOKEN", "")
        if (not re.fullmatch(r"\d{4,30}", campaign) or not re.fullmatch(r"act_\d{4,30}", account)
                or not re.fullmatch(r"v\d+\.\d+", version) or not token):
            return {"status": "blocked", "reason": "MANAGED_CAMPAIGN_CONFIGURATION_INVALID"}
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False)
        url = f"https://graph.facebook.com/{version}/{campaign}"
        headers = {"Authorization": f"Bearer {token}"}
        async def pause():
            response = await client.post(url, headers=headers, data={"status": "PAUSED"})
            response.raise_for_status()
            if response.json().get("success") is not True:
                raise ValueError("pause not acknowledged")
            response = await client.get(url, headers=headers, params={"fields": "id,status"})
            response.raise_for_status()
            if response.json().get("status") != "PAUSED":
                raise ValueError("pause not confirmed")
            return {"status": "paused_confirmed", "campaign_id": campaign}

        try:
            # A failed purchase read must still pause the known campaign.
            if not evidence.get("verified") or live_ads_dry_run(self.env) or self.env.get("ALLOW_MICRO_BUDGET") != "true":
                return await pause()
            from .media_buyer import MetaPublisher

            publisher = MetaPublisher(self.audit, env=self.env, client=client)
            configuration = publisher._configuration()
            if isinstance(configuration, dict):
                return {**await pause(), "reason": configuration.get("reason")}
            response = await client.get(url, headers=headers,
                params={"fields": "id,account_id,name,status,objective"})
            response.raise_for_status()
            remote = response.json()
            if (str(remote.get("account_id")) != account.removeprefix("act_")
                    or remote.get("name") != publisher._campaign_name()
                    or remote.get("objective") != "OUTCOME_SALES"):
                return {"status": "blocked", "reason": "CAMPAIGN_OWNERSHIP_MISMATCH"}
            if remote.get("status") not in {"ACTIVE", "PAUSED"}:
                return {"status": "blocked", "reason": "CAMPAIGN_NOT_RESUMABLE"}
            response = await client.get(url + "/adsets", headers=headers, params={
                "fields": "id,daily_budget,lifetime_budget,start_time,end_time,targeting,status", "limit": "100"})
            response.raise_for_status()
            body = response.json()
            rows = body.get("data", [])
            if len(rows) != 1 or (body.get("paging") or {}).get("next"):
                return {**await pause(), "reason": "ADSET_SCOPE_AMBIGUOUS"}
            row = rows[0]
            now = datetime.now(UTC)
            if (str(row.get("daily_budget")) != "500" or row.get("lifetime_budget") not in (None, "0", 0)
                    or row.get("status") != "ACTIVE"
                    or set(row.get("targeting", {}).get("geo_locations", {}).get("countries", [])) != {"DE", "AT"}
                    or not timestamp(row["start_time"]) <= now < timestamp(row["end_time"])
                    or timestamp(row["end_time"]) - timestamp(row["start_time"]) > timedelta(days=7)):
                return {**await pause(), "reason": "EXISTING_SCHEDULE_OR_BUDGET_NOT_SAFE"}
            readiness = await publisher.check_readiness()
            account_ready = readiness.get("account", {})
            if (readiness.get("status") != "checked" or not account_ready.get("pixel_access_verified")
                    or not account_ready.get("billing_ready") or account_ready.get("account_status") != "active"
                    or account_ready.get("currency") != "EUR"):
                return {**await pause(), "reason": "META_PREFLIGHT_NOT_READY"}
            if remote.get("status") == "ACTIVE":
                return {"status": "active_with_fresh_purchase", "campaign_id": campaign}
            # Check again immediately before spending; never reuse a stale heartbeat.
            fresh = await self.evidence.check()
            if not fresh.get("verified"):
                return {**await pause(), "reason": "FRESH_PURCHASE_EXPIRED"}
            response = await client.post(url, headers=headers, data={"status": "ACTIVE"})
            response.raise_for_status()
            if response.json().get("success") is not True:
                raise ValueError("activation not acknowledged")
            response = await client.get(url, headers=headers, params={"fields": "id,status"})
            response.raise_for_status()
            if response.json().get("status") != "ACTIVE":
                raise ValueError("activation not confirmed")
            return {"status": "active_confirmed", "campaign_id": campaign,
                    "daily_cap_eur": configured_daily_budget_limit_eur(self.env)}
        except asyncio.CancelledError:
            await asyncio.shield(pause())
            raise
        except Exception as exc:
            # An ambiguous ACTIVE response is never blindly retried.
            try:
                return {**await pause(), "reason": "CONTROL_FAILED_COMPENSATED", "error_type": type(exc).__name__}
            except Exception:
                pass
            return {"status": "pause_or_control_unconfirmed", "campaign_id": campaign,
                    "error_type": type(exc).__name__}
        finally:
            if self.client is None:
                await client.aclose()

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await self.cycle()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("purchase_watchdog_cycle_failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=60)
            except TimeoutError:
                pass
