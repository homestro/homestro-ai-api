#!/usr/bin/env python3
"""Zero-spend local content and vertical video builder for MS Handwerk & Service."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo

BRAND = "MS Handwerk & Service"
AREAS = "Kempten (Allgäu), 87435–87439, Oberallgäu und Ostallgäu"
CTA = "Jetzt unverbindlich anfragen — schnell, sauber & zuverlässig in Kempten & Umgebung"
SERVICES = "Innenausbau, Renovierungsarbeiten, Trockenbau, Bodenverlegung, Möbelmontage, Reparatur- & Hausmeisterservice in Kempten & Allgäu"
BLOCKED = re.compile(r"maler|malerbetrieb|malermeister", re.I)


def safe_copy(value: str) -> str:
    if BLOCKED.search(value):
        raise ValueError("COPY_COMPLIANCE_FAILED")
    return value


def daily_copy(day: dt.date) -> dict:
    themes = [
        ("Innenausbau und Trockenbau in Kempten", "Sie möchten Räume neu aufteilen oder Flächen im Innenbereich erneuern? MS Handwerk & Service unterstützt bei Innenausbau, Trockenbau und Renovierungsarbeiten im Raum Kempten."),
        ("Bodenverlegung im Allgäu", "Ein neuer Boden verändert den Raum. MS Handwerk & Service übernimmt Bodenverlegung und passende Renovierungsarbeiten in Kempten sowie im Ober- und Ostallgäu."),
        ("Möbelmontage und Reparaturservice in Kempten", "Wenn Möbel aufgebaut oder kleinere Reparaturen erledigt werden sollen, hilft MS Handwerk & Service in Kempten und Umgebung."),
        ("Renovierungsarbeiten in Kempten und Umgebung", "Für anstehende Arbeiten im Innenbereich bietet MS Handwerk & Service Unterstützung bei Renovierung, Trockenbau und Bodenverlegung im Allgäu."),
        ("Hausmeisterservice im Ober- und Ostallgäu", "Für laufende Reparaturen und praktische Arbeiten rund ums Objekt ist MS Handwerk & Service in Kempten und im Allgäu erreichbar."),
    ]
    title, intro = themes[day.toordinal() % len(themes)]
    seo_title = f"{title} | {BRAND}"
    description = f"{SERVICES}. Einsatzgebiet: {AREAS}. {CTA}."
    caption = safe_copy(f"{intro}\n\n{SERVICES}.\n\n{CTA}.")
    ad_title = title if "Kempten" in title else f"{title} in Kempten & Allgäu"
    return {
        "business": BRAND,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "date": day.isoformat(),
        "location": AREAS,
        "services": SERVICES,
        "seo": {"title": safe_copy(seo_title), "metaDescription": safe_copy(description[:160]), "keywords": ["Innenausbau Kempten", "Trockenbau Kempten", "Bodenverlegung Allgäu", "Renovierungsarbeiten Kempten", "Hausmeisterservice Allgäu"]},
        "geo": {"primaryCity": "Kempten (Allgäu)", "postalCodes": ["87435", "87436", "87437", "87438", "87439"], "regions": ["Oberallgäu", "Ostallgäu"], "answerSummary": safe_copy(f"{BRAND} bietet {SERVICES} im Einsatzgebiet {AREAS} an.")},
        "video": {"format": "9:16", "hook": safe_copy(f"Arbeiten im Innenbereich in Kempten geplant? {CTA}."), "caption": caption, "callToAction": CTA, "scenes": [
            {"seconds": 4, "text": "Innenausbau in Kempten"},
            {"seconds": 4, "text": "Trockenbau & Renovierungsarbeiten"},
            {"seconds": 4, "text": "Bodenverlegung & Möbelmontage"},
            {"seconds": 4, "text": "Reparatur- & Hausmeisterservice"},
            {"seconds": 4, "text": CTA},
        ]},
        "kleinanzeigen": {"title": safe_copy(ad_title), "description": caption},
        "googleBusinessProfile": {"title": safe_copy(title), "text": caption},
        "publishing": {"paidAdsEnabled": False, "adSpendEUR": 0, "published": False, "reason": "DRAFT_GENERATED; dedicated MS channel accounts required for social publishing"},
    }


def render_video(bundle: dict, out: Path, assets_dir: Path) -> tuple[str, list[str]]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFMPEG_NOT_INSTALLED")
    out.parent.mkdir(parents=True, exist_ok=True)
    images = sorted(p for p in assets_dir.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}) if assets_dir.exists() else []
    sources = images[:5]
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    filters = []
    for index, scene in enumerate(bundle["video"]["scenes"]):
        if index < len(sources):
            args += ["-loop", "1", "-t", str(scene["seconds"]), "-i", str(sources[index])]
            src = f"[{index}:v]"
            filters.append(f"{src}scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='min(zoom+0.0012,1.08)':d=100:s=720x1280:fps=25,trim=duration={scene['seconds']},setpts=PTS-STARTPTS[v{index}]")
        else:
            label = scene["text"].replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace(",", "\\,")
            color = ["0x173B2E", "0x214C3A", "0x2B5C46", "0x18382D", "0x214C3A"][index]
            args += ["-f", "lavfi", "-t", str(scene["seconds"]), "-i", f"color=c={color}:s=720x1280:r=25"]
            filters.append(f"[{index}:v]drawbox=x=50:y=220:w=620:h=840:color=0xF2EFE7@0.12:t=fill,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='{label}':fontcolor=white:fontsize=38:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=14,zoompan=z='min(zoom+0.001,1.05)':d=100:s=720x1280:fps=25,trim=duration={scene['seconds']},setpts=PTS-STARTPTS[v{index}]")
    filters.append("".join(f"[v{i}]" for i in range(len(bundle["video"]["scenes"]))) + f"concat=n={len(bundle['video']['scenes'])}:v=1:a=0,format=yuv420p[out]")
    args += ["-filter_complex", ";".join(filters), "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-movflags", "+faststart", str(out)]
    subprocess.run(args, check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return str(out), [str(p) for p in sources]


def run(output_dir: Path, assets_dir: Path, day: dt.date | None = None, render: bool = True) -> dict:
    day = day or dt.datetime.now(ZoneInfo("Europe/Berlin")).date()
    bundle = daily_copy(day)
    digest = hashlib.sha256(json.dumps(bundle, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
    output_dir.mkdir(parents=True, exist_ok=True)
    video_path = output_dir / f"ms-handwerk-{day.isoformat()}-{digest}.mp4"
    used_images: list[str] = []
    if render:
        rendered, used_images = render_video(bundle, video_path, assets_dir)
        bundle["video"]["file"] = rendered
    else:
        bundle["video"]["file"] = None
    bundle["video"]["sourceImages"] = used_images
    bundle["video"]["fallbackGraphicsUsed"] = not bool(used_images)
    bundle["video"]["rendered"] = bool(render)
    json_path = output_dir / f"ms-handwerk-{day.isoformat()}.json"
    json_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "mode": "LOCAL_ZERO_SPEND", "bundle": bundle, "bundleFile": str(json_path), "videoFile": str(video_path) if render else None, "paidApiCalls": 0, "adSpendEUR": 0, "published": False}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=os.getenv("MS_HANDWERK_DATA_DIR", "/data/ms_handwerk"))
    parser.add_argument("--assets-dir", default="assets/ms_handwerk")
    parser.add_argument("--no-render", action="store_true")
    args = parser.parse_args()
    result = run(Path(args.output_dir), Path(args.assets_dir), render=not args.no_render)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
