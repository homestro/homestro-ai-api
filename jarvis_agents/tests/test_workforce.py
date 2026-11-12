from __future__ import annotations

import json

import pytest

from jarvis_agents.comms_agent import CommsAgent
from jarvis_agents.erazer_priority import HANDLE, is_erazer_xp6, rank_products, relevance_boost, shopify_video_url
from jarvis_agents.handwerk_agent import APPROVED_SERVICES, HandwerkAgent, validate_legal_copy
from jarvis_agents.homestro_agent import HomestroAgent
from jarvis_agents.orchestrator import JarvisOrchestrator, PILLAR_ORDER
from jarvis_agents.protocol import AgentMessage, MessageValidationError
from jarvis_agents.risk_guard_agent import RiskGuardAgent


VIDEO = "https://cdn.shopify.com/s/files/1/1/products/erazer-xp6.mp4"
FLAGSHIP = {
    "handle": HANDLE,
    "title": "Erazer XP6 Bluetooth Kopfhörer",
    "price": "47.99",
    "media": [{"mediaContentType": "VIDEO", "status": "READY", "sources": [
        {"url": VIDEO, "mimeType": "video/mp4"}
    ]}],
}


def test_canonical_flagship_is_recognized_and_ranked_first():
    assert is_erazer_xp6(FLAGSHIP)
    assert is_erazer_xp6({"title": "Erazer XP6 Kopfhörer"})
    products = rank_products([{"handle": "other", "score": 9999}, FLAGSHIP])
    assert products[0]["handle"] == HANDLE
    assert HomestroAgent().rank(products)[0]["handle"] == HANDLE


def test_shopify_video_is_reused_and_missing_video_blocks_ad_draft():
    assert shopify_video_url(FLAGSHIP) == VIDEO
    assert shopify_video_url({"video_url": "https://example.org/duplicate.mp4"}) is None
    agent = HomestroAgent()
    draft = agent.ad_draft(FLAGSHIP)
    assert draft["status"] == "draft_only"
    assert draft["featured_product"] is True
    assert draft["creative"] == {"source": "shopify", "video_url": VIDEO}
    assert draft["price_eur"] == 47.99
    assert draft["spend_eur"] == 0.0
    assert draft["execution_enabled"] is False
    assert agent.ad_draft({**FLAGSHIP, "media": []})["status"] == "blocked"


def test_trend_relevance_boost_covers_audio_translation_tech_and_gifts():
    product = FLAGSHIP
    terms = ["Bluetooth Kopfhörer", "Übersetzer Deutsch Englisch", "Technik Geschenkidee"]
    for term in terms:
        boost, groups = relevance_boost(product, term)
        assert boost > 0
        assert groups
    trends = [{"query": "Aktuelle Nachrichten", "score": 1000},
              {"query": "Bluetooth Kopfhörer Geschenk", "score": 10}]
    matched = HomestroAgent().match_trends(product, trends)
    assert matched[0]["query"] == "Bluetooth Kopfhörer Geschenk"


def test_handwerk_uses_approved_service_terms_and_blocks_forbidden_word():
    result = HandwerkAgent().draft()
    assert result["status"] == "draft_only"
    assert all(service in result["copy"] for service in APPROVED_SERVICES)
    assert result["published"] is False
    forbidden = "Ma" + "ler" + "arbeiten"
    assert validate_legal_copy(f"Wir bieten {forbidden} in Kempten.")[0] is False
    assert validate_legal_copy(result["copy"])[0] is True


def test_risk_guard_blocks_costly_writes_and_preserves_existing_campaigns():
    guard = RiskGuardAgent()
    assert guard.validate("campaign_write", {}, 0)["allowed"] is False
    assert guard.validate("rank_products", {}, 0.01)["reason"] == "UNAPPROVED_SPEND_BLOCKED"
    assert guard.validate("campaign_read", {"existing_campaign_mutation": True})["reason"] == "EXISTING_CAMPAIGNS_READ_ONLY"
    assert guard.validate("video_generate", {"product": FLAGSHIP})["reason"] == "FLAGSHIP_RUNWAY_GENERATION_FORBIDDEN"


def test_agent_message_json_protocol_round_trip_and_validation():
    message = AgentMessage(sender="orchestrator", recipient="homestro", task_type="rank_products",
                           payload={"products": []})
    assert json.loads(json.dumps(message.to_dict()))["budget_impact_eur"] == 0.0
    assert AgentMessage.from_dict(message.to_dict()) == message
    with pytest.raises(MessageValidationError):
        AgentMessage.from_dict({"sender": "x"})


def test_orchestrator_routes_read_only_work_and_blocks_external_writes():
    orchestrator = JarvisOrchestrator()
    result = orchestrator.dispatch(AgentMessage(
        sender="owner", recipient="homestro", task_type="rank_products",
        payload={"products": [{"handle": "other"}, FLAGSHIP]}))
    assert result["status"] == "completed"
    assert result["result"]["products"][0]["handle"] == HANDLE
    blocked = orchestrator.dispatch(AgentMessage(
        sender="owner", recipient="homestro", task_type="campaign_activate", payload={}))
    assert blocked["status"] == "blocked"
    assert len(orchestrator.handoffs) == 2


def test_workforce_pillar_order_and_status_reporter_are_explicit():
    assert PILLAR_ORDER == ("homestro", "ms_handwerk", "kids_youtube", "ai_influencers")
    orchestrator = JarvisOrchestrator()
    assert orchestrator.dispatch(AgentMessage(
        sender="owner", recipient="handwerk", task_type="draft_local_services",
        payload={"pillar": "ms_handwerk"})) ["reason"] == "PILLAR_ORDER_BLOCKED"
    report = CommsAgent().format_status(orchestrator.status())
    assert report["sent"] is False
    assert report["spend_eur"] == 0.0
