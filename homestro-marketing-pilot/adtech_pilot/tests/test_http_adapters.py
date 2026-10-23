import asyncio
import base64
import io
import unittest

import httpx
from adtech_pilot.creative_factory import CreativeBrief, OpenAIProvider
from adtech_pilot.media_buyer import MetaAdLibraryClient
from PIL import Image


class HttpAdapterTests(unittest.TestCase):
    def test_openai_structured_output_uses_schema_and_validates_response(self):
        def handler(request):
            self.assertEqual(request.url.path, "/v1/responses")
            self.assertEqual(request.headers["Authorization"], "Bearer test-key")
            payload = __import__("json").loads(request.content)
            self.assertEqual(payload["text"]["format"]["type"], "json_schema")
            data = {
                "product_id": "sku1",
                "platform": "meta",
                "hook": "Praktisch im Alltag",
                "problem": "Kleine Alltagsaufgaben kosten Zeit.",
                "solution": "Dieses Produkt hilft dabei.",
                "headline": "Gutes Produkt",
                "primary_text": "Entdecke hilfreiche Produkte für den Alltag.",
                "description": "Jetzt ansehen",
                "call_to_action": "Shop Now",
                "visual_prompt": "A warm lifestyle product scene with soft colors.",
                "factual_claims": ["Hilfreich"],
            }
            return httpx.Response(
                200,
                json={
                    "output": [
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": __import__("json").dumps(data),
                                }
                            ]
                        }
                    ]
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAIProvider("test-key", client=client)
        result = asyncio.run(provider.complete(schema=CreativeBrief, prompt="test"))
        self.assertEqual(result.product_id, "sku1")
        asyncio.run(client.aclose())

    def test_openai_image_edit_returns_decoded_image_bytes(self):
        image = Image.new("RGB", (20, 20), "green")
        out = io.BytesIO()
        image.save(out, format="PNG")
        expected = out.getvalue()

        def handler(request):
            self.assertEqual(request.url.path, "/v1/images/edits")
            self.assertEqual(request.headers["Authorization"], "Bearer test-key")
            return httpx.Response(
                200, json={"data": [{"b64_json": base64.b64encode(expected).decode()}]}
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenAIProvider("test-key", client=client)
        actual = asyncio.run(provider.edit(source_image=b"png", prompt="edit"))
        self.assertEqual(actual, expected)
        asyncio.run(client.aclose())

    def test_meta_library_token_is_header_only_and_no_success_metrics_are_claimed(self):
        def handler(request):
            self.assertEqual(request.url.path, "/v26.0/ads_archive")
            self.assertEqual(request.headers["Authorization"], "Bearer secret-token")
            self.assertNotIn("access_token", request.url.query.decode())
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "123",
                            "page_name": "Example",
                            "ad_creative_bodies": ["Try this idea"],
                            "publisher_platforms": ["facebook"],
                        }
                    ]
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        ads = asyncio.run(
            MetaAdLibraryClient("secret-token", client=client).search(
                ["dog feeder"], country="DE"
            )
        )
        self.assertEqual(ads[0].ad_copy, ["Try this idea"])
        self.assertEqual(
            ads[0].intel_kind, "public_ad_structure_only_no_performance_data"
        )
        asyncio.run(client.aclose())


if __name__ == "__main__":
    unittest.main()
