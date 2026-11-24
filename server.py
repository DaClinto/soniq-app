import os
import sys
import asyncio
import json
import hashlib
import mimetypes
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import imageio_ffmpeg
import yt_dlp

try:
    from spotapi import Public as SpotifyPublic
except Exception:
    SpotifyPublic = None

PORT = int(os.environ.get("PORT", "5001"))
DOWNLOAD_FOLDER = os.path.join(os.path.expanduser("~"), "Music_Downloads")
VIDEO_FOLDER = os.path.join(os.path.expanduser("~"), "Video_Downloads")
CACHE_FOLDER = os.path.join(tempfile.gettempdir(), "soniq-audio-cache")
CONVERSION_LOCK = threading.Lock()
if not os.path.exists(DOWNLOAD_FOLDER):
    os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)
if not os.path.exists(VIDEO_FOLDER):
    os.makedirs(VIDEO_FOLDER, exist_ok=True)

print(f"[SONIQ Server] Running on http://127.0.0.1:{PORT}")
print(f"[SONIQ Server] Music Downloads Folder: {DOWNLOAD_FOLDER}")

def sanitize_filename(title):
    return "".join([c for c in title if c.isalnum() or c in (' ', '-', '_')]).rstrip()

def audio_content_type(file_path):
    with open(file_path, "rb") as audio_file:
        header = audio_file.read(12)
    if header.startswith(b"ID3") or (
        len(header) > 1 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0
    ):
        return "audio/mpeg"
    if header[4:8] == b"ftyp":
        return "audio/mp4"
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return "audio/wav"
    if header.startswith(b"OggS"):
        return "audio/ogg"
    if header.startswith(b"fLaC"):
        return "audio/flac"
    return mimetypes.guess_type(file_path)[0] or "application/octet-stream"


def video_content_type(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    return {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".m4v": "video/x-m4v",
    }.get(ext) or mimetypes.guess_type(file_path)[0] or "application/octet-stream"

def audio_file_extension(stream):
    subtype = (getattr(stream, "subtype", "") or "").lower()
    mime_type = (getattr(stream, "mime_type", "") or "").lower()
    if subtype == "mp4" or mime_type == "audio/mp4":
        return "m4a"
    if subtype in ("webm", "ogg", "mp3", "wav", "aac", "m4a"):
        return subtype
    if subtype.isalnum():
        return subtype
    raise ValueError(f"Unsupported audio stream type: {mime_type or subtype or 'unknown'}")

def normalize_audio_format(audio_format):
    normalized = (audio_format or "MP3").strip().upper()
    if normalized == "AAC":
        return "AAC"
    if normalized == "WAV":
        return "WAV"
    if normalized == "FLAC":
        return "FLAC"
    return "MP3"


def audio_bitrate(audio_format, quality):
    quality_text = (quality or "").lower()
    for bitrate in ("320", "256", "192", "128"):
        if bitrate in quality_text:
            return f"{bitrate}k"
    return "256k" if audio_format == "AAC" else "320k"


def audio_output_settings(audio_format, quality):
    if audio_format == "WAV":
        codec = "pcm_s24le" if "24" in (quality or "") else "pcm_s16le"
        return "wav", ["-codec:a", codec]
    if audio_format == "FLAC":
        return "flac", ["-codec:a", "flac", "-compression_level", "8"]
    if audio_format == "AAC":
        return "m4a", [
            "-codec:a", "aac",
            "-b:a", audio_bitrate(audio_format, quality),
            "-movflags", "+faststart",
        ]
    return "mp3", ["-codec:a", "libmp3lame", "-b:a", audio_bitrate(audio_format, quality)]


def convert_audio(source_path, output_path, audio_format="MP3", quality="320kbps", cover_path=None):
    extension, codec_args = audio_output_settings(audio_format, quality)
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", source_path,
    ]
    if cover_path and os.path.exists(cover_path) and extension != "wav":
        command += ["-i", cover_path, "-map", "0:a:0", "-map", "1:v:0"]
        if extension == "mp3":
            command += [
                "-c:v", "mjpeg",
                "-id3v2_version", "3",
                "-metadata:s:v", "title=Album cover",
                "-metadata:s:v", "comment=Cover (front)",
            ]
        elif extension == "flac":
            command += ["-c:v", "copy", "-disposition:v", "attached_pic"]
        else:
            command += ["-c:v", "mjpeg", "-disposition:v", "attached_pic"]
    else:
        command += ["-vn"]
    command += [*codec_args, output_path]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        if os.path.exists(output_path):
            os.remove(output_path)
        raise RuntimeError(f"Audio conversion failed: {result.stderr.strip()[-1000:]}")
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("Audio conversion produced an empty file")
    return extension


def convert_to_mp3(source_path, output_path):
    convert_audio(source_path, output_path, "MP3", "320kbps")

def get_playable_audio_path(file_path):
    if audio_content_type(file_path) != "audio/mp4":
        return file_path

    stat = os.stat(file_path)
    cache_key = hashlib.sha256(
        f"{os.path.abspath(file_path)}:{stat.st_size}:{stat.st_mtime_ns}".encode("utf-8")
    ).hexdigest()
    os.makedirs(CACHE_FOLDER, exist_ok=True)
    cached_path = os.path.join(CACHE_FOLDER, f"{cache_key}.mp3")
    if os.path.exists(cached_path):
        return cached_path

    with CONVERSION_LOCK:
        if not os.path.exists(cached_path):
            temporary_path = os.path.join(CACHE_FOLDER, f"{uuid.uuid4().hex}.mp3")
            try:
                convert_to_mp3(file_path, temporary_path)
                os.replace(temporary_path, cached_path)
            finally:
                if os.path.exists(temporary_path):
                    os.remove(temporary_path)
    return cached_path

YDL_BASE_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
    "extractor_args": {"youtube": {"player_client": ["android", "ios", "tv", "web_embedded", "web"]}},
}

DEFAULT_THUMB = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80"

# Music-only filtering for song searches — keeps podcasts, interviews,
# reactions, explainers, DJ sets and other non-music videos out of results.
NON_MUSIC_RE = re.compile(
    r"(podcast|interview|reaction|tutorial|documentary|vlog|"
    r"\bexplained\b|\bexplainer\b|story behind|behind the scenes|"
    r"\btrailer\b|news (report|segment)|\bdebate\b|\bpanel\b|"
    r"#shorts|\bshorts\b|full episode|episode #|"
    r"\bdj\s+(mix|set)\b|album mix|"
    r"\b1 hour\b|\bhour loop\b)",
    re.IGNORECASE,
)
MAX_SONG_SECONDS = 1200  # 20 min — longer uploads are sets/podcasts/lectures


def is_music_entry(entry):
    """True if a flat yt-dlp search entry looks like a playable song."""
    if not entry or not entry.get("id"):
        return False
    ie = entry.get("ie_key")
    if ie and ie != "Youtube":
        return False
    dur = entry.get("duration")
    if isinstance(dur, (int, float)) and dur > MAX_SONG_SECONDS:
        return False
    text = " ".join(str(entry.get(k) or "") for k in ("title", "uploader", "channel"))
    return not NON_MUSIC_RE.search(text)


def ytdlp_extract_info(query):
    is_url = "youtube.com" in query or "youtu.be" in query
    opts = dict(YDL_BASE_OPTS)
    opts["extract_flat"] = not is_url
    opts["default_search"] = "ytsearch8"
    with yt_dlp.YoutubeDL(opts) as ydl:
        if is_url:
            return ydl.extract_info(query, download=False), None
        result = ydl.extract_info(f"ytsearch8:{query} Audio", download=False)
    entries = (result or {}).get("entries") or []
    fallback = None
    for entry in entries:
        if not entry or not entry.get("id"):
            continue
        if fallback is None:
            fallback = entry
        if is_music_entry(entry):
            return entry, None
    if fallback is not None:
        return fallback, None
    return None, "No results found"


def ytdlp_thumbnail(info):
    thumb = ""
    for t in info.get("thumbnails") or []:
        url = t.get("url") if isinstance(t, dict) else None
        if url:
            thumb = url
    return thumb or DEFAULT_THUMB


def build_youtube_track_info(info, query):
    video_id = info.get("id") or ""
    length = int(info.get("duration") or 210)
    author = info.get("uploader") or info.get("channel") or info.get("artist") or "YouTube Artist"
    title = info.get("title") or "YouTube Audio Track"
    watch_url = info.get("webpage_url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else query)
    return {
        "title": title,
        "artist": author,
        "album": "YouTube Audio",
        "duration": f"{length // 60}:{length % 60:02d}",
        "durationSeconds": length,
        "artwork": ytdlp_thumbnail(info),
        "videoId": video_id,
        "url": watch_url,
        "provider": "YouTube Audio Engine (yt-dlp)",
        "licence": "YouTube Audio Stream",
        "format": "MP3",
        "quality": "320 kbps",
        "previewUrl": f"/api/preview_stream?v={video_id}" if video_id else None,
        "estimatedSizes": {
            "MP3": f"{(length * 320 / 8 / 1024 / 1024):.1f} MB" if length else "8.4 MB",
            "FLAC": f"{(length * 900 / 8 / 1024 / 1024):.1f} MB" if length else "34.2 MB",
            "WAV": f"{(length * 1411 / 8 / 1024 / 1024):.1f} MB" if length else "52.1 MB",
            "AAC": f"{(length * 256 / 8 / 1024 / 1024):.1f} MB" if length else "7.8 MB",
        },
    }


def get_youtube_info(query):
    query = (query or "").strip()
    if not query:
        return None
    get_youtube_info.last_error = ""
    try:
        info, err = ytdlp_extract_info(query)
        if not info:
            get_youtube_info.last_error = err or "No results found"
            return None
        return build_youtube_track_info(info, query)
    except Exception as e:
        get_youtube_info.last_error = f"{type(e).__name__}: {e}"
        print(f"[Error] Metadata extraction failed: {e}")
        return None

def ytdlp_download_source(url, out_dir, video_id=""):
    os.makedirs(out_dir, exist_ok=True)
    opts = dict(YDL_BASE_OPTS)
    opts.update({
        "format": "bestaudio/best",
        "outtmpl": os.path.join(out_dir, "%(id)s.%(ext)s"),
        "skip_download": False,
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    prefix = f"{video_id}." if video_id else ""
    for name in sorted(os.listdir(out_dir)):
        if name.startswith(prefix) and not name.endswith((".part", ".ytdl", ".tmp")):
            return os.path.join(out_dir, name)
    raise RuntimeError("yt-dlp did not produce an audio file")


def download_audio(song_query, download_folder=DOWNLOAD_FOLDER, audio_format="MP3", quality="320kbps"):
    print(f"\n[Download] Request received for: {song_query} ({audio_format}/{quality})")
    os.makedirs(download_folder, exist_ok=True)
    download_audio.last_error = ""
    temp_dir = None
    try:
        info, err = ytdlp_extract_info(song_query)
        if not info:
            print(f"[Download] No results for query: {song_query} ({err})")
            return None

        video_id = info.get("id") or ""
        title = info.get("title") or "YouTube Audio Track"
        watch_url = info.get("webpage_url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else song_query)
        requested_format = normalize_audio_format(audio_format)
        requested_quality = quality or "320kbps"
        output_extension, _ = audio_output_settings(requested_format, requested_quality)
        safe_title = sanitize_filename(title)
        filename = f"{safe_title}.{output_extension}"
        file_path = os.path.join(download_folder, filename)
        temporary_output_path = os.path.join(
            download_folder, f".soniq-out-{uuid.uuid4().hex}.{output_extension}"
        )

        temp_dir = tempfile.mkdtemp(prefix="soniq-dl-")
        source_path = ytdlp_download_source(watch_url, temp_dir, video_id)
        cover_path = None
        thumb_url = ytdlp_thumbnail(info)
        if thumb_url and "unsplash" not in thumb_url:
            cover_path = os.path.join(temp_dir, "cover.jpg")
            try:
                req = urllib.request.Request(thumb_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=20) as resp, open(cover_path, "wb") as cover_file:
                    cover_file.write(resp.read())
            except Exception as cover_error:
                print(f"[Cover] Artwork download failed: {cover_error}")
                cover_path = None
        print(f"[Download] Converting to {requested_format}/{requested_quality}: {file_path}")
        try:
            convert_audio(source_path, temporary_output_path, requested_format, requested_quality, cover_path)
            os.replace(temporary_output_path, file_path)
        finally:
            if os.path.exists(temporary_output_path):
                os.remove(temporary_output_path)
        print(f"[Download] Successfully saved: {file_path}")

        file_size = os.path.getsize(file_path) if os.path.exists(file_path) else 0
        size_mb = f"{file_size / (1024 * 1024):.1f} MB"
        meta = build_youtube_track_info(info, song_query)
        display_quality = requested_quality if requested_quality else (
            "Lossless" if requested_format == "FLAC" else "CD Quality" if requested_format == "WAV" else "320 kbps"
        )
        stream_url = f"/api/stream?file={urllib.parse.quote(filename)}"

        return {
            "success": True,
            "id": f"yt-{abs(hash(filename))}",
            "title": title,
            "artist": meta["artist"],
            "album": "YouTube Audio Master",
            "duration": meta["duration"],
            "durationSeconds": meta["durationSeconds"],
            "artwork": meta["artwork"],
            "filename": filename,
            "file_path": file_path,
            "size": size_mb,
            "sizeBytes": file_size,
            "format": requested_format,
            "quality": display_quality,
            "provider": "YouTube Audio (yt-dlp)",
            "licence": "Downloaded to your browser",
            "streamUrl": stream_url,
            "downloadUrl": f"/api/download_file?file={urllib.parse.quote(filename)}",
            "previewUrl": stream_url,
        }
    except Exception as e:
        download_audio.last_error = f"{type(e).__name__}: {e}"
        print(f"[Download Error] {e}")
        return None
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)

def ytdlp_direct_audio_url(video_id):
    """Resolve the direct audio stream URL for a video — no download, fast."""
    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return ""
    opts = dict(YDL_BASE_OPTS)
    opts["format"] = "bestaudio[ext=m4a]/bestaudio/best"
    opts["extract_flat"] = False
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except Exception as e:
        print(f"[DirectURL Error] {e}")
        return ""
    if not info:
        return ""
    url = info.get("url")
    if url:
        return url
    for f in reversed(info.get("formats") or []):
        if f.get("url") and f.get("vcodec") == "none":
            return f["url"]
    return ""


def ytdlp_search_multi(query, n=8):
    query = (query or "").strip()
    if not query:
        return []
    is_url = "youtube.com" in query or "youtu.be" in query
    fetch_n = min(max(n * 2, n + 4), 20)
    opts = dict(YDL_BASE_OPTS)
    opts["extract_flat"] = True
    opts["default_search"] = f"ytsearch{fetch_n}"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            if is_url:
                result = ydl.extract_info(query, download=False)
                entries = [result] if result else []
            else:
                result = ydl.extract_info(f"ytsearch{fetch_n}:{query}", download=False)
                entries = (result or {}).get("entries") or []
    except Exception as e:
        print(f"[MultiSearch Error] {e}")
        return []
    tracks = []
    for entry in entries:
        if len(tracks) >= n:
            break
        if not is_music_entry(entry):
            continue
        tracks.append(build_youtube_track_info(entry, query))
    return tracks


def ytdlp_download_preview(video_id, out_path):
    temp_dir = tempfile.mkdtemp(prefix="soniq-prev-")
    try:
        opts = dict(YDL_BASE_OPTS)
        opts.update({
            "format": "bestaudio/best",
            "outtmpl": os.path.join(temp_dir, "%(id)s.%(ext)s"),
            "skip_download": False,
            "download_sections": [{"start_time": 0, "end_time": 30}],
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "128"}],
        })
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        for name in os.listdir(temp_dir):
            if name.startswith(f"{video_id}.") and name.endswith(".mp3"):
                shutil.move(os.path.join(temp_dir, name), out_path)
                return
        raise RuntimeError("Preview clip not produced")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def scan_local_library():
    tracks = []
    if not os.path.exists(DOWNLOAD_FOLDER):
        return tracks
    for f in os.listdir(DOWNLOAD_FOLDER):
        if f.lower().endswith(('.mp3', '.m4a', '.wav', '.flac', '.webm', '.ogg', '.aac')):
            p = os.path.join(DOWNLOAD_FOLDER, f)
            size_mb = f"{os.path.getsize(p) / (1024*1024):.1f} MB"
            name_no_ext = os.path.splitext(f)[0]
            extension = os.path.splitext(f)[1][1:].upper()
            tracks.append({
                "id": f"local-{abs(hash(f))}",
                "title": name_no_ext,
                "artist": "Local Audio / yt-dlp",
                "album": "Music_Downloads",
                "artwork": "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80",
                "duration": "Audio File",
                "durationSeconds": 240,
                "format": "AAC" if extension == "M4A" else extension,
                "quality": "320 kbps",
                "size": size_mb,
                "previewUrl": f"/api/stream?file={urllib.parse.quote(f)}",
                "sourceProvider": "Local Computer",
                "licence": f"Stored in {DOWNLOAD_FOLDER}",
                "addedAt": "Downloaded"
            })
    return tracks


def ytdlp_extract_video(query):
    """Extract video info without the 'Audio' search suffix used for music."""
    is_url = "youtube.com" in query or "youtu.be" in query
    opts = dict(YDL_BASE_OPTS)
    opts["extract_flat"] = not is_url
    opts["default_search"] = "ytsearch5"
    with yt_dlp.YoutubeDL(opts) as ydl:
        if is_url:
            return ydl.extract_info(query, download=False), None
        result = ydl.extract_info(f"ytsearch5:{query}", download=False)
    entries = (result or {}).get("entries") or []
    for entry in entries:
        if entry and entry.get("id"):
            return entry, None
    return None, "No results found"


def ytdlp_direct_video_url(video_id, height=720):
    """Resolve a direct combined audio+video stream URL — no download, for in-app playback."""
    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return ""
    try:
        h = max(144, min(int(height), 2160))
    except (TypeError, ValueError):
        h = 720
    opts = dict(YDL_BASE_OPTS)
    opts["format"] = f"best[height<={h}]/best"
    opts["extract_flat"] = False
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except Exception as e:
        print(f"[DirectVideoURL Error] {e}")
        return ""
    if not info:
        return ""
    url = info.get("url")
    if url:
        return url
    for f in reversed(info.get("formats") or []):
        u = f.get("url")
        if u and f.get("vcodec") != "none" and f.get("acodec") != "none":
            return u
    return ""


def ytdlp_search_videos(query, n=8):
    query = (query or "").strip()
    if not query:
        return []
    is_url = "youtube.com" in query or "youtu.be" in query
    opts = dict(YDL_BASE_OPTS)
    opts["extract_flat"] = True
    opts["default_search"] = f"ytsearch{n}"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            if is_url:
                result = ydl.extract_info(query, download=False)
                entries = [result] if result else []
            else:
                result = ydl.extract_info(f"ytsearch{n}:{query}", download=False)
                entries = (result or {}).get("entries") or []
    except Exception as e:
        print(f"[VideoSearch Error] {e}")
        return []
    videos = []
    for entry in entries:
        if not entry or not entry.get("id"):
            continue
        info = build_youtube_track_info(entry, query)
        info["isVideo"] = True
        info["previewUrl"] = None
        videos.append(info)
    return videos


def download_video(query, quality="720"):
    """Download a YouTube video as mp4 (best quality up to `quality`p)."""
    print(f"\n[VideoDownload] Request received for: {query} ({quality}p)")
    os.makedirs(VIDEO_FOLDER, exist_ok=True)
    download_video.last_error = ""
    try:
        info, err = ytdlp_extract_video(query)
        if not info:
            download_video.last_error = err or "No results found"
            return None

        video_id = info.get("id") or ""
        title = info.get("title") or "YouTube Video"
        watch_url = info.get("webpage_url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else query)
        try:
            height = max(144, min(int(str(quality).replace("p", "") or 720), 2160))
        except (TypeError, ValueError):
            height = 720
        safe_title = sanitize_filename(title)
        prefix = f"{safe_title}."
        existing = next(
            (n for n in os.listdir(VIDEO_FOLDER)
             if n.startswith(prefix) and n.lower().endswith((".mp4", ".webm", ".mkv", ".mov"))),
            None,
        )
        if existing:
            file_path = os.path.join(VIDEO_FOLDER, existing)
            print(f"[VideoDownload] Already downloaded: {file_path}")
        else:
            opts = dict(YDL_BASE_OPTS)
            opts.update({
                "format": (
                    f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
                    f"bestvideo[height<={height}]+bestaudio/"
                    f"best[height<={height}]/best"
                ),
                "outtmpl": os.path.join(VIDEO_FOLDER, "%(id)s.%(ext)s"),
                "skip_download": False,
                "merge_output_format": "mp4",
            })
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([watch_url])
            produced = None
            for name in sorted(os.listdir(VIDEO_FOLDER)):
                if video_id and name.startswith(f"{video_id}.") and not name.endswith((".part", ".ytdl", ".tmp")):
                    produced = os.path.join(VIDEO_FOLDER, name)
                    break
            if not produced:
                for name in sorted(os.listdir(VIDEO_FOLDER)):
                    if name.startswith(prefix) and not name.endswith((".part", ".ytdl", ".tmp")):
                        produced = os.path.join(VIDEO_FOLDER, name)
                        break
            if not produced:
                raise RuntimeError("yt-dlp did not produce a video file")
            ext = os.path.splitext(produced)[1].lower() or ".mp4"
            file_path = os.path.join(VIDEO_FOLDER, f"{safe_title}{ext}")
            if os.path.abspath(produced) != os.path.abspath(file_path):
                if os.path.exists(file_path):
                    os.remove(file_path)
                os.replace(produced, file_path)
            print(f"[VideoDownload] Successfully saved: {file_path}")

        filename = os.path.basename(file_path)
        file_size = os.path.getsize(file_path)
        meta = build_youtube_track_info(info, query)
        length = int(info.get("duration") or meta.get("durationSeconds") or 0)
        return {
            "success": True,
            "id": f"vid-{abs(hash(filename))}",
            "title": title,
            "artist": meta["artist"],
            "album": "YouTube Video",
            "duration": meta["duration"],
            "durationSeconds": length,
            "artwork": meta["artwork"],
            "filename": filename,
            "file_path": file_path,
            "size": f"{file_size / (1024 * 1024):.1f} MB",
            "sizeBytes": file_size,
            "format": "MP4",
            "quality": f"{height}p",
            "provider": "YouTube Video (yt-dlp)",
            "isVideo": True,
            "videoUrl": f"/api/video_file?file={urllib.parse.quote(filename)}",
            "downloadUrl": f"/api/video_file?file={urllib.parse.quote(filename)}",
            "previewUrl": None,
        }
    except Exception as e:
        download_video.last_error = f"{type(e).__name__}: {e}"
        print(f"[VideoDownload Error] {e}")
        return None


def spotify_search(query, n=10):
    """Fast Spotify metadata via SpotAPI (no API key) — instant artwork/details
    while yt-dlp resolves the actual audio."""
    query = (query or "").strip()
    if not query or SpotifyPublic is None:
        return []

    async def _search():
        result = await SpotifyPublic.search(query, limit=n)
        return list(result.tracks or [])

    try:
        tracks = asyncio.run(_search())
    except Exception as e:
        print(f"[Spotify Error] {e}")
        return []

    out = []
    for t in tracks:
        try:
            artists = ", ".join(
                a.profile.name
                for a in (getattr(t.artists, "items", None) or [])
                if getattr(getattr(a, "profile", None), "name", None)
            )
            album = getattr(getattr(t, "album_of_track", None), "name", "") or ""
            ms = int(getattr(getattr(t, "duration", None), "total_milliseconds", 0) or 0)
            secs = ms // 1000
            sources = getattr(getattr(getattr(t, "album_of_track", None), "cover_art", None), "sources", None) or []
            artwork = ""
            if sources:
                artwork = getattr(max(sources, key=lambda s: getattr(s, "width", 0) or 0), "url", "") or ""
            out.append({
                "id": f"sp-{getattr(t, 'id', '')}",
                "title": getattr(t, "name", "") or "",
                "artist": artists or "Unknown artist",
                "album": album,
                "duration": f"{secs // 60}:{secs % 60:02d}",
                "durationSeconds": secs,
                "artwork": artwork or DEFAULT_THUMB,
                "source": "spotify",
                "needsResolve": True,
            })
        except Exception:
            continue
    return out[:n]


ENTITY_IMAGE_CACHE = {}


def _largest_source_url(sources):
    if not sources:
        return ""
    return getattr(max(sources, key=lambda s: getattr(s, "width", 0) or 0), "url", "") or ""


async def _entity_image_one(name):
    """Artist avatar first, then top track's album art as fallback."""
    r = await SpotifyPublic.search(name, limit=3)
    artists = getattr(r, "artists", None) or []
    for a in artists[:1]:
        url = _largest_source_url(
            getattr(getattr(getattr(a, "visuals", None), "avatar_image", None), "sources", None)
        )
        if url:
            return name, url
    tracks = getattr(r, "tracks", None) or []
    for t in tracks[:2]:
        url = _largest_source_url(
            getattr(getattr(getattr(t, "album_of_track", None), "cover_art", None), "sources", None)
        )
        if url:
            return name, url
    return name, ""


def entity_images(names):
    """Resolve display images for artist/station names via SpotAPI. Cached."""
    if SpotifyPublic is None:
        return {}
    missing = [n for n in names if n not in ENTITY_IMAGE_CACHE]
    if missing:
        async def _fetch():
            return await asyncio.gather(*[_entity_image_one(n) for n in missing])
        try:
            for name, url in asyncio.run(_fetch()):
                ENTITY_IMAGE_CACHE[name] = url
        except Exception as e:
            print(f"[EntityImage Error] {e}")
    return {n: ENTITY_IMAGE_CACHE[n] for n in names if ENTITY_IMAGE_CACHE.get(n)}


def scan_video_library():
    videos = []
    if not os.path.exists(VIDEO_FOLDER):
        return videos
    for f in sorted(os.listdir(VIDEO_FOLDER), key=lambda n: -os.path.getmtime(os.path.join(VIDEO_FOLDER, n))):
        if f.lower().endswith((".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi")):
            p = os.path.join(VIDEO_FOLDER, f)
            size_mb = f"{os.path.getsize(p) / (1024 * 1024):.1f} MB"
            name_no_ext = os.path.splitext(f)[0]
            videos.append({
                "id": f"vid-{abs(hash(f))}",
                "title": name_no_ext,
                "artist": "Downloaded Video",
                "album": "Video_Downloads",
                "artwork": DEFAULT_THUMB,
                "duration": "Video",
                "filename": f,
                "size": size_mb,
                "format": "MP4",
                "isVideo": True,
                "videoUrl": f"/api/video_file?file={urllib.parse.quote(f)}",
                "downloadUrl": f"/api/video_file?file={urllib.parse.quote(f)}",
                "previewUrl": None,
            })
    return videos


class APIHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _get_byte_range(self, file_size):
        range_header = self.headers.get("Range")
        if not range_header:
            return 0, file_size - 1, False

        try:
            unit, value = range_header.split("=", 1)
            if unit != "bytes" or "," in value:
                raise ValueError
            start_text, end_text = value.split("-", 1)
            if not start_text:
                suffix_length = int(end_text)
                if suffix_length <= 0:
                    raise ValueError
                start = max(file_size - suffix_length, 0)
                end = file_size - 1
            else:
                start = int(start_text)
                end = min(int(end_text), file_size - 1) if end_text else file_size - 1
            if start < 0 or start >= file_size or end < start:
                raise ValueError
            return start, end, True
        except (ValueError, AttributeError):
            raise ValueError("Invalid byte range")

    def _send_range_not_satisfiable(self, file_size):
        self.send_response(416)
        self.send_header("Content-Range", f"bytes */{file_size}")
        self.send_header("Content-Length", "0")
        self._send_cors()
        self.end_headers()

    def _serve_audio_file(self, file_path, head_only=False, content_type=None):
        file_size = os.path.getsize(file_path)
        try:
            start, end, is_partial = self._get_byte_range(file_size)
        except ValueError:
            self._send_range_not_satisfiable(file_size)
            return

        self.send_response(206 if is_partial else 200)
        self.send_header("Content-Type", content_type or audio_content_type(file_path))
        self.send_header("Content-Length", str(max(end - start + 1, 0)))
        self.send_header("Accept-Ranges", "bytes")
        if is_partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self._send_cors()
        self.end_headers()

        if not head_only and end >= start:
            with open(file_path, "rb") as audio_file:
                audio_file.seek(start)
                remaining = end - start + 1
                while remaining:
                    data = audio_file.read(min(64 * 1024, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    try:
                        self.wfile.write(data)
                    except ConnectionError:
                        break

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors()
        self.end_headers()

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            if not head_only:
                self.wfile.write(json.dumps({
                    "status": "online",
                    "engine": "yt-dlp",
                    "folder": DOWNLOAD_FOLDER
                }).encode("utf-8"))
            return

        elif parsed.path == "/api/library":
            tracks = scan_local_library()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            if not head_only:
                self.wfile.write(json.dumps({"success": True, "tracks": tracks}).encode("utf-8"))
            return

        elif parsed.path == "/api/preview_stream":
            params = urllib.parse.parse_qs(parsed.query)
            video_id = params.get("v", [None])[0]
            if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                self.send_error(400, "Invalid video id")
                return

            try:
                os.makedirs(CACHE_FOLDER, exist_ok=True)
                preview_path = os.path.join(CACHE_FOLDER, f"youtube-{video_id}.mp3")
                if not os.path.exists(preview_path):
                    with CONVERSION_LOCK:
                        if not os.path.exists(preview_path):
                            print(f"[Preview] Preparing playable audio for video id: {video_id}")
                            ytdlp_download_preview(video_id, preview_path)

                self._serve_audio_file(preview_path, head_only)
                return
            except Exception as e:
                print(f"[Preview Error] {e}")
                try:
                    self.send_error(500, f"Preview failed: {e}")
                except Exception:
                    pass
                return

        elif parsed.path == "/api/download_file":
            params = urllib.parse.parse_qs(parsed.query)
            filename = os.path.basename(params.get("file", [None])[0] or "")
            if not filename:
                self.send_error(400, "Missing filename")
                return
            file_path = os.path.realpath(os.path.join(DOWNLOAD_FOLDER, filename))
            download_root = os.path.realpath(DOWNLOAD_FOLDER)
            if not file_path.startswith(download_root + os.sep):
                self.send_error(400, "Invalid filename")
                return
            if not os.path.exists(file_path):
                self.send_error(404, f"File not found: {filename}")
                return
            self._serve_audio_file(file_path, head_only)
            return

        elif parsed.path == "/api/stream":
            params = urllib.parse.parse_qs(parsed.query)
            filename = os.path.basename(params.get("file", [None])[0] or "")
            if not filename:
                self.send_error(400, "Missing filename")
                return
            file_path = os.path.realpath(os.path.join(DOWNLOAD_FOLDER, filename))
            download_root = os.path.realpath(DOWNLOAD_FOLDER)
            if not file_path.startswith(download_root + os.sep):
                self.send_error(400, "Invalid filename")
                return
            if not os.path.exists(file_path):
                self.send_error(404, f"File not found: {filename}")
                return

            try:
                playable_path = get_playable_audio_path(file_path)
            except Exception as e:
                print(f"[Audio Conversion Error] {e}")
                self.send_error(500, "Unable to prepare this audio for playback")
                return

            self._serve_audio_file(playable_path, head_only)
            return

        elif parsed.path == "/api/preview_url":
            params = urllib.parse.parse_qs(parsed.query)
            video_id = params.get("v", [None])[0]
            if not video_id:
                self.send_error(400, "Missing video id")
                return
            direct = ytdlp_direct_audio_url(video_id)
            self.send_response(200 if direct else 404)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            self.wfile.write(json.dumps({"success": bool(direct), "url": direct}).encode("utf-8"))
            return

        elif parsed.path == "/api/search_multi":
            params = urllib.parse.parse_qs(parsed.query)
            query = params.get("q", params.get("query", [None]))[0]
            try:
                n = max(1, min(int(params.get("n", ["8"])[0] or 8), 15))
            except (TypeError, ValueError):
                n = 8
            if not query:
                self.send_error(400, "Missing query")
                return
            print(f"[MultiSearch] Query: {query} (n={n})")
            tracks = ytdlp_search_multi(query, n)
            self.send_response(200 if tracks else 404)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            self.wfile.write(json.dumps({"success": bool(tracks), "tracks": tracks, "error": "" if tracks else "No results"}).encode("utf-8"))
            return

        elif parsed.path == "/api/search":
            params = urllib.parse.parse_qs(parsed.query)
            query = params.get("q", params.get("query", [None]))[0]
            if not query:
                self.send_error(400, "Missing query")
                return
            print(f"[Search] Query: {query}")
            info = get_youtube_info(query)
            if info:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "data": info}).encode("utf-8"))
            else:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "No results or search failed", "detail": getattr(get_youtube_info, "last_error", "")}).encode("utf-8"))
            return

        elif parsed.path == "/api/videos":
            videos = scan_video_library()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            if not head_only:
                self.wfile.write(json.dumps({"success": True, "videos": videos}).encode("utf-8"))
            return

        elif parsed.path == "/api/video_file":
            params = urllib.parse.parse_qs(parsed.query)
            filename = os.path.basename(params.get("file", [None])[0] or "")
            if not filename:
                self.send_error(400, "Missing filename")
                return
            file_path = os.path.realpath(os.path.join(VIDEO_FOLDER, filename))
            video_root = os.path.realpath(VIDEO_FOLDER)
            if not file_path.startswith(video_root + os.sep):
                self.send_error(400, "Invalid filename")
                return
            if not os.path.exists(file_path):
                self.send_error(404, f"File not found: {filename}")
                return
            self._serve_audio_file(file_path, head_only, content_type=video_content_type(file_path))
            return

        elif parsed.path == "/api/video_stream":
            params = urllib.parse.parse_qs(parsed.query)
            video_id = params.get("v", [None])[0]
            if not video_id:
                self.send_error(400, "Missing video id")
                return
            try:
                h = int(params.get("h", ["720"])[0] or 720)
            except (TypeError, ValueError):
                h = 720
            direct = ytdlp_direct_video_url(video_id, h)
            self.send_response(200 if direct else 404)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            if not head_only:
                self.wfile.write(json.dumps({"success": bool(direct), "url": direct}).encode("utf-8"))
            return

        elif parsed.path == "/api/video_search":
            params = urllib.parse.parse_qs(parsed.query)
            query = params.get("q", params.get("query", [None]))[0]
            try:
                n = max(1, min(int(params.get("n", ["8"])[0] or 8), 15))
            except (TypeError, ValueError):
                n = 8
            if not query:
                self.send_error(400, "Missing query")
                return
            print(f"[VideoSearch] Query: {query} (n={n})")
            videos = ytdlp_search_videos(query, n)
            self.send_response(200 if videos else 404)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            self.wfile.write(json.dumps({"success": bool(videos), "videos": videos, "error": "" if videos else "No results"}).encode("utf-8"))
            return

        elif parsed.path == "/api/spotify_search":
            params = urllib.parse.parse_qs(parsed.query)
            query = params.get("q", params.get("query", [None]))[0]
            try:
                n = max(1, min(int(params.get("n", ["10"])[0] or 10), 20))
            except (TypeError, ValueError):
                n = 10
            if not query:
                self.send_error(400, "Missing query")
                return
            print(f"[SpotifySearch] Query: {query} (n={n})")
            tracks = spotify_search(query, n)
            self.send_response(200 if tracks else 404)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            if not head_only:
                self.wfile.write(json.dumps({"success": bool(tracks), "tracks": tracks, "error": "" if tracks else "No results"}).encode("utf-8"))
            return

        elif parsed.path == "/api/entity_images":
            params = urllib.parse.parse_qs(parsed.query)
            names = [n.strip() for n in (params.get("names", [""])[0] or "").split(",") if n.strip()][:20]
            if not names:
                self.send_error(400, "Missing names")
                return
            images = entity_images(names)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._send_cors()
            self.end_headers()
            if not head_only:
                self.wfile.write(json.dumps({"success": True, "images": images}).encode("utf-8"))
            return

        self.send_error(404, "Endpoint Not Found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            data = json.loads(body)
        except Exception:
            data = {}

        if parsed.path == "/api/search":
            query = data.get("query", "")
            print(f"[Search] Query: {query}")
            info = get_youtube_info(query)
            if info:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "data": info}).encode("utf-8"))
            else:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "No results or search failed", "detail": getattr(get_youtube_info, "last_error", "")}).encode("utf-8"))
            return

        elif parsed.path == "/api/download":
            query = data.get("query", "")
            res = download_audio(
                query,
                DOWNLOAD_FOLDER,
                data.get("format", "MP3"),
                data.get("quality", "320kbps"),
            )
            if res:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps(res).encode("utf-8"))
            else:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Download failed", "detail": getattr(download_audio, "last_error", "")}).encode("utf-8"))
            return

        elif parsed.path == "/api/download_video":
            query = data.get("query") or data.get("url") or ""
            res = download_video(query, data.get("quality", "720"))
            if res:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps(res).encode("utf-8"))
            else:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": "Video download failed", "detail": getattr(download_video, "last_error", "")}).encode("utf-8"))
            return

        self.send_error(404, "Endpoint Not Found")

def run_server():
    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, APIHandler)
    print(f"[SONIQ Server] Ready for requests on port {PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()

if __name__ == '__main__':
    run_server()
