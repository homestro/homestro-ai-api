"""Dry-run fictional adult virtual persona and short-form hook writer."""
from __future__ import annotations

from typing import Any, Mapping


class AIInfluencerAgent:
    agent_id = "ai_influencers"
    pillar = "ai_influencers"
    mission = "Draft clearly fictional adult virtual personas and short-form hooks; never generate or publish."

    def draft_persona(self) -> dict[str, Any]:
        return {
            "status": "concept_draft",
            "persona": {
                "name": "Lena Morgen",
                "age": 28,
                "identity": "fictional virtual creator",
                "niche": "Alltag, Technik und kleine Allgäu-Auszeiten",
                "voice": "freundlich, direkt, neugierig",
                "disclosure": "KI-generierte virtuelle Persönlichkeit",
            },
            "short_video_hooks": [
                "Drei Dinge, die meinen Morgen einfacher machen",
                "Ein kleiner Allgäu-Moment in 15 Sekunden",
                "Was ich vor dem Kauf eines Technik-Gadgets prüfe",
            ],
            "dry_run": True, "cost_eur": 0.0, "image_or_video_api_called": False,
            "published": False,
        }

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if task_type != "draft_virtual_persona":
            raise ValueError("AI_INFLUENCER_TASK_NOT_SUPPORTED")
        return self.draft_persona()
