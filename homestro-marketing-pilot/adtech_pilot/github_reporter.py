"""One rolling GitHub PR status comment; never includes credentials or customer data."""

from __future__ import annotations

import json
from typing import Any

import httpx

COMMENT_MARKER = "<!-- homestro-adtech-pilot-live-status -->"


class GitHubPRReporter:
    def __init__(
        self,
        token: str,
        repository: str = "homestro/homestro-ai-api",
        pull_request: int = 104,
        *,
        client: httpx.AsyncClient | None = None,
    ):
        if "/" not in repository or pull_request < 1:
            raise ValueError("A repository and valid pull request number are required")
        self.token = token
        self.repository = repository
        self.pull_request = pull_request
        self.client = client

    async def publish(self, report: dict[str, Any]) -> str:
        if not self.token:
            return "REPORTING_DISABLED"
        own_client = self.client is None
        client = self.client or httpx.AsyncClient(timeout=httpx.Timeout(12, connect=5))
        url = f"https://api.github.com/repos/{self.repository}/issues/{self.pull_request}/comments"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        try:
            comments_response = await client.get(
                url, headers=headers, params={"per_page": 100, "page": 1}
            )
            comments_response.raise_for_status()
            comments = comments_response.json()
            existing = next(
                (
                    row
                    for row in comments
                    if isinstance(row, dict)
                    and COMMENT_MARKER in str(row.get("body", ""))
                ),
                None,
            )
            body = self._render(report)
            if existing:
                response = await client.patch(
                    f"https://api.github.com/repos/{self.repository}/issues/comments/{existing['id']}",
                    headers=headers,
                    json={"body": body},
                )
                response.raise_for_status()
                return "COMMENT_UPDATED"
            response = await client.post(url, headers=headers, json={"body": body})
            response.raise_for_status()
            return "COMMENT_CREATED"
        finally:
            if own_client:
                await client.aclose()

    @staticmethod
    def _render(report: dict[str, Any]) -> str:
        rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
        if len(rendered) > 12_000:
            rendered = rendered[:11_800] + "\n… report truncated …"
        return (
            f"{COMMENT_MARKER}\n"
            "## Homestro AdTech Pilot — automatischer Status\n\n"
            "Režim: **DRY RUN**, limit **0,00 €**. Jde o provozní report, nikoli důkaz "
            "zobrazení reklamy, objednávky nebo prodeje.\n\n"
            "```json\n"
            f"{rendered}\n"
            "```"
        )
