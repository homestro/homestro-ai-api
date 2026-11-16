"""Zero-cost JARVIS chain: Shopify catalog -> SEO/GEO -> Pillow -> FFmpeg -> organic handoffs.

No OpenAI, Apify, advertising API, or paid video service is called. Shopify and Meta
credentials stay in the Node API process; this worker receives only product data.
"""
from __future__ import annotations

import hashlib
import json
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
from agents import creative_seo, product_hunter, tiktok_publisher


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


def _promo_image(product: dict[str, Any], output: Path, work: Path) -> None:
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
    if photo:
        canvas.paste(photo, (40, 40))
    else:
        draw.rounded_rectangle((40, 40, 1040, 940), radius=34, fill="#1c2b42")
        draw.text((80, 80), "HOMESTRO", fill="#ffd22e", font=_font(42))
    draw.rounded_rectangle((40, 930, 1040, 1310), radius=34, fill="#17253a")
    draw.text((84, 970), "HOMESTRO  •  DE / AT", fill="#ffd22e", font=_font(30))
    title = str(product.get("title") or "Produkt bei Homestro")[:130]
    title_font = _font(48)
    y = 1030
    for line in _wrap(draw, title, title_font, 900)[:3]:
        draw.text((84, y), line, fill="#ffffff", font=title_font)
        y += 62
    draw.text((84, 1235), "Details im Homestro Shop entdecken", fill="#cbd5e1", font=_font(26))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="JPEG", quality=90, optimize=True)


def _render_video(product: dict[str, Any], image_path: Path, output: Path, work: Path) -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "blocked", "reason": "FFMPEG_NOT_INSTALLED", "rendered": False}
    input_path = image_path
    use_video = False
    for index, url in enumerate((product.get("video_urls") or [])[:3]):
        candidate = work / f"source-{index}.mp4"
        try:
            _download(url, candidate)
            input_path = candidate
            use_video = True
            break
        except Exception:
            continue
    title = re.sub(r"[\r\n]+", " ", str(product.get("title") or ""))
    hook = f"Alles neu? Entdecke {title} bei Homestro."[:150]
    textfile = work / "hook.txt"
    textfile.write_text(hook, encoding="utf-8")
    escaped = str(textfile).replace("\\", "\\\\").replace(":", "\\:")
    drawtext = f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile='{escaped}':expansion=none:fontsize=38:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=18:x=(w-tw)/2:y=80:enable='lt(t,5)'"
    vf = f"scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x101827,setsar=1,fps=25,{drawtext}"
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    if use_video:
        args += ["-i", str(input_path), "-t", "20", "-vf", vf, "-an"]
    else:
        args += ["-loop", "1", "-framerate", "25", "-i", str(input_path), "-t", "12", "-vf", vf, "-an"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", "-threads", "1", str(output)]
    try:
        subprocess.run(args, check=True, timeout=180, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        return {"status": "blocked", "reason": "FFMPEG_RENDER_FAILED",
                "detail": (error.stderr or "")[-400:], "rendered": False}
    except subprocess.TimeoutExpired:
        return {"status": "blocked", "reason": "FFMPEG_RENDER_TIMEOUT", "rendered": False}
    return {"status": "rendered", "rendered": True, "path": str(output),
            "source": "existing_shopify_video" if use_video else "shopify_product_image",
            "format": "vertical_9_16_mp4", "duration_seconds": 20 if use_video else 12}


def run(payload: dict[str, Any]) -> dict[str, Any]:
    products = payload.get("products") if isinstance(payload.get("products"), list) else []
    trends = payload.get("trends") if isinstance(payload.get("trends"), list) else []
    scout = product_hunter.select_from_shopify_catalog(products, trends)
    if scout.get("status") != "selected":
        return {"status": "blocked", "scout": scout, "creative": None, "video": None}
    product = scout["product"]
    product_id = str(product.get("id") or "")
    product_url = str(product.get("onlineStoreUrl") or f"https://homestro.de/products/{product.get('handle', '')}")
    prices = []
    for variant in product.get("variants") or []:
        if variant.get("availableForSale"):
            try:
                prices.append(float(variant.get("price")))
            except (TypeError, ValueError):
                pass
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
    digest = hashlib.sha256((product_id + str(product.get("handle")) + ":organic-promo-v1").encode()).hexdigest()
    root = Path(payload.get("assets_dir") or "/data/jarvis-unified/assets")
    root.mkdir(parents=True, exist_ok=True)
    work = root / f".work-{digest[:16]}"
    work.mkdir(parents=True, exist_ok=True)
    image_path, video_path = root / f"{digest}.jpg", root / f"{digest}.mp4"
    try:
        _promo_image(product, image_path, work)
        video = _render_video(product, image_path, video_path, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    caption = str(draft.get("social", {}).get("text") or f"{product.get('title')} bei Homestro entdecken.")
    caption = f"{caption}\n\n{product_url}"
    hashtags = ["#Homestro", "#Produktentdecken", "#Alltagsideen", "#OnlineShop"]
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
    return {"status": "completed" if video.get("rendered") else "partial",
            "scout": {k:v for k,v in scout.items() if k != "product"},
            "product": {"id": product_id, "title": product.get("title"),
                        "handle": product.get("handle"), "url": product_url,
                        "image_path": str(image_path)},
            "creative": creative, "video": video, "tiktok_bundle": bundle,
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
