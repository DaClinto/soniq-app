print("Music downloader started!")

from pytubefix import YouTube, Search
import os
import sys

def download_from_youtube(song_query, download_folder):
    print(f"Searching YouTube for: {song_query}")
    
    if not os.path.exists(download_folder):
        os.makedirs(download_folder, exist_ok=True)
        print(f"Created folder: {download_folder}")
    
    try:
        # Check if direct YouTube URL or search query
        if "youtube.com" in song_query or "youtu.be" in song_query:
            video = YouTube(song_query)
        else:
            # Search for videos
            search = Search(song_query + " Audio")
            
            if not search.results:
                print(f"No results found for: {song_query}")
                return False
            
            # Get the first video from search results
            video = search.results[0]
            
        print(f"Found video: {video.title}")
        
        # Get the audio stream
        audio_stream = video.streams.get_audio_only()
        
        if audio_stream:
            # Use the video title as the filename
            safe_title = "".join([c for c in video.title if c.isalnum() or c in (' ', '-', '_')]).rstrip()
            filename = f"{safe_title}.mp3"
            file_path = os.path.join(download_folder, filename)
            
            print(f"Downloading: {filename}")
            audio_stream.download(output_path=download_folder, filename=filename)
            print(f"Downloaded: {filename}")
            print(f"Saved to: {file_path}")
            return {
                "success": True,
                "title": video.title,
                "artist": getattr(video, "author", "YouTube Artist"),
                "filename": filename,
                "file_path": file_path
            }
        else:
            print(f"No audio stream found for {video.title}")
            return False
            
    except Exception as e:
        print(f"Error downloading: {str(e)}")
        return False

# Main program
if __name__ == "__main__":
    # Default to user's Music_Downloads directory on Windows
    download_folder = os.path.join(os.path.expanduser("~"), "Music_Downloads")
    
    # Check if passed as argument or interactive input
    if len(sys.argv) > 1:
        song_query = " ".join(sys.argv[1:])
    else:
        song_query = input("Enter song name (you can include artist): ")
    
    if song_query:
        download_from_youtube(song_query, download_folder)
    else:
        print("No song entered. Exiting.")
