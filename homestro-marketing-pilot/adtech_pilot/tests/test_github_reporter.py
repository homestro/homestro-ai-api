import asyncio
import json
import unittest

import httpx

from adtech_pilot.github_reporter import COMMENT_MARKER, GitHubPRReporter


class GitHubReporterTests(unittest.TestCase):
    def test_reporter_creates_once_then_updates_single_rolling_comment(self):
        state = {"comments": []}
        calls = []

        def handler(request):
            calls.append((request.method, request.url.path))
            if request.method == "GET":
                return httpx.Response(200, json=state["comments"])
            payload = json.loads(request.content)
            self.assertIn(COMMENT_MARKER, payload["body"])
            if request.method == "POST":
                state["comments"] = [{"id": 77, "body": payload["body"]}]
            else:
                state["comments"][0]["body"] = payload["body"]
            return httpx.Response(200, json={"id": 77})

        async def run():
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            reporter = GitHubPRReporter("token", client=client)
            first = await reporter.publish({"dry_run": True, "budget_limit_eur": 0})
            second = await reporter.publish({"dry_run": True, "budget_limit_eur": 0})
            await client.aclose()
            return first, second

        self.assertEqual(asyncio.run(run()), ("COMMENT_CREATED", "COMMENT_UPDATED"))
        self.assertEqual(sum(method == "POST" for method, _ in calls), 1)
        self.assertEqual(sum(method == "PATCH" for method, _ in calls), 1)

    def test_no_token_disables_reporting(self):
        reporter = GitHubPRReporter("")
        self.assertEqual(
            asyncio.run(reporter.publish({"dry_run": True})), "REPORTING_DISABLED"
        )
