from agents.copy_compliance import normalize_hashtags, sanitize_text, supports_135_languages
from jarvis_agents import ai_video_generator


def test_pet_mite_and_medical_claims_are_replaced_with_safe_outer_ear_care():
    product = {"title": "Kopfband für Hunde", "descriptionHtml": "Für empfindliche Ohren"}
    result = sanitize_text(
        "Das Produkt hilft gegen Ohrmilben und behandelt Entzündungen. Für den Alltag geeignet.",
        product=product,
    )
    assert "Milben" not in result and "behandelt" not in result
    assert "sanfte äußere Ohrpflege" in result
    assert "Für den Alltag geeignet." in result


def test_135_language_angle_requires_explicit_product_specification():
    unsupported = {"title": "Erazer XP6 Kopfhörer", "specifications": ["Bluetooth 5.4"]}
    supported = {"title": "Erazer XP6", "specifications": ["KI-Übersetzung für bis zu 135 Sprachen"]}
    assert not supports_135_languages(unsupported)
    assert supports_135_languages(supported)
    assert "135 Sprachen" not in sanitize_text("135 Sprachen für unterwegs.", product=unsupported)
    assert "135 Sprachen" in sanitize_text("135 Sprachen für unterwegs.", product=supported)


def test_accent_variants_of_hashtags_deduplicate_to_canonical_ascii():
    assert normalize_hashtags(["#zuhausegefühl", "#zuhausegefuehl", "#Reise", "#reise"]) == [
        "#zuhausegefuehl", "#Reise"
    ]
    copy = sanitize_text("Ein Stück #zuhausegefühl. #zuhausegefuehl #zuhausegefühl")
    assert copy.count("#zuhausegefuehl") == 1


def test_ai_video_generation_is_disabled_and_existing_shopify_video_is_preserved(monkeypatch, tmp_path):
    called = []
    monkeypatch.setattr(ai_video_generator.higgsfield_video_agent, "generate_video", lambda **kwargs: called.append(kwargs))
    disabled = ai_video_generator.generate_video(
        {"image_urls": ["https://cdn.shopify.com/image.jpg"]}, "Hook", tmp_path / "out.mp4",
        env={"AI_VIDEO_GENERATION_ENABLED": "false", "HIGGSFIELD_ENABLED": "true", "HIGGSFIELD_API_KEY": "configured"},
    )
    existing = ai_video_generator.generate_video(
        {"video_urls": ["https://cdn.shopify.com/video.mp4"]}, "Hook", tmp_path / "out.mp4",
        env={"AI_VIDEO_GENERATION_ENABLED": "true", "HIGGSFIELD_ENABLED": "true", "HIGGSFIELD_API_KEY": "configured"},
    )
    flagship = ai_video_generator.generate_video(
        {"handle": ai_video_generator.ERAZER_XP6_HANDLE}, "Hook", tmp_path / "flagship.mp4",
        env={"AI_VIDEO_GENERATION_ENABLED": "true", "HIGGSFIELD_ENABLED": "true", "HIGGSFIELD_API_KEY": "configured"},
    )
    assert disabled["reason"] == "AI_VIDEO_GENERATION_DISABLED"
    assert existing["reason"] == "SHOPIFY_VIDEO_ALREADY_AVAILABLE"
    assert flagship["reason"] == "ERAZER_XP6_SHOPIFY_VIDEO_REUSE_ONLY"
    assert called == []


def test_ai_video_daily_limit_is_persisted_and_blocks_second_generation(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(
        ai_video_generator.higgsfield_video_agent, "generate_video",
        lambda **kwargs: calls.append(kwargs) or {"status": "completed", "path": str(kwargs["output_path"])},
    )
    env = {
        "AI_VIDEO_GENERATION_ENABLED": "true", "HIGGSFIELD_ENABLED": "true",
        "HIGGSFIELD_API_KEY": "configured", "MAX_DAILY_AI_VIDEOS": "1",
        "AI_VIDEO_GENERATION_LEDGER_PATH": str(tmp_path / "daily.json"),
    }
    product = {"image_urls": ["https://cdn.shopify.com/image.jpg"]}
    first = ai_video_generator.generate_video(product, "Hook", tmp_path / "one.mp4", env=env)
    second = ai_video_generator.generate_video(product, "Hook", tmp_path / "two.mp4", env=env)
    assert first["status"] == "completed"
    assert second["reason"] == "MAX_DAILY_AI_VIDEOS_REACHED"
    assert len(calls) == 1
