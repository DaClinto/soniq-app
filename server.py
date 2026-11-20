import os
import sys
import json
import hashlib
import mimetypes
import re
import subprocess
import tempfile
import threading
import uuid
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import imageio_ffmpeg
from pytubefix import YouTube, Search

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

def convert_to_mp3(source_path, output_path):
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", source_path,
        "-vn",
        "-codec:a", "libmp3lame",
        "-b:a", "320k",
        output_path,
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        if os.path.exists(output_path):
            os.remove(output_path)
        raise RuntimeError(f"Audio conversion failed: {result.stderr.strip()[-1000:]}")
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("Audio conversion produced an empty MP3 file")

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

def get_youtube_info(query):
    query = query.strip()
    if not query:
        return None
    try:
        if "youtube.com" in query or "youtu.be" in query:
            video = YouTube(query)
            video_id = video.video_id
        else:
            search = Search(query + " Audio")
            if not search.results:
                return None
            video = search.results[0]
            video_id = getattr(video, 'video_id', '')

        title = video.title or "YouTube Audio Track"
        author = getattr(video, 'author', 'YouTube Artist') or 'YouTube Artist'
        length = getattr(video, 'length', 210) or 210
        thumb = getattr(video, 'thumbnail_url', "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80")
        watch_url = f"https://www.youtube.com/watch?v={video_id}" if video_id else query

        return {
            "title": title,
            "artist": author,
            "album": "YouTube Audio",
            "duration": f"{length // 60}:{length % 60:02d}",
            "durationSeconds": length,
            "artwork": thumb,
            "videoId": video_id,
            "url": watch_url,
            "provider": "YouTube Audio Engine (pytubefix)",
            "licence": "YouTube Audio Stream",
            "format": "MP3",
            "quality": "320 kbps",
            "previewUrl": f"/api/preview_stream?v={video_id}" if video_id else None,
            "estimatedSizes": {
                "MP3": f"{(length * 320 / 8 / 1024 / 1024):.1f} MB" if length else "8.4 MB",
                "FLAC": f"{(length * 900 / 8 / 1024 / 1024):.1f} MB" if length else "34.2 MB",
                "WAV": f"{(length * 1411 / 8 / 1024 / 1024):.1f} MB" if length else "52.1 MB",
                "AAC": f"{(length * 256 / 8 / 1024 / 1024):.1f} MB" if length else "7.8 MB",
            }
        }
    except Exception as e:
        print(f"[Error] Metadata extraction failed: {e}")
        return None

def download_audio(song_query, download_folder=DOWNLOAD_FOLDER):
    print(f"\n[Download] Request received for: {song_query}")
    if not os.path.exists(download_folder):
        os.makedirs(download_folder, exist_ok=True)
    try:
        if "youtube.com" in song_query or "youtu.be" in song_query:
            video = YouTube(song_query)
        else:
            search = Search(song_query + " Audio")
            if not search.results:
                print(f"[Download] No results found for query: {song_query}")
                return None
            video = search.results[0]

        print(f"[Download] Selected video: {video.title}")
        audio_stream = video.streams.get_audio_only()
        if not audio_stream:
            print(f"[Download] No audio stream found for {video.title}")
            return None

        safe_title = sanitize_filename(video.title)
        extension = audio_file_extension(audio_stream)
        filename = f"{safe_title}.mp3"
        file_path = os.path.join(download_folder, filename)
        source_filename = f".soniq-{uuid.uuid4().hex}.{extension}"
        source_path = os.path.join(download_folder, source_filename)

        print(f"[Download] Downloading stream to: {file_path}")
        audio_stream.download(output_path=download_folder, filename=source_filename)
        try:
            if extension == "mp3":
                os.replace(source_path, file_path)
            else:
                convert_to_mp3(source_path, file_path)
        finally:
            if os.path.exists(source_path):
                os.remove(source_path)
        print(f"[Download] Successfully saved: {file_path}")

        file_size = os.path.getsize(file_path) if os.path.exists(file_path) else 0
        size_mb = f"{file_size / (1024 * 1024):.1f} MB"
        length = getattr(video, 'length', 210) or 210
        thumb = getattr(video, 'thumbnail_url', "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80")
        author = getattr(video, 'author', 'YouTube Artist') or 'YouTube Artist'

        return {
            "success": True,
            "id": f"yt-{abs(hash(filename))}",
            "title": video.title,
            "artist": author,
            "album": "YouTube Audio Master",
            "duration": f"{length // 60}:{length % 60:02d}",
            "durationSeconds": length,
            "artwork": thumb,
            "filename": filename,
            "file_path": file_path,
            "size": size_mb,
            "format": "MP3",
            "quality": "320 kbps",
            "provider": "YouTube Audio (pytubefix)",
            "licence": "Saved locally to Music_Downloads",
            "streamUrl": f"/api/stream?file={urllib.parse.quote(filename)}"
        }
    except Exception as e:
        print(f"[Download Error] {e}")
        return None

def scan_local_library():
    tracks = []
    if not os.path.exists(DOWNLOAD_FOLDER):
        return tracks
    for f in os.listdir(DOWNLOAD_FOLDER):
        if f.lower().endswith(('.mp3', '.m4a', '.wav', '.webm', '.ogg', '.aac')):
            p = os.path.join(DOWNLOAD_FOLDER, f)
            size_mb = f"{os.path.getsize(p) / (1024*1024):.1f} MB"
            name_no_ext = os.path.splitext(f)[0]
            tracks.append({
                "id": f"local-{abs(hash(f))}",
                "title": name_no_ext,
                "artist": "Local Audio / pytubefix",
                "album": "Music_Downloads",
                "artwork": "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400&q=80",
                "duration": "Audio File",
                "durationSeconds": 240,
                "format": os.path.splitext(f)[1][1:].upper(),
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
                    "engine": "pytubefix",
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
                            stream = YouTube(
                                f"https://www.youtube.com/watch?v={video_id}"
                            ).streams.get_audio_only()
                            if not stream:
                                self.send_error(404, "No audio stream found")
                                return

                            extension = audio_file_extension(stream)
                            source_path = os.path.join(
                                CACHE_FOLDER, f".preview-{uuid.uuid4().hex}.{extension}"
                            )
                            try:
                                stream.download(
                                    output_path=CACHE_FOLDER,
                                    filename=os.path.basename(source_path)
                                )
                                if extension == "mp3":
                                    os.replace(source_path, preview_path)
                                else:
                                    temporary_path = (
                                        f"{preview_path}.{uuid.uuid4().hex}.tmp.mp3"
                                    )
                                    try:
                                        convert_to_mp3(source_path, temporary_path)
                                        os.replace(temporary_path, preview_path)
                                    finally:
                                        if os.path.exists(temporary_path):
                                            os.remove(temporary_path)
                            finally:
                                if os.path.exists(source_path):
                                    os.remove(source_path)

                self._serve_audio_file(preview_path, head_only)
                return
            except ConnectionError:
                return
            except Exception as e:
                print(f"[Preview Error] {e}")
                try:
                    self.send_error(500, f"Preview failed: {e}")
                except Exception:
                    pass
                return

        elif parsed.path == "/api/stream":
            params = urllib.parse.parse_qs(parsed.query)
            filename = params.get("file", [None])[0]
            if not filename:
                self.send_error(400, "Missing filename")
                return
            file_path = os.path.join(DOWNLOAD_FOLDER, filename)
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
                self.wfile.write(json.dumps({"success": False, "error": "No results or search failed"}).encode("utf-8"))
            return

        elif parsed.path == "/api/download":
            query = data.get("query", "")
            res = download_audio(query, DOWNLOAD_FOLDER)
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
                self.wfile.write(json.dumps({"success": False, "error": "Download failed"}).encode("utf-8"))
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
