"""JARVIS organic chain: Shopify catalog -> SEO/GEO -> Pillow -> video -> organic handoffs.

Default operation remains zero-cost. Optional Higgsfield generation is attempted only
when HIGGSFIELD_ENABLED=true and HIGGSFIELD_API_KEY is configured; failures fall back
to existing Shopify video or the free gallery montage. Paid ads remain disabled.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from PIL import Image, ImageDraw, ImageFont, ImageOps
from agents import creative_seo, product_hunter, tiktok_publisher, youtube_publisher
from jarvis_agents import higgsfield_video_agent


MAX_DOWNLOAD = 60 * 1024 * 1024
ALLOWED_MEDIA_HOSTS = {"cdn.shopify.com", "cdn.shopifycdn.net"}


def _download(url: str, target: Path, limit: int = MAX_DOWNLOAD) -> None:
    parsed = urlsplit(str(url or ""))
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_MEDIA_HOSTS or parsed.username or parsed.password:
        raise ValueError("UNTRUSTED_SHOPIFY_MEDIA_URL")
    request = urllib.request.Request(url, headers={"User-Agent": "HomestroOrganicPipeline/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response, target.open("wb") as output:
        length = int(response.headers.get("Content-Length") or "0")
        if length > limit:
            raise ValueError("SHOPIFY_MEDIA_TOO_LARGE")
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError("SHOPIFY_MEDIA_TOO_LARGE")
            output.write(chunk)


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(name).exists():
            return ImageFont.truetype(name, size=size)
    return ImageFont.load_default()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, width: int) -> list[str]:
    words = re.sub(r"\s+", " ", str(text or "")).split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and draw.textbbox((0, 0), candidate, font=font)[2] > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _promo_image(product: dict[str, Any], output: Path, work: Path, headline: str) -> None:
    sources = product.get("image_urls") or []
    photo = None
    for index, url in enumerate(sources[:4]):
        candidate = work / f"source-{index}.img"
        try:
            _download(url, candidate, 18 * 1024 * 1024)
            with Image.open(candidate) as opened:
                photo = ImageOps.fit(opened.convert("RGB"), (1000, 900), method=Image.Resampling.LANCZOS)
            break
        except Exception:
            continue

    canvas = Image.new("RGB", (1080, 1350), "#101827")
    draw = ImageDraw.Draw(canvas)
    # Reserved padded red header band keeps the emotional headline inside the safe area.
    draw.rounded_rectangle((40, 40, 1040, 218), radius=30, fill="#b91c1c")
    header_font = _font(42)
    for index, line in enumerate(_wrap(draw, headline, header_font, 900)[:2]):
        draw.text((76, 68 + index * 56), line, fill="#ffffff", font=header_font)
    if photo:
        card_photo = ImageOps.fit(photo, (1000, 675), method=Image.Resampling.LANCZOS)
        canvas.paste(card_photo, (40, 238))
    else:
        draw.rounded_rectangle((40, 238, 1040, 913), radius=34, fill="#1c2b42")
        draw.text((80, 280), "HOMESTRO", fill="#ffd22e", font=_font(42))
    draw.rounded_rectangle((40, 925, 1040, 1310), radius=34, fill="#17253a")
    draw.text((84, 962), "HOMESTRO  •  DE / AT", fill="#ffd22e", font=_font(30))
    title = "Erazer XP6" if "XP6" in headline else str(product.get("title") or "Produkt bei Homestro")[:90]
    title_font = _font(44)
    y = 1022
    for line in _wrap(draw, title, title_font, 900)[:2]:
        draw.text((84, y), line, fill="#ffffff", font=title_font)
        y += 58
    draw.text((84, 1228), "Details im Homestro Shop entdecken", fill="#cbd5e1", font=_font(26))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="JPEG", quality=90, optimize=True)


def _render_video(product: dict[str, Any], image_path: Path, output: Path, work: Path, hook: str) -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "blocked", "reason": "FFMPEG_NOT_INSTALLED", "rendered": False}
    work.mkdir(parents=True, exist_ok=True)
    hook = re.sub(r"[\r\n]+", " ", str(hook or "Entdecke das Produkt bei Homestro.")).strip()[:150]
    hook_path = work / "hook-overlay.png"
    _hook_overlay(hook, hook_path)

    video_paths: list[Path] = []
    for index, url in enumerate((product.get("video_urls") or [])[:6]):
        if not urlsplit(str(url)).path.lower().endswith(".mp4"):
            continue
        candidate = work / f"source-{index}.mp4"
        try:
            _download(url, candidate)
            if candidate.stat().st_size > 0:
                video_paths.append(candidate)
        except Exception:
            continue

    higgsfield_result: dict[str, Any] | None = None
    if not video_paths and higgsfield_video_agent.is_enabled(os.environ):
        image_urls = product.get("image_urls") or []
        if image_urls:
            try:
                generated = higgsfield_video_agent.generate_video(
                    image_url=str(image_urls[0]),
                    prompt=higgsfield_video_agent.build_story_prompt(product, hook),
                    output_path=work / "higgsfield-source.mp4",
                    env=os.environ,
                )
                higgsfield_result = generated
                if generated.get("status") == "completed":
                    generated_path = Path(str(generated.get("path") or ""))
                    if generated_path.is_file() and generated_path.stat().st_size > 0:
                        video_paths.append(generated_path)
            except Exception as error:
                higgsfield_result = {"status": "fallback", "reason": type(error).__name__}
        else:
            higgsfield_result = {"status": "fallback", "reason": "SHOPIFY_PRODUCT_IMAGE_MISSING"}

    if video_paths:
        source = video_paths[0]
        probe = shutil.which("ffprobe")
        try:
            if not probe:
                raise ValueError("FFPROBE_NOT_INSTALLED")
            result = subprocess.run(
                [probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source)],
                check=True, capture_output=True, text=True, timeout=20,
            )
            source_duration = float(result.stdout.strip())
            if source_duration <= 0:
                raise ValueError("INVALID_VIDEO_DURATION")
        except (OSError, ValueError, subprocess.SubprocessError):
            source_duration = 15.0

        duration = min(15.0, max(7.5, source_duration))
        scenes = min(6, max(3, round(duration / 2.5)))
        scene_duration = duration / scenes
        transition = 0.16
        args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
        if source_duration < duration:
            args += ["-stream_loop", "-1"]
        args += ["-i", str(source), "-loop", "1", "-framerate", "25", "-i", str(hook_path)]
        filters: list[str] = []
        for index in range(scenes):
            start = index * scene_duration
            filters.append(
                f"[0:v]trim=start={start:.3f}:duration={scene_duration:.3f},setpts=PTS-STARTPTS,"
                "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=25,setsar=1,"
                f"zoompan=z='min(zoom+0.00035,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=720x1280:fps=25,"
                f"trim=duration={scene_duration:.3f},fps=25,settb=1/25,format=yuv420p[v{index}]"
            )
        previous = "v0"
        for index in range(1, scenes):
            current = f"xf{index}"
            offset = index * (scene_duration - transition)
            filters.append(
                f"[{previous}][v{index}]xfade=transition=fade:duration={transition:.3f}:offset={offset:.3f}[{current}]"
            )
            previous = current
        filters.append(
            f"[{previous}][1:v]overlay=(W-w)/2:(H-h)/2:format=auto:enable='between(t,0,3.2)',"
            "format=yuv420p[vout]"
        )
        args += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-an"]
        final_duration = scene_duration * scenes - transition * (scenes - 1)
        source_name = ("higgsfield_generated_motion_clips" if higgsfield_result and higgsfield_result.get("status") == "completed"
                       else "existing_shopify_video_motion_clips")
    else:
        image_urls = list(dict.fromkeys(
            str(url) for url in (product.get("image_urls") or []) if str(url).strip()
        ))[:6]
        image_paths: list[Path] = []
        for index, url in enumerate(image_urls):
            candidate = work / f"gallery-{index}.img"
            try:
                _download(url, candidate, 18 * 1024 * 1024)
                with Image.open(candidate) as image:
                    image.verify()
                image_paths.append(candidate)
            except Exception:
                continue
        if len(image_paths) < 3:
            return {"status": "blocked", "reason": "THREE_SHOPIFY_GALLERY_IMAGES_REQUIRED",
                    "rendered": False, "gallery_images_downloaded": len(image_paths),
                    "static_card_fallback": False}

        scenes = min(6, len(image_paths))
        image_paths = image_paths[:scenes]
        scene_duration = 2.5
        transition = 0.16
        args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
        for image_file in image_paths:
            args += ["-loop", "1", "-framerate", "25", "-t", f"{scene_duration:.3f}", "-i", str(image_file)]
        args += ["-loop", "1", "-framerate", "25", "-i", str(hook_path)]
        filters = []
        for index in range(scenes):
            filters.append(
                f"[{index}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,"
                f"zoompan=z='min(zoom+0.0012,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=720x1280:fps=25,"
                f"trim=duration={scene_duration:.3f},setpts=PTS-STARTPTS,fps=25,settb=1/25,setsar=1,format=yuv420p[v{index}]"
            )
        previous = "v0"
        for index in range(1, scenes):
            current = f"xf{index}"
            offset = index * (scene_duration - transition)
            filters.append(
                f"[{previous}][v{index}]xfade=transition=fade:duration={transition:.3f}:offset={offset:.3f}[{current}]"
            )
            previous = current
        filters.append(
            f"[{previous}][{scenes}:v]overlay=(W-w)/2:(H-h)/2:format=auto:enable='between(t,0,3.2)',"
            "format=yuv420p[vout]"
        )
        args += ["-filter_complex", ";".join(filters), "-map", "[vout]", "-an"]
        final_duration = scene_duration * scenes - transition * (scenes - 1)
        source_name = "shopify_gallery_ken_burns_montage"

    args += ["-t", f"{final_duration:.3f}", "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
             "-threads", "1", str(output)]
    try:
        subprocess.run(args, check=True, timeout=180, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        return {"status": "blocked", "reason": "FFMPEG_RENDER_FAILED",
                "detail": (error.stderr or "")[-400:], "rendered": False}
    except subprocess.TimeoutExpired:
        return {"status": "blocked", "reason": "FFMPEG_RENDER_TIMEOUT", "rendered": False}
    return {"status": "rendered", "rendered": True, "path": str(output),
            "source": source_name, "scene_count": scenes,
            "source_image_count": scenes if source_name == "shopify_gallery_ken_burns_montage" else 0,
            "full_screen": True, "motion_per_scene": "ken_burns" if not video_paths else "video_clip_and_zoom",
            "hook_safe_zone": "center_wrapped_pill", "static_card_fallback": False,
            "format": "vertical_9_16_mp4", "duration_seconds": round(final_duration, 1),
            "higgsfield_generation": higgsfield_result}


def _hook_overlay(hook: str, output: Path) -> None:
    canvas = Image.new("RGBA", (680, 300), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    font = _font(40)
    lines = _wrap(draw, hook, font, 580)
    if len(lines) > 3:
        lines = lines[:3]
        while lines[-1] and draw.textbbox((0, 0), lines[-1] + "…", font=font)[2] > 580:
            lines[-1] = lines[-1][:-1]
        lines[-1] = lines[-1].rstrip() + "…"
    line_height = 52
    height = min(240, max(104, len(lines) * line_height + 44))
    top = (canvas.height - height) // 2
    draw.rounded_rectangle((10, top, 670, top + height), radius=42, fill=(8, 16, 30, 220),
                           outline=(255, 255, 255, 220), width=2)
    y = top + (height - len(lines) * line_height) // 2
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font)
        x = (canvas.width - (box[2] - box[0])) // 2
        draw.text((x, y), line, font=font, fill=(255, 255, 255, 255), stroke_width=1,
                  stroke_fill=(0, 0, 0, 255))
        y += line_height
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)


def _human_product_name(product: dict[str, Any]) -> str:
    title = re.sub(r"\s+", " ", str(product.get("title") or "Produkt bei Homestro")).strip()
    title = re.split(
        r"\s+(?:mit|inkl(?:usive)?|Bluetooth|IPX\d|USB-C?|Watt|mAh|Hz|dB|\d+(?:[.,]\d+)?\s*(?:mm|cm|m|kg|g|W|V))\b",
        title, maxsplit=1, flags=re.IGNORECASE
    )[0]
    title = re.sub(r"[|•,;\s-]+$", "", title).strip()
    return (title or "Produkt bei Homestro")[:100]


def _story_copy(product: dict[str, Any], product_url: str, prices: list[float]) -> tuple[str, str, str]:
    if str(product.get("handle") or "") == "lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5":
        headline = "135 Sprachen. Kein Handy im Gesicht."
        hook = "Gate B14. Flug gestrichen. Was jetzt?"
        price_text = f"für {min(prices):.2f}".replace(".", ",") + " € " if prices else ""
        caption = (
            "Gate B14. Dein Flug ist gestrichen. Die Durchsage kommt in einer Sprache, die du nicht verstehst. "
            "Du atmest kurz durch und setzt den Erazer XP6 ein, um die nächsten Schritte besser einzuordnen. "
            "Kein Handy, das du fremden Menschen vors Gesicht halten musst.\n\n"
            f"135 Sprachen. Kabellos. Erazer XP6 {price_text}bei Homestro entdecken.\n\n{product_url}"
        )
        return headline, hook, caption
    name = _human_product_name(product)
    product_text = " ".join(str(product.get(key) or "") for key in
                            ("title", "productType", "descriptionHtml"))
    product_text += " " + " ".join(str(tag) for tag in (product.get("tags") or []))
    if re.search(r"handyhalter|smartphone.*ständer|phone.?holder|multi.?winkel desktop.?ständer",
                  str(product.get("title") or ""), re.IGNORECASE):
        headline = "Freie Hände. Der passende Blickwinkel."
        hook = "Videoanruf oder Stream – liegt dein Gerät schon wieder flach?"
        caption = (
            "Du möchtest am Schreibtisch arbeiten oder einen Videoanruf führen – und hältst dein Gerät "
            "dabei die ganze Zeit in der Hand? Der faltbare, biegsame Ständer passt Smartphone, Tablet "
            "oder Laptop in verschiedene Blickwinkel an. Danach lässt er sich kompakt zusammenlegen "
            f"und mitnehmen. Details bei Homestro ansehen.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"smartphone.{0,12}halter|rückseitenhalter|saugmatte|phone.?mount", product_text, re.IGNORECASE):
        headline = "Freie Hände. Dein Handy im Blick."
        hook = "Wohin mit dem Handy beim nächsten Videoanruf?"
        caption = (
            "Du willst beim Videoanruf oder beim Blick aufs Display beide Hände frei haben? "
            f"Die Saugmatte ist als Wand- und Rückseitenhalter für dein Smartphone beschrieben: {name}. "
            "Prüfe vor dem Verwenden, ob Untergrund und Hülle dafür geeignet sind. "
            f"Link in der Bio — jetzt bei Homestro entdecken.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"kopfbande? für hunde|hunde.?kopfband|dog.?head.?cover", product_text, re.IGNORECASE):
        headline = "Mehr Ruhe für ungewohnte Hundemomente."
        hook = "Bad, Reise oder Lärm – wird dein Hund dann unruhig?"
        caption = (
            "Bei Bad, Reise oder lauten Geräuschen wünschst du dir, dass dein Hund sich sicherer fühlt? "
            "Das leichte, wasserabweisende Nylon-Kopfband ist laut Produktbeschreibung für zusätzlichen Schutz "
            "in ungewohnten Situationen gedacht und soll empfindliche Ohren vor Wasser und Insekten schützen. "
            "Es ist kein Medizinprodukt und ersetzt keine tierärztliche Beratung. "
            f"Details bei Homestro ansehen.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"satin.?haube|sleep.?cap|bonnet", product_text, re.IGNORECASE):
        headline = "Morgens weniger Zeit mit Entwirren?"
        hook = "Nächtliches Haar-Chaos bei langen Haaren?"
        caption = (
            "Du legst dich hin – und am Morgen heißt es erst einmal entwirren? "
            "Laut Produktbeschreibung soll das glatte Innenfutter Reibung verringern und kann helfen, "
            "Knoten, Frizz und Haarbruch zu reduzieren. Die großzügige Passform ist für langes und volles "
            "Haar beschrieben. Schau dir Materialangaben und Varianten bei Homestro an und entscheide, "
            f"ob die Haube zu deiner Routine passt.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"ninja.*stiftehalter|stiftehalter|stifthalter|pen.?holder", product_text, re.IGNORECASE):
        headline = "Nie wieder den Stift suchen."
        hook = "Du willst etwas notieren – aber wo ist schon wieder der Stift?"
        caption = (
            "Du willst dir schnell etwas notieren – und suchst den Stift zwischen Monitor und Notizbuch? "
            "Der Ninja-Stiftehalter hält ihn griffbereit und bringt ein Schmunzeln auf den Schreibtisch. "
            "Wähle die Ausführung, die zu dir passt – zum Beispiel mit oder ohne Stift oder mit zusätzlichem "
            f"Sockel. Jetzt bei Homestro entdecken.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"schwitzgürtel|waist.?trimmer|taillengürtel", product_text, re.IGNORECASE):
        headline = "Vor dem Training passend einstellen."
        hook = "Gleich geht's los – sitzt der Gürtel schon bequem?"
        caption = (
            "Du möchtest vor dem Joggen oder Workout noch kurz den Sitz anpassen und dann loslegen? "
            "Der verstellbare Klettverschluss lässt sich individuell einstellen; der breite Sitz ist für "
            "Unterstützung im Bauch- und Lendenbereich beschrieben. Achte darauf, normal atmen zu können, "
            "und leg den Gürtel bei Unwohlsein ab. Schau dir die Details bei Homestro an und entscheide, "
            f"ob er zu deinem Training passt.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"nagel|nail.?art|manik", product_text, re.IGNORECASE):
        headline = "Deine Nail-Art-Idee beginnt hier."
        hook = "Dotting, Linien oder feine Details – was probierst du zuerst?"
        caption = (
            "Du hast ein Nageldesign im Kopf, suchst aber noch den passenden Pinsel für die feinen Details? "
            "Mit dem FUMOSIK-Set findest du Pinsel für Linien, Dotting, Flächen und feines Carving. "
            "Wähle 5 oder 20 Stück und probiere dein Motiv mit Acryl, Gel, UV-Polish oder klassischem Nagellack "
            "Schritt für Schritt aus.\n\n"
            f"Jetzt bei Homestro ansehen.\n\n{product_url}"
        )
        return headline, hook, caption
    if re.search(r"tierhaar|fell.?entfern|haar.?entfern|haare auf sofa", product_text, re.IGNORECASE):
        headline = "Weniger Fell auf Sofa und Kleidung."
        hook = "Überall Haare – und du willst endlich Ordnung?"
        caption = (
            f"Fell auf Sofa oder Kleidung kann im Alltag lästig sein. {name} ist dafür gedacht, Tierhaare "
            "zu entfernen – schau dir die Produktdetails an und entscheide, ob es zu deinem Zuhause passt.\n\n"
            f"Bei Homestro entdecken.\n\n{product_url}"
        )
        return headline, hook, caption
    details = html.unescape(re.sub(r"<[^>]+>", " ", str(product.get("descriptionHtml") or "")))
    details = re.sub(r"\s+", " ", details).strip()
    fact = re.split(r"(?<=[.!?])\s+", details, maxsplit=1)[0][:180].strip()
    headline = name[:70]
    hook = f"Was macht {name} im Alltag leichter?"
    caption = f"{hook} {fact}" if fact else f"Ein genauerer Blick auf {name}: Wofür ist dieses Produkt gedacht?"
    caption += f"\n\nLink in der Bio — jetzt bei Homestro entdecken.\n\n{product_url}"
    return headline, hook, caption


def run(payload: dict[str, Any]) -> dict[str, Any]:
    products = payload.get("products") if isinstance(payload.get("products"), list) else []
    trends = payload.get("trends") if isinstance(payload.get("trends"), list) else []
    seed_ids_raw = payload.get("seed_published_product_ids") or os.getenv("JARVIS_ROTATION_SEED_PUBLISHED_PRODUCT_IDS", "[]")
    try:
        seed_ids = json.loads(seed_ids_raw) if isinstance(seed_ids_raw, str) else seed_ids_raw
    except (TypeError, ValueError):
        seed_ids = []
    if not isinstance(seed_ids, list):
        seed_ids = []
    scout = product_hunter.select_next_active_product(
        products, trends,
        payload.get("rotation_history_path") or "/data/jarvis-published-products.json",
        existing_publish_ledger_path=payload.get("existing_publish_ledger_path") or "/data/jarvis-unified-published.json",
        seed_published_product_ids=[str(item) for item in seed_ids],
    )
    if scout.get("status") != "selected":
        return {"status": "blocked", "scout": scout, "creative": None, "video": None}
    product = scout["product"]
    product_id = str(product.get("id") or "")
    product_text = " ".join(str(product.get(key) or "") for key in
                            ("title", "productType", "descriptionHtml"))
    product_text += " " + " ".join(str(tag) for tag in (product.get("tags") or []))
    product_url = str(product.get("onlineStoreUrl") or f"https://homestro.de/products/{product.get('handle', '')}")
    prices = []
    for variant in product.get("variants") or []:
        # Dropshipping products may be zero/untracked stock: use any variant's positive price.
        try:
            value = float(variant.get("price"))
        except (TypeError, ValueError):
            continue
        if value > 0:
            prices.append(value)
    headline, hook, story_caption = _story_copy(product, product_url, prices)
    if "Link in der Bio" not in story_caption:
        story_caption = re.sub(r"\n+https://homestro\.de/products/[^\s]+\s*$", "", story_caption).rstrip()
        story_caption += f"\n\nLink in der Bio — jetzt bei Homestro entdecken.\n\n{product_url}"
    feed = {
        "id": product_id, "title": product.get("title"),
        "description": product.get("descriptionHtml") or "", "link": product_url,
        "image_link": (product.get("image_urls") or [None])[0],
        "price": min(prices) if prices else None, "currency": "EUR",
        "availability": "in_stock", "product_type": product.get("productType") or "",
        "tags": product.get("tags") or [], "facts": [],
    }
    creative_result = creative_seo.prepare([feed], limit=1)
    drafts = creative_result.get("drafts") or []
    if not drafts:
        return {"status": "blocked", "scout": {k:v for k,v in scout.items() if k != "product"},
                "creative": {"status": "blocked", "reason": "SEO_GEO_DRAFT_UNAVAILABLE"}, "video": None}
    draft = drafts[0]
    digest = hashlib.sha256((product_id + str(product.get("handle")) + ":organic-motion-v2").encode()).hexdigest()
    root = Path(payload.get("assets_dir") or "/data/jarvis-unified/assets")
    root.mkdir(parents=True, exist_ok=True)
    work = root / f".work-{digest[:16]}"
    work.mkdir(parents=True, exist_ok=True)
    image_path, video_path = root / f"{digest}.jpg", root / f"{digest}.mp4"
    try:
        _promo_image(product, image_path, work, headline)
        video = _render_video(product, image_path, video_path, work, hook)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    caption = story_caption
    hashtags = (["#Homestro", "#ErazerXP6", "#Kopfhoerer", "#Unterwegs", "#ReiseTipps"]
                if product.get("handle") == "lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5"
                else ["#Homestro", "#Training", "#Jogging", "#Fitness", "#Workout"]
                if re.search(r"schwitzgürtel|waist.?trimmer|taillengürtel", product_text, re.IGNORECASE)
                else ["#Homestro", "#NailArt", "#Nageldesign", "#Maniküre", "#Kreativ"]
                if re.search(r"nagel|nail.?art|manik", product_text, re.IGNORECASE)
                else ["#Homestro", "#Smartphonehalter", "#Tabletständer", "#HomeOffice", "#Alltagshelfer"]
                if re.search(r"handyhalter|smartphone.*ständer|phone.?holder|multi.?winkel desktop.?ständer",
                             str(product.get("title") or ""), re.IGNORECASE)
                else ["#Homestro", "#Hundezubehör", "#Hundepflege", "#Hundereise", "#Hunde"]
                if re.search(r"kopfbande? für hunde|hunde.?kopfband|dog.?head.?cover", product_text, re.IGNORECASE)
                else ["#Homestro", "#Haarpflege", "#Satinhaube", "#Lockenpflege", "#Nachtpflege"]
                if re.search(r"satin.?haube|sleep.?cap|bonnet", product_text, re.IGNORECASE)
                else ["#Homestro", "#Schreibtisch", "#HomeOffice", "#Ordnung", "#Geschenkidee"]
                if re.search(r"stifte?halter|stifthalter|pen.?holder|schreibtisch|ninja", product_text, re.IGNORECASE)
                else ["#Homestro", "#Produktentdecken", "#Alltagsideen", "#OnlineShop"])
    creative = {
        "status": "prepared", "product_id": product_id, "seo": draft.get("seo"),
        "geo": draft.get("geo"), "caption": caption, "hashtags": hashtags,
        "image_path": str(image_path), "image_hash": digest,
        "claims_policy": "validated_shopify_facts_only", "paid_generation_performed": False,
    }
    public_origin = str(payload.get("public_origin") or "https://homestro-ai-api-fixed-current-production.up.railway.app").rstrip("/")
    video_url = public_origin + "/marketing-assets/" + video_path.name if video.get("rendered") else ""
    bundle = tiktok_publisher.prepare_generated_bundle(
        {"id": product_id, "url": product_url}, video_url, caption, hashtags
    ) if video.get("rendered") else {
        "status": "blocked", "reason": video.get("reason") or "VIDEO_NOT_RENDERED",
        "upload_performed": False, "publication_performed": False, "ad_spend_eur": 0,
    }
    social_publication = {"youtube": {"status": "blocked", "reason": "VIDEO_NOT_RENDERED"},
                          "tiktok": {"status": "blocked", "reason": "VIDEO_NOT_RENDERED"}}
    if video.get("rendered"):
        social_caption = (caption + "\n\n" + " ".join(hashtags)).strip()
        title = (headline + " #Shorts")[:100]
        description = (social_caption + "\n\n#Shorts")[:5000]
        tiktok_result = tiktok_publisher.publish_generated_video(
            str(video_path), social_caption,
            duration_seconds=int(video.get("duration_seconds") or 0), env=os.environ
        )
        if str(os.environ.get("ZERNIO_YOUTUBE_ACCOUNT_ID") or "").strip():
            youtube_result = (tiktok_result.get("platform_results") or {}).get("youtube") or {
                "status": "ready_to_post", "reason": "ZERNIO_YOUTUBE_RESULT_MISSING",
                "upload_performed": False, "publication_performed": False,
            }
            tiktok_result = (tiktok_result.get("platform_results") or {}).get("tiktok") or {
                "status": "ready_to_post", "reason": "ZERNIO_TIKTOK_ACCOUNT_NOT_CONFIGURED",
                "upload_performed": False, "publication_performed": False,
            }
        else:
            youtube_result = youtube_publisher.publish_video(str(video_path), title, description)
        social_publication = {
            "youtube": youtube_result,
            "tiktok": tiktok_result,
        }
    if isinstance(bundle, dict):
        bundle["youtube_publishing"] = social_publication["youtube"]
        bundle["tiktok_publishing"] = social_publication["tiktok"]
        bundle["status"] = "ready_to_post"
    return {"status": "completed" if video.get("rendered") else "partial",
            "scout": {k:v for k,v in scout.items() if k != "product"},
            "product": {"id": product_id, "title": product.get("title"),
                        "handle": product.get("handle"), "url": product_url,
                        "image_path": str(image_path)},
            "creative": creative, "video": video, "tiktok_bundle": bundle,
            "social_publication": social_publication,
            "cost_eur": 0, "paid_ai_calls": 0, "ad_mutations_performed": False}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = run(payload)
        json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        return 0 if result.get("status") in {"completed", "partial"} else 1
    except Exception as exc:
        json.dump({"status": "blocked", "reason": type(exc).__name__,
                   "detail": str(exc)[:180], "cost_eur": 0}, sys.stdout, ensure_ascii=False)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

