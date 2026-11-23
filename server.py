import os
import sys
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

PORT = int(os.environ.get("PORT", "5001"))
DOWNLOAD_FOLDER = os.path.join(os.path.expanduser("~"), "Music_Downloads")
CACHE_FOLDER = os.path.join(tempfile.gettempdir(), "soniq-audio-cache")
CONVERSION_LOCK = threading.Lock()
if not os.path.exists(DOWNLOAD_FOLDER):
    os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)

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


def convert_audio(source_path, output_path, audio_format="MP3", quality="320kbps"):
    extension, codec_args = audio_output_settings(audio_format, quality)
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", source_path,
        "-vn",
        *codec_args,
        output_path,
    ]
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
}

DEFAULT_THUMB = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80"


def ytdlp_extract_info(query):
    is_url = "youtube.com" in query or "youtu.be" in query
    opts = dict(YDL_BASE_OPTS)
    opts["extract_flat"] = not is_url
    opts["default_search"] = "ytsearch5"
    with yt_dlp.YoutubeDL(opts) as ydl:
        if is_url:
            return ydl.extract_info(query, download=False), None
        result = ydl.extract_info(f"ytsearch5:{query} Audio", download=False)
    entries = (result or {}).get("entries") or []
    for entry in entries:
        if entry and entry.get("id"):
            return entry, None
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
        print(f"[Download] Converting to {requested_format}/{requested_quality}: {file_path}")
        try:
            convert_audio(source_path, temporary_output_path, requested_format, requested_quality)
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

class APIHandler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

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

    def _serve_audio_file(self, file_path, head_only=False):
        file_size = os.path.getsize(file_path)
        try:
            start, end, is_partial = self._get_byte_range(file_size)
        except ValueError:
            self._send_range_not_satisfiable(file_size)
            return

        self.send_response(206 if is_partial else 200)
        self.send_header("Content-Type", audio_content_type(file_path))
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
                            temp_dir = tempfile.mkdtemp(prefix="soniq-preview-")
                            try:
                                source_path = ytdlp_download_source(
                                    f"https://www.youtube.com/watch?v={video_id}",
                                    temp_dir,
                                    video_id,
                                )
                                temporary_path = f"{preview_path}.{uuid.uuid4().hex}.tmp.mp3"
                                try:
                                    convert_to_mp3(source_path, temporary_path)
                                    os.replace(temporary_path, preview_path)
                                finally:
                                    if os.path.exists(temporary_path):
                                        os.remove(temporary_path)
                            finally:
                                shutil.rmtree(temp_dir, ignore_errors=True)

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
