"""Dry-run concept and script writer for the kids animation pillar."""
from __future__ import annotations

from typing import Any, Mapping


class KidsYouTubeAgent:
    agent_id = "kids_youtube"
    pillar = "kids_youtube"
    mission = "Plan original animated shorts toward a 1,000-video library; never render or publish."

    def draft_short(self, episode: int = 1) -> dict[str, Any]:
        episode = max(1, int(episode))
        return {
            "status": "concept_draft",
            "series": "Milo und der kleine Stern",
            "episode": episode,
            "library_target": 1000,
            "title": "Milo teilt das Mondlicht",
            "age_range": "4-8",
            "duration_seconds": 35,
            "scenes": [
                {"seconds": 8, "visual": "Milo entdeckt einen kleinen Stern hinter einer Wolke.",
                 "narration": "Milo sieht ein Licht, das sich ganz allein fühlt."},
                {"seconds": 12, "visual": "Milo lädt seine Freunde ein, den Stern gemeinsam zu betrachten.",
                 "narration": "Zusammen finden sie heraus: Teilen macht Freude heller."},
                {"seconds": 15, "visual": "Die Freunde verabschieden sich unter einem funkelnden Himmel.",
                 "narration": "Und jeder nimmt ein bisschen Mut mit nach Hause."},
            ],
            "description": "Eine kurze, sanfte Geschichte über Freundschaft und Teilen.",
            "metadata": {"language": "de", "format": "animated_short", "tags": ["Freundschaft", "Teilen", "Gute Nacht"]},
            "dry_run": True, "cost_eur": 0.0, "video_api_called": False, "published": False,
        }

    def handle(self, task_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if task_type != "draft_kids_short":
            raise ValueError("KIDS_YOUTUBE_TASK_NOT_SUPPORTED")
        return self.draft_short(payload.get("episode", 1))
