import asyncio
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from adtech_pilot.creative_factory import (
    BrandKit,
    CreativeBrief,
    CreativeFactory,
    CreativeScore,
    HistoricalWin,
)


def png(color):
    image = Image.new("RGB", (256, 256), color)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class FakeLLM:
    async def complete(self, *, schema, prompt, image_bytes=None):
        if schema is CreativeBrief:
            return CreativeBrief(
                product_id="sku1",
                platform="meta",
                hook="Mehr Freude im Alltag",
                problem="Die tägliche Fütterung ist oft hastig.",
                solution="Der Napf macht die Routine spielerischer.",
                headline="Mehr Freude zuhause",
                primary_text="Praktische Hilfe für den Alltag mit deinem Haustier.",
                description="Jetzt entdecken",
                call_to_action="Shop Now",
                visual_prompt="Bright warm home scene with a dog near the product.",
                factual_claims=["Praktisch"],
            )
        return CreativeScore(
            quality_score=92,
            product_faithful=True,
            logo_visible=True,
            lifestyle_background=True,
            factual_claims_supported=True,
            rationale=["clear layout"],
        )


class FakeImageEditor:
    async def edit(self, *, source_image, prompt, size="1024x1024"):
        return png("#cbd9c3")


class CreativeFactoryTests(unittest.TestCase):
    def test_factory_requires_logo_and_verified_facts(self):
        factory = CreativeFactory(
            llm=FakeLLM(),
            image_editor=FakeImageEditor(),
            brand=BrandKit(),
            output_dir=Path(tempfile.mkdtemp()),
        )
        with self.assertRaises(ValueError):
            asyncio.run(
                factory.create(
                    product={"id": "sku1", "title": "Produkt", "facts": ["Material"]},
                    platform="meta",
                    product_image=png("red"),
                    logo_image=b"",
                )
            )
        with self.assertRaises(ValueError):
            asyncio.run(
                factory.create(
                    product={"id": "sku1", "title": "Produkt", "facts": []},
                    platform="meta",
                    product_image=png("red"),
                    logo_image=png("green"),
                )
            )

    def test_factory_composites_logo_and_marks_passing_quality_candidate(self):
        factory = CreativeFactory(
            llm=FakeLLM(),
            image_editor=FakeImageEditor(),
            brand=BrandKit(),
            output_dir=Path(tempfile.mkdtemp()),
        )
        result = asyncio.run(
            factory.create(
                product={
                    "id": "gid://shopify/Product/1",
                    "title": "Napf",
                    "description": "Hundnapf",
                    "facts": ["Edelstahl"],
                    "price": "19.90",
                },
                platform="meta",
                product_image=png("white"),
                logo_image=png("green"),
                historical_winners=[
                    HistoricalWin(
                        platform="meta",
                        format="image",
                        hook="Alltag",
                        ctr=0.03,
                        roas=3.2,
                        conversions=10,
                    )
                ],
            )
        )
        self.assertTrue(result.publishable_candidate)
        self.assertTrue(result.asset_path.endswith(".png"))
        self.assertEqual(
            result.score_kind, "creative_quality_review_not_sales_prediction"
        )


if __name__ == "__main__":
    unittest.main()
