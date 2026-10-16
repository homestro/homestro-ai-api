"""Read-only Merchant API diagnostics with short-lived service-account tokens."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
from collections import Counter
from collections.abc import Callable
from typing import Any

import httpx
from google.auth.transport.requests import Request
from google.oauth2 import service_account


class MerchantDiagnosticsClient:
    """Fetch account and processed-product issues; intentionally exposes no writes."""

    SCOPE = "https://www.googleapis.com/auth/content"

    def __init__(
        self,
        merchant_id: str,
        *,
        credentials_json: str | None = None,
        access_token_provider: Callable[[], Any] | None = None,
        client: httpx.AsyncClient | None = None,
    ):
        if not merchant_id.isdigit():
            raise ValueError("GMC_MERCHANT_ID must be a numeric Merchant Center ID")
        self.merchant_id = merchant_id
        raw_credentials = credentials_json or os.getenv("GMC_SERVICE_ACCOUNT_JSON", "")
        self._credentials = None
        if access_token_provider is not None:
            self._token_provider = access_token_provider
        elif raw_credentials:
            info = json.loads(raw_credentials)
            self._credentials = service_account.Credentials.from_service_account_info(
                info, scopes=[self.SCOPE]
            )
            self._token_provider = self._refresh_token
        else:
            raise ValueError("GMC service account credentials are not configured")
        self._client = client

    async def _refresh_token(self) -> str:
        assert self._credentials is not None
        await asyncio.to_thread(self._credentials.refresh, Request())
        if not self._credentials.token:
            raise RuntimeError("Google OAuth refresh returned no access token")
        return self._credentials.token

    async def diagnose(self) -> dict[str, Any]:
        token_result = self._token_provider()
        token = await token_result if inspect.isawaitable(token_result) else token_result
        own_client = self._client is None
        client = self._client or httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        )
        headers = {"Authorization": f"Bearer {token}"}
        account_issues: list[dict[str, Any]] = []
        products: list[dict[str, Any]] = []
        try:
            account_issues = await self._paginate(
                client,
                f"https://merchantapi.googleapis.com/accounts/v1/accounts/{self.merchant_id}/issues",
                "accountIssues",
                headers,
                page_size=100,
                max_pages=10,
            )
            products = await self._paginate(
                client,
                f"https://merchantapi.googleapis.com/products/v1/accounts/{self.merchant_id}/products",
                "products",
                headers,
                page_size=1000,
                max_pages=20,
            )
        finally:
            if own_client:
                await client.aclose()

        disapproved = 0
        item_issue_codes: Counter[str] = Counter()
        account_issue_summary = []
        for issue in account_issues:
            account_issue_summary.append(
                {
                    "title": str(issue.get("title", ""))[:200],
                    "severity": str(issue.get("severity", "UNKNOWN")),
                    "detail": str(issue.get("detail", ""))[:500],
                    "documentation_uri": str(issue.get("documentationUri", ""))[:500],
                }
            )
        for product in products:
            status = product.get("productStatus") or {}
            destinations = status.get("destinationStatuses") or []
            if any(
                str(d.get("status", "")).lower() in {"disapproved", "not eligible"}
                for d in destinations
            ):
                disapproved += 1
            for issue in status.get("itemLevelIssues") or []:
                code = str(issue.get("code") or "UNKNOWN")[:160]
                item_issue_codes[code] += 1
        return {
            "status": "diagnosed",
            "source": "google_merchant_api_v1_read_only",
            "merchant_id": self.merchant_id,
            "products_checked": len(products),
            "disapproved_products": disapproved,
            "account_issues": account_issue_summary,
            "item_issue_counts_by_code": dict(item_issue_codes.most_common(100)),
            "truncated": len(products) >= 20_000 or len(account_issues) >= 1_000,
            "mutations_performed": False,
            "repair_policy": "No text is invented and no feed/product/account data is written.",
        }

    @staticmethod
    async def _paginate(
        client: httpx.AsyncClient,
        url: str,
        field: str,
        headers: dict[str, str],
        *,
        page_size: int,
        max_pages: int,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        params: dict[str, Any] = {"pageSize": page_size}
        for _ in range(max_pages):
            response = await client.get(url, headers=headers, params=params)
            response.raise_for_status()
            body = response.json()
            result.extend(x for x in body.get(field, []) if isinstance(x, dict))
            page_token = body.get("nextPageToken")
            if not page_token:
                break
            params["pageToken"] = page_token
        return result
