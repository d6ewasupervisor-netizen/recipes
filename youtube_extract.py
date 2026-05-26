"""Extract recipes from YouTube videos (description, transcript, comments)."""

from typing import Any

import yt_dlp
from youtube_transcript_api import YouTubeTranscriptApi

from fetch import youtube_video_id
from text_extract import parse_description_or_comment, parse_transcript


class YouTubeParseError(Exception):
    pass


def _yt_metadata(video_id: str) -> dict[str, Any]:
    opts = {
        "quiet": True,
        "skip_download": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
        "getcomments": True,
    }
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def _fetch_transcript(video_id: str) -> str:
    api = YouTubeTranscriptApi()
    try:
        transcript = api.fetch(video_id)
    except Exception as exc:
        raise YouTubeParseError(f"No transcript available: {exc}") from exc
    return " ".join(snippet.text for snippet in transcript)


def _best_comment_text(comments: list[dict[str, Any]] | None) -> str | None:
    if not comments:
        return None
    ranked = sorted(comments, key=lambda c: c.get("like_count") or 0, reverse=True)
    for comment in ranked[:5]:
        text = (comment.get("text") or "").strip()
        if len(text) > 80 and any(k in text.lower() for k in ("ingredient", "cup", "tbsp", "step", "recipe")):
            return text
    return None


def parse_youtube(url: str) -> dict[str, Any]:
    video_id = youtube_video_id(url)
    if not video_id:
        raise YouTubeParseError("Invalid YouTube URL")

    meta = _yt_metadata(video_id)
    title = meta.get("title") or "YouTube Recipe"
    image_url = meta.get("thumbnail")

    description = (meta.get("description") or "").strip()
    parsed = parse_description_or_comment(description) if description else None

    if not parsed:
        comment_text = _best_comment_text(meta.get("comments"))
        if comment_text:
            parsed = parse_description_or_comment(comment_text)

    if not parsed:
        transcript = _fetch_transcript(video_id)
        parsed = parse_transcript(transcript, title=title)

    if not parsed:
        raise YouTubeParseError("Could not extract a recipe from this video")

    return {
        "title": title,
        "image_url": image_url,
        "base_servings": 4,
        "prep_time": None,
        "cook_time": None,
        "total_time": None,
        "ingredient_lines": parsed["ingredient_lines"],
        "instruction_lines": parsed["instruction_lines"],
    }
