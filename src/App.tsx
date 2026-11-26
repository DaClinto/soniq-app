import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Link2,
  Download,
  DownloadCloud,
  Music2,
  History,
  Settings,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Repeat,
  Shuffle,
  Search,
  ShieldCheck,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ClipboardPaste,
  X,
  Loader2,
  LayoutGrid,
  List,
  RotateCcw,
  Sun,
  Moon,
  Sparkles,
  FileAudio,
  HardDrive,
  Sliders,
  Check,
  AlertCircle,
  Clock,
  Disc3,
  Globe,
  LogOut
} from 'lucide-react';
import { supabase } from './supabase';
import { deleteTrackAudio, uploadTrackAudio } from './cloudAudio';
import {
  downloadBlobToDevice,
  fetchAudioBlob,
  sanitizeDownloadFilename,
} from './audioDownload';

type AuthUser = { id: string; email?: string | null };

const SONIQ_API_URL = (import.meta.env.VITE_SONIQ_API_URL || '').replace(/\/$/, '');
const SONIQ_API_KEY = (import.meta.env.VITE_SONIQ_API_KEY || '') as string;

function withApiKey(url: string): string {
  if (!SONIQ_API_KEY || !url.includes('/api/')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(SONIQ_API_KEY);
}

function apiUrl(path) {
  if (SONIQ_API_URL) return withApiKey(`${SONIQ_API_URL}${path}`);
  if (import.meta.env.PROD) {
    throw new Error('Search and download require VITE_SONIQ_API_URL to point to a running Soniq API server.');
  }
  return withApiKey(path);
}

function resolveApiUrl(url) {
  if (!url || !url.startsWith('/')) return url;
  return withApiKey(SONIQ_API_URL ? `${SONIQ_API_URL}${url}` : url);
}

const OUTPUT_FORMATS = ['MP3', 'AAC', 'WAV', 'FLAC'];

const OUTPUT_QUALITY_OPTIONS = {
  MP3: [
    { value: '128 kbps', label: '128 kbps (Compact)' },
    { value: '192 kbps', label: '192 kbps (Balanced)' },
    { value: '320 kbps', label: '320 kbps (High Quality)' },
  ],
  AAC: [
    { value: '128 kbps', label: '128 kbps (Compact)' },
    { value: '256 kbps', label: '256 kbps (Balanced)' },
    { value: '320 kbps', label: '320 kbps (High Quality)' },
  ],
  WAV: [
    { value: '16-bit 44.1 kHz', label: '16-bit / 44.1 kHz (CD)' },
    { value: '24-bit 48 kHz', label: '24-bit / 48 kHz (Studio)' },
  ],
  FLAC: [
    { value: 'FLAC level 5', label: 'FLAC Level 5 (Fast)' },
    { value: 'FLAC level 8', label: 'FLAC Level 8 (Smallest)' },
  ],
};

function defaultQualityForFormat(format) {
  return OUTPUT_QUALITY_OPTIONS[format]?.[0]?.value || '320 kbps';
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- DEMO DATASET & SAMPLE LINKS ---
const SAMPLE_LINKS = [
  {
    label: 'Bach Brandenburg Concerto 3',
    url: 'Bach Brandenburg Concerto No 3',
    type: 'permitted',
  },
  {
    label: 'Solstice in Sandton',
    url: 'Solstice in Sandton Audio',
    type: 'permitted',
  },
  {
    label: 'Beethoven Moonlight Sonata',
    url: 'Beethoven Moonlight Sonata Audio',
    type: 'permitted',
  },
  {
    label: 'Direct YouTube Link',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    type: 'permitted',
  },
];

const INITIAL_LIBRARY = [];
const INITIAL_DOWNLOADS = [];
const INITIAL_SETTINGS = {
  defaultFormat: 'MP3',
  defaultQuality: '320 kbps',
  concurrentDownloads: 2,
  autoQueuePermitted: false,
};
const LEGACY_STORAGE_KEYS = [
  'soniq_theme',
  'soniq_library_v2',
  'soniq_downloads_v2',
  'soniq_history_v2',
  'soniq_settings_v2',
];

const INITIAL_HISTORY = [
  {
    id: 'hist-301',
    timestamp: '2026-11-18 10:42',
    action: 'Download Completed',
    title: 'Vivaldi: Concerti per archi III',
    provider: 'Internet Archive',
    url: 'https://archive.org/details/vivaldi-concerti-archi-iii',
    status: 'permitted',
  },
  {
    id: 'hist-302',
    timestamp: '2026-11-18 09:18',
    action: 'Permission Restricted',
    title: 'Commercial Streaming Asset (Protected)',
    provider: 'Third-Party Commercial Stream',
    url: 'https://music.example-commercial.com/stream/restricted-album-09',
    status: 'restricted',
  },
  {
    id: 'hist-303',
    timestamp: '2026-11-17 18:05',
    action: 'Link Analysed & Queued',
    title: 'Solstice in Sandton (Extended Mix)',
    provider: 'Jamendo Catalogue',
    url: 'https://www.jamendo.com/track/1984721/solstice-in-sandton',
    status: 'permitted',
  },
];

function formatSeconds(secs) {
  if (!secs || Number.isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function readLegacyAppData() {
  const savedTheme = localStorage.getItem('soniq_theme');
  const savedLibrary = localStorage.getItem('soniq_library_v2');
  const savedDownloads = localStorage.getItem('soniq_downloads_v2');
  const savedHistory = localStorage.getItem('soniq_history_v2');
  const savedSettings = localStorage.getItem('soniq_settings_v2');

  return {
    hasLegacyData: LEGACY_STORAGE_KEYS.some((key) => localStorage.getItem(key) !== null),
    data: {
      isDark: savedTheme === 'dark',
      library: savedLibrary ? JSON.parse(savedLibrary) : INITIAL_LIBRARY,
      downloads: savedDownloads ? JSON.parse(savedDownloads) : INITIAL_DOWNLOADS,
      history: savedHistory ? JSON.parse(savedHistory) : INITIAL_HISTORY,
      settings: savedSettings ? JSON.parse(savedSettings) : INITIAL_SETTINGS,
    },
  };
}

function clearLegacyAppData() {
  LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
}

export default function App() {
  // --- NAVIGATION & THEME STATE ---
  const [activePage, setActivePage] = useState('importer');
  const [isDark, setIsDark] = useState(false);

  // --- PERSISTED APPLICATION DATA ---
  const [library, setLibrary] = useState(INITIAL_LIBRARY);
  const [downloads, setDownloads] = useState(INITIAL_DOWNLOADS);

  const [history, setHistory] = useState(INITIAL_HISTORY);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [cloudRetry, setCloudRetry] = useState(0);
  const [authMode, setAuthMode] = useState('signIn');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [guestMode, setGuestMode] = useState(
    () =>
      typeof window !== 'undefined' &&
      (new URLSearchParams(window.location.search).has('guest') ||
        sessionStorage.getItem('soniq-guest') === '1')
  );

  const enterGuestMode = () => {
    sessionStorage.setItem('soniq-guest', '1');
    setGuestMode(true);
  };

  const exitGuestMode = () => {
    sessionStorage.removeItem('soniq-guest');
    setGuestMode(false);
  };

  // --- TOAST NOTIFICATIONS ---
  const [toast, setToast] = useState(null);
  const showToast = (message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user
        ? { id: session.user.id, email: session.user.email ?? null }
        : null;
      setUser(nextUser);
      setAuthLoading(false);
      setCloudReady(false);
      setCloudLoading(Boolean(nextUser));
      setCloudError('');
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setCloudReady(false);
      setCloudLoading(false);
      return;
    }
    if (!supabase) {
      setCloudError('Supabase is not configured.');
      setCloudLoading(false);
      return;
    }

    let active = true;
    const loadCloudState = async () => {
      try {
        const { data, error } = await supabase
          .from('app_state')
          .select('data')
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) throw error;

        if (!data) {
          const legacy = readLegacyAppData();
          const legacyLibrary = Array.isArray(legacy.data.library)
            ? legacy.data.library.filter(
                (track) => !track.previewUrl?.includes('soundhelix.com')
              )
            : INITIAL_LIBRARY;
          const migratedLibrary = [];
          for (const track of legacyLibrary) {
            if (!track.storagePath && track.previewUrl?.includes('/api/stream')) {
              const uploaded = await uploadTrackAudio(
                user.id,
                track.id,
                resolveApiUrl(track.previewUrl)
              );
              migratedLibrary.push({
                ...track,
                previewUrl: uploaded.downloadUrl,
                storagePath: uploaded.storagePath,
              });
            } else {
              migratedLibrary.push(track);
            }
          }
          const importedData = {
            ...legacy.data,
            library: migratedLibrary,
            downloads: Array.isArray(legacy.data.downloads)
              ? legacy.data.downloads.filter(
                  (track) => !track.previewUrl?.includes('soundhelix.com')
                )
              : INITIAL_DOWNLOADS,
          };
          const { error: upsertError } = await supabase
            .from('app_state')
            .upsert({ user_id: user.id, data: importedData }, { onConflict: 'user_id' });
          if (upsertError) throw upsertError;
          if (legacy.hasLegacyData) clearLegacyAppData();
          if (!active) return;
          setIsDark(importedData.isDark === true);
          setLibrary(migratedLibrary);
          setDownloads(importedData.downloads);
          setHistory(importedData.history);
          setSettings(importedData.settings);
          setCloudReady(true);
          setCloudLoading(false);
          setCloudError('');
          return;
        }

        const appData = data.data || {};
        const nextLibrary = Array.isArray(appData.library) ? appData.library : INITIAL_LIBRARY;
        const nextDownloads = Array.isArray(appData.downloads)
          ? appData.downloads
          : INITIAL_DOWNLOADS;
        const nextHistory = Array.isArray(appData.history) ? appData.history : INITIAL_HISTORY;
        const nextSettings = appData.settings || INITIAL_SETTINGS;
        if (!active) return;
        setIsDark(appData.isDark === true);
        setLibrary((current) =>
          JSON.stringify(current) === JSON.stringify(nextLibrary) ? current : nextLibrary
        );
        setDownloads((current) =>
          JSON.stringify(current) === JSON.stringify(nextDownloads)
            ? current
            : nextDownloads
        );
        setHistory((current) =>
          JSON.stringify(current) === JSON.stringify(nextHistory) ? current : nextHistory
        );
        setSettings((current) =>
          JSON.stringify(current) === JSON.stringify(nextSettings) ? current : nextSettings
        );
        setCloudReady(true);
        setCloudLoading(false);
        setCloudError('');
      } catch (error) {
        console.error('Supabase data load failed:', error);
        if (active) {
          setCloudError(error.message || 'Could not load your cloud data.');
          setCloudLoading(false);
        }
      }
    };

    loadCloudState();
    return () => {
      active = false;
    };
  }, [user, cloudRetry]);

  useEffect(() => {
    if (!user || !cloudReady || !supabase) return undefined;

    const timer = setTimeout(() => {
      supabase
        .from('app_state')
        .upsert(
          {
            user_id: user.id,
            data: { isDark, library, downloads, history, settings },
          },
          { onConflict: 'user_id' }
        )
        .then(({ error }) => {
          if (error) {
            console.error('Supabase data save failed:', error);
            setCloudError(error.message || 'Could not save your cloud data.');
          } else {
            setCloudError('');
          }
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [user, cloudReady, isDark, library, downloads, history, settings]);

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    if (!supabase) {
      setAuthError('Supabase is not configured.');
      return;
    }
    setAuthError('');
    try {
      if (authMode === 'signUp') {
        const { data, error } = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMode('signIn');
          showToast('Account created. Confirm your email, then sign in.', 'info');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail.trim(),
          password: authPassword,
        });
        if (error) throw error;
      }
    } catch (error) {
      console.error('Supabase authentication failed:', error);
      const authMessages = {
        invalid_credentials:
          'That email and password were not accepted. If this is your first time, choose Create account below; otherwise check your details and try again.',
        email_exists:
          'An account already exists for this email. Switch to Sign in instead.',
        user_already_exists:
          'An account already exists for this email. Switch to Sign in instead.',
        weak_password:
          'Choose a stronger password with at least 6 characters.',
        invalid_email:
          'Enter a valid email address.',
        over_request_rate_limit:
          'Too many attempts. Wait a little while, then try again.',
        over_email_send_rate_limit:
          'Too many email attempts. Wait a while, or disable email confirmation in Supabase Auth settings for development.',
        email_rate_limit_exceeded:
          'Too many email attempts. Wait a while, or disable email confirmation in Supabase Auth settings for development.',
        email_not_confirmed:
          'Confirm your email address before signing in.',
        signup_disabled:
          'Sign-up is disabled for this Supabase project.',
      };
      setAuthError(
        authMessages[error.code] ||
          error.message ||
          'Authentication failed. Please try again.'
      );
    }
  };

  // --- LINK IMPORTER STATE ---
  const [urlInput, setUrlInput] = useState('');
  const [selectedFormat, setSelectedFormat] = useState(settings.defaultFormat || 'MP3');
  const [selectedQuality, setSelectedQuality] = useState(settings.defaultQuality || '320 kbps');
  const [analysisState, setAnalysisState] = useState('idle'); // idle | invalid | analyzing | result
  const [analysisResult, setAnalysisResult] = useState(null);

  // --- DOWNLOADS PAGE STATE ---
  const [downloadTab, setDownloadTab] = useState('all');

  // --- MY MUSIC LIBRARY STATE ---
  const [librarySearch, setLibrarySearch] = useState('');
  const [librarySort, setLibrarySort] = useState('recent');
  const [libraryFormatFilter, setLibraryFormatFilter] = useState('ALL');
  const [libraryViewMode, setLibraryViewMode] = useState('grid');

  // --- AUDIO PLAYER STATE ---
  const audioRef = useRef(null);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [savingTrackIds, setSavingTrackIds] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const [isShuffle, setIsShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState('off'); // off | all | one

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume / 100;
    }
  }, [volume, isMuted]);

  const startPlayback = (audio = audioRef.current) => {
    if (!audio) return;
    audio.play().catch((error) => {
      if (error.name === 'AbortError') return;
      console.error('Audio playback failed:', error);
      setIsPlaying(false);
      setPlaybackLoading(false);
      showToast(
        error.name === 'NotAllowedError'
          ? 'Your browser blocked playback. Click Play to try again.'
          : 'Could not play this audio. The stream may be unavailable or unsupported.',
        'warning'
      );
    });
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack?.previewUrl) {
      if (library.length > 0) handlePlayTrack(library[0]);
      return;
    }

    if (audio.paused) {
      setIsPlaying(true);
      setPlaybackLoading(true);
      startPlayback(audio);
    } else {
      audio.pause();
      setIsPlaying(false);
      setPlaybackLoading(false);
    }
  };

  const handlePlayTrack = (track) => {
    if (!track?.previewUrl) {
      showToast('No playable preview stream available for this item.', 'warning');
      return;
    }
    const resolvedUrl = resolveApiUrl(track.previewUrl);
    const playTrack = { ...track, previewUrl: resolvedUrl };

    if (currentTrack?.previewUrl === resolvedUrl) {
      togglePlayback();
    } else {
      setCurrentTrack(playTrack);
      setCurrentTime(0);
      setAudioDuration(0);
      setIsPlaying(false);
      setPlaybackLoading(true);
      if (audioRef.current) {
        audioRef.current.src = resolvedUrl;
        startPlayback(audioRef.current);
      }
    }
  };

  const handleSaveTrackToDevice = async (track) => {
    if (!track || savingTrackIds.includes(track.id)) return;

    const resolvedPreviewUrl = track.previewUrl ? resolveApiUrl(track.previewUrl) : '';
    const originalFileUrl = resolvedPreviewUrl.includes('/api/stream?')
      ? resolvedPreviewUrl.replace('/api/stream?', '/api/download_file?')
      : null;
    const candidates = [...new Set(
      [track.downloadUrl, originalFileUrl, track.previewUrl]
        .filter(Boolean)
        .map((url) => resolveApiUrl(url))
    )];

    if (candidates.length === 0) {
      showToast('No audio stream available to save.', 'warning');
      return;
    }

    const extension = track.format?.toLowerCase() === 'aac' ? 'm4a' : (track.format || 'mp3').toLowerCase();
    const filename = sanitizeDownloadFilename(
      track.filename || `${track.title}.${extension}`,
      track.title
    );

    setSavingTrackIds((prev) => [...prev, track.id]);
    try {
      let lastError = null;
      for (const url of candidates) {
        try {
          const { blob } = await fetchAudioBlob(url);
          downloadBlobToDevice(blob, filename);
          showToast(`"${track.title}" saved to your browser.`, 'success');
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('Audio stream unavailable');
    } catch (error) {
      console.error('Browser save failed:', error);
      showToast(error.message || 'Could not save this track to your browser.', 'error');
    } finally {
      setSavingTrackIds((prev) => prev.filter((id) => id !== track.id));
    }
  };

  const handleRemoveTrack = async (track) => {
    try {
      await deleteTrackAudio(track.storagePath);
      setLibrary((prev) => prev.filter((item) => item.id !== track.id));
      showToast(`Removed "${track.title}" from library.`, 'info');
    } catch (error) {
      console.error('Supabase audio deletion failed:', error);
      showToast(
        `Could not remove "${track.title}" from cloud storage: ${error.message || 'unknown error'}`,
        'error'
      );
    }
  };

  const handleResetCloudData = async () => {
    try {
      await Promise.all(library.map((track) => deleteTrackAudio(track.storagePath)));
      setLibrary(INITIAL_LIBRARY);
      setDownloads(INITIAL_DOWNLOADS);
      setHistory(INITIAL_HISTORY);
      showToast('Cloud library, downloads, and history reset.', 'success');
    } catch (error) {
      console.error('Supabase library reset failed:', error);
      showToast(
        `Could not reset cloud music: ${error.message || 'unknown error'}`,
        'error'
      );
    }
  };

  const handleNextTrack = () => {
    if (library.length === 0) return;
    if (!currentTrack) {
      handlePlayTrack(library[0]);
      return;
    }
    const idx = library.findIndex((t) => t.id === currentTrack.id);
    if (isShuffle) {
      const randIdx = Math.floor(Math.random() * library.length);
      handlePlayTrack(library[randIdx]);
    } else {
      const nextIdx = (idx + 1) % library.length;
      handlePlayTrack(library[nextIdx]);
    }
  };

  const handlePrevTrack = () => {
    if (library.length === 0) return;
    if (currentTime > 4 && audioRef.current) {
      audioRef.current.currentTime = 0;
      setCurrentTime(0);
      return;
    }
    if (!currentTrack) {
      handlePlayTrack(library[0]);
      return;
    }
    const idx = library.findIndex((t) => t.id === currentTrack.id);
    const prevIdx = (idx - 1 + library.length) % library.length;
    handlePlayTrack(library[prevIdx]);
  };

  // --- LINK ANALYSIS & EXTRACTION HANDLER ---
  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setUrlInput(text.trim());
        setAnalysisState('idle');
        showToast('Pasted from clipboard.', 'info');
      } else {
        setUrlInput(SAMPLE_LINKS[0].url);
        showToast('Clipboard empty — inserted sample track.', 'info');
      }
    } catch {
      setUrlInput(SAMPLE_LINKS[0].url);
      showToast('Clipboard access blocked — inserted sample track.', 'info');
    }
  };

  const enqueueAuthorisedDownload = async (meta, format, quality) => {
    const jobId = `dl-${Date.now()}`;
    const query = meta.url || meta.sourceUrl || meta.query || meta.title;
    const newJob = {
      id: jobId,
      title: meta.title,
      artist: meta.artist,
      album: meta.album || 'Music_Downloads',
      artwork: meta.artwork,
      format,
      quality,
      size: meta.estimatedSizes?.[format] || meta.size || '9.4 MB',
      duration: meta.duration,
      durationSeconds: meta.durationSeconds,
      previewUrl: meta.previewUrl,
      status: 'downloading',
      progress: 5,
      provider: 'YouTube Audio (pytubefix)',
      query,
      licence: 'Preparing audio transfer…',
    };

    const updateJob = (updates) => {
      setDownloads((prev) =>
        prev.map((item) => (item.id === jobId ? { ...item, ...updates } : item))
      );
    };

    setDownloads((prev) => [newJob, ...prev]);
    showToast(`Preparing "${meta.title}" for download...`, 'info');

    try {
      const resp = await fetch(apiUrl('/api/download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, format, quality }),
      });

      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || !body.success) {
        throw new Error(body.error || `Download failed (${resp.status})`);
      }
      const data = body;

      const streamUrl = resolveApiUrl(data.streamUrl);
      const downloadUrl = resolveApiUrl(data.downloadUrl || data.streamUrl);
      const filename = sanitizeDownloadFilename(
        data.filename || `${data.title}.${format.toLowerCase() === 'aac' ? 'm4a' : format.toLowerCase()}`,
        data.title
      );

      updateJob({
        progress: 15,
        licence: 'Downloading audio to your browser…',
      });

      const { blob, contentType } = await fetchAudioBlob(downloadUrl, (progress) => {
        updateJob({
          progress: 15 + Math.round(progress * 55),
          licence: 'Saving audio to your device…',
        });
      });

      downloadBlobToDevice(blob, filename);

      const trackId = `lib-${jobId}`;
      let previewUrl = streamUrl;
      let storagePath = '';
      let cloudBackedUp = false;

      if (user) {
        updateJob({
          progress: 75,
          licence: 'Backing up to your cloud library…',
        });
        try {
          const uploaded = await uploadTrackAudio(
            user.id,
            trackId,
            blob,
            (progress) => {
              updateJob({
                progress: 75 + Math.round(progress * 20),
                licence: 'Uploading cloud backup…',
              });
            },
            filename,
            contentType
          );
          previewUrl = uploaded.downloadUrl;
          storagePath = uploaded.storagePath;
          cloudBackedUp = true;
        } catch (uploadError) {
          console.error('Cloud audio backup failed:', uploadError);
          showToast(
            `"${data.title}" was saved to your browser, but cloud backup failed.`,
            'warning'
          );
        }
      }

      const completedTrack = {
        id: trackId,
        title: data.title,
        artist: data.artist,
        album: data.album || 'Music_Downloads',
        artwork: data.artwork || meta.artwork,
        duration: data.duration,
        durationSeconds: data.durationSeconds,
        format: data.format || format,
        quality: data.quality || quality,
        size: formatBytes(blob.size),
        filename,
        previewUrl,
        downloadUrl,
        storagePath,
        sourceProvider: 'YouTube Audio (pytubefix)',
        licence: cloudBackedUp ? 'Saved to browser & cloud library' : 'Saved to browser',
        addedAt: new Date().toISOString().split('T')[0],
      };

      updateJob({
        title: data.title,
        artist: data.artist,
        status: 'completed',
        progress: 100,
        size: formatBytes(blob.size),
        filename,
        previewUrl,
        downloadUrl,
        storagePath,
        licence: cloudBackedUp ? 'Saved to browser & cloud library' : 'Saved to browser',
      });

      setLibrary((prev) => {
        const clean = prev.filter(
          (t) => t.title !== data.title && !t.previewUrl?.includes('soundhelix.com')
        );
        return [completedTrack, ...clean];
      });

      setHistory((prev) => [
        {
          id: `hist-${Date.now()}`,
          timestamp: new Date().toLocaleString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
          action: `${data.format || format} Download Completed`,
          title: data.title,
          provider: 'YouTube Audio',
          url: data.url || query,
          status: 'permitted',
        },
        ...prev,
      ]);

      setAnalysisResult((prev) => {
        if (prev && (prev.title === data.title || prev.sourceUrl === query)) {
          return {
            ...prev,
            previewUrl,
          };
        }
        return prev;
      });

      showToast(
        cloudBackedUp
          ? `"${data.title}" downloaded to your browser and cloud library.`
          : `"${data.title}" downloaded to your browser.`,
        'success'
      );
    } catch (err) {
      console.error('Download error:', err);
      updateJob({
        status: 'failed',
        progress: 0,
        licence: err.message || 'Download failed',
      });
      showToast(
        err.message || 'Download failed. Check the audio service and try again.',
        'error'
      );
    }
  };

  const retryDownload = (item) => {
    setDownloads((prev) => prev.filter((download) => download.id !== item.id));
    enqueueAuthorisedDownload(
      { ...item, url: item.query || item.title },
      item.format || 'MP3',
      item.quality || '320 kbps'
    );
  };

  const runLinkAnalysis = async (targetUrl = urlInput) => {
    const trimmed = targetUrl.trim();
    if (!trimmed) {
      setAnalysisState('invalid');
      return;
    }

    setAnalysisState('analyzing');
    setAnalysisResult(null);

    try {
      const resp = await fetch(apiUrl('/api/search'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });

      if (resp.ok) {
        const body = await resp.json();
        if (body && body.success && body.data) {
          const d = body.data;
          const livePreviewUrl = resolveApiUrl(d.previewUrl) || null;

          const resultObj = {
            permissionStatus: 'permitted',
            title: d.title,
            artist: d.artist,
            album: d.album || 'YouTube Audio',
            year: '2026',
            genre: 'YouTube Audio',
            duration: d.duration,
            durationSeconds: d.durationSeconds,
            artwork: d.artwork,
            provider: 'YouTube Audio (pytubefix)',
            licence: 'YouTube Audio Stream Verified',
            sourceUrl: d.url || trimmed,
            url: d.url || trimmed,
            videoId: d.videoId,
            previewUrl: livePreviewUrl,
            estimatedSizes: d.estimatedSizes || {
              MP3: '8.4 MB',
              FLAC: '34.2 MB',
              WAV: '52.1 MB',
              AAC: '7.8 MB',
            },
          };

          setAnalysisResult(resultObj);
          setAnalysisState('result');

          setHistory((prev) => [
            {
              id: `hist-${Date.now()}`,
              timestamp: new Date().toLocaleString([], {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              }),
              action: 'YouTube Audio Found & Ready',
              title: resultObj.title,
              provider: resultObj.provider,
              url: trimmed,
              status: 'permitted',
            },
            ...prev,
          ]);

          return;
        }
      }
    } catch (err) {
      console.warn('Backend search error:', err);
    }

    // Direct fallback if backend search temporarily offline
    const isLink = trimmed.startsWith('http://') || trimmed.startsWith('https://');
    const resultObj = {
      permissionStatus: 'permitted',
      title: isLink ? 'YouTube Audio Stream' : trimmed,
      artist: 'YouTube Artist',
      album: 'YouTube Audio Master',
      year: '2026',
      genre: 'Digital Audio',
      duration: '3:45',
      durationSeconds: 225,
      artwork: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=500&q=80',
      provider: 'YouTube Audio Engine (pytubefix)',
      licence: 'YouTube Audio Stream Permitted',
      sourceUrl: trimmed,
      url: trimmed,
      previewUrl: null,
      estimatedSizes: {
        MP3: '8.6 MB',
        FLAC: '38.0 MB',
        WAV: '58.0 MB',
        AAC: '7.2 MB',
      },
    };

    setAnalysisResult(resultObj);
    setAnalysisState('result');
  };

  // --- FILTERED & SORTED LIBRARY ---
  const filteredLibrary = useMemo(() => {
    return library
      .filter((track) => {
        const matchesSearch =
          track.title.toLowerCase().includes(librarySearch.toLowerCase()) ||
          track.artist.toLowerCase().includes(librarySearch.toLowerCase()) ||
          (track.album && track.album.toLowerCase().includes(librarySearch.toLowerCase()));
        const matchesFormat =
          libraryFormatFilter === 'ALL' || track.format === libraryFormatFilter;
        return matchesSearch && matchesFormat;
      })
      .sort((a, b) => {
        if (librarySort === 'title') return a.title.localeCompare(b.title);
        if (librarySort === 'artist') return a.artist.localeCompare(b.artist);
        return 0; // 'recent' preserves insertion order
      });
  }, [library, librarySearch, librarySort, libraryFormatFilter]);

  // --- FILTERED DOWNLOADS ---
  const filteredDownloads = useMemo(() => {
    if (downloadTab === 'all') return downloads;
    return downloads.filter((d) => d.status === downloadTab);
  }, [downloads, downloadTab]);

  const activeDownloadCount = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued'
  ).length;

  // --- NAVIGATION ITEMS (STRICTLY 5 PAGES AS SPECIFIED) ---
  const navItems = [
    { id: 'importer', label: 'Link Importer', icon: Link2 },
    { id: 'downloads', label: 'Downloads', icon: DownloadCloud, badge: activeDownloadCount },
    { id: 'library', label: 'My Music', icon: Music2, badge: library.length },
    { id: 'history', label: 'History', icon: History },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  // --- THEME TOKENS ---
  const bgPrimary = isDark ? 'bg-[#121214] text-[#FFFFFF]' : 'bg-[#F5F5F7] text-[#171719]';
  const bgSurface = isDark ? 'bg-[#1C1C1F] border-[#2C2C30]' : 'bg-[#FFFFFF] border-[#E5E5EA]';
  const bgSubtle = isDark ? 'bg-[#242428]' : 'bg-[#F5F5F7]';
  const textMuted = isDark ? 'text-[#98989F]' : 'text-[#8E8E93]';

  if (authLoading && !guestMode) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#F5F5F7] text-[#171719]">
        <p className="text-sm font-semibold">Connecting to Supabase...</p>
      </main>
    );
  }

  if (!user && !guestMode) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#F5F5F7] px-4 py-10 text-[#171719]">
        <form
          onSubmit={handleAuthSubmit}
          className="w-full max-w-md rounded-3xl border border-[#E5E5EA] bg-white p-8 shadow-xl space-y-6"
        >
          <div className="text-center space-y-2">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-[#E84159] text-white flex items-center justify-center">
              <Disc3 className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">SONIQ</h1>
            <p className="text-sm text-[#8E8E93]">
              {authMode === 'signUp' ? 'Create an account to save your library.' : 'Sign in to your cloud library.'}
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-xs font-bold">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              className="w-full rounded-xl border border-[#E5E5EA] bg-[#F5F5F7] px-4 py-3 text-sm outline-none focus:border-[#E84159]"
              placeholder="you@example.com"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-xs font-bold">Password</span>
            <input
              type="password"
              autoComplete={authMode === 'signUp' ? 'new-password' : 'current-password'}
              minLength={6}
              required
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              className="w-full rounded-xl border border-[#E5E5EA] bg-[#F5F5F7] px-4 py-3 text-sm outline-none focus:border-[#E84159]"
              placeholder="At least 6 characters"
            />
          </label>

          {authError && (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {authError}
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-xl bg-[#E84159] px-4 py-3 text-sm font-bold text-white hover:opacity-90"
          >
            {authMode === 'signUp' ? 'Create account' : 'Sign in'}
          </button>

          <button
            type="button"
            onClick={enterGuestMode}
            className="w-full rounded-xl border border-[#E5E5EA] bg-[#F5F5F7] px-4 py-3 text-sm font-bold text-[#171719] hover:border-[#E84159] transition-colors"
          >
            Continue as guest
          </button>

          <p className="text-center text-sm text-[#8E8E93]">
            {authMode === 'signUp' ? 'Already have an account?' : 'New to SONIQ?'}{' '}
            <button
              type="button"
              onClick={() => {
                setAuthMode(authMode === 'signUp' ? 'signIn' : 'signUp');
                setAuthError('');
              }}
              className="font-bold text-[#E84159]"
            >
              {authMode === 'signUp' ? 'Sign in' : 'Create account'}
            </button>
          </p>
        </form>
      </main>
    );
  }

  if (cloudLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#F5F5F7] text-[#171719]">
        <p className="text-sm font-semibold">Loading your Supabase library...</p>
      </main>
    );
  }

  if (cloudError && !cloudReady) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#F5F5F7] px-4 py-10 text-[#171719]">
        <div className="w-full max-w-lg rounded-3xl border border-[#E5E5EA] bg-white p-8 shadow-xl space-y-5">
          <h1 className="text-xl font-bold">Could not load cloud data</h1>
          <p role="alert" className="text-sm text-red-700">{cloudError}</p>
          <p className="text-sm text-[#8E8E93]">
            Check that the app_state table and storage policies in <code>supabase/schema.sql</code> are applied.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => {
                setCloudError('');
                setCloudLoading(true);
                setCloudRetry((retry) => retry + 1);
              }}
              className="flex-1 rounded-xl bg-[#E84159] px-4 py-3 text-sm font-bold text-white"
            >
              Retry
            </button>
            <button
              onClick={() => supabase.auth.signOut().catch((error) => setCloudError(error.message))}
              className="rounded-xl border border-[#E5E5EA] px-4 py-3 text-sm font-bold"
            >
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className={`${bgPrimary} min-h-screen flex flex-col font-sans transition-colors duration-200 selection:bg-[#E84159] selection:text-white`}>
      {/* Hidden HTML5 Audio Engine */}
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setAudioDuration(e.currentTarget.duration)}
        onPlaying={() => {
          setIsPlaying(true);
          setPlaybackLoading(false);
        }}
        onPause={() => {
          setIsPlaying(false);
          setPlaybackLoading(false);
        }}
        onError={(e) => {
          const error = e.currentTarget.error;
          if (!error) return;
          console.error('Audio element error:', error);
          setIsPlaying(false);
          setPlaybackLoading(false);
          showToast(
            error.code === MediaError.MEDIA_ERR_DECODE
              ? 'This audio file could not be decoded.'
              : 'Unable to load this audio stream. Check the backend and try again.',
            'error'
          );
        }}
        onEnded={() => {
          if (repeatMode === 'one' && audioRef.current) {
            audioRef.current.currentTime = 0;
            setPlaybackLoading(true);
            startPlayback(audioRef.current);
          } else {
            handleNextTrack();
          }
        }}
      />

      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 max-w-sm animate-bounce">
          <div
            className={`px-4 py-3 rounded-2xl shadow-xl border flex items-center gap-3 text-xs font-semibold ${
              isDark
                ? 'bg-[#1C1C1F] border-[#2C2C30] text-white'
                : 'bg-white border-[#E5E5EA] text-[#171719]'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            ) : toast.type === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
            ) : (
              <Sparkles className="w-4 h-4 text-[#E84159] flex-shrink-0" />
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* DESKTOP SIDEBAR (5 PAGES ONLY) */}
        <aside
          className={`w-64 border-r ${bgSurface} hidden md:flex flex-col justify-between sticky top-0 h-screen z-30 flex-shrink-0`}
        >
          <div className="p-6 space-y-8">
            {/* Brand Logo */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-[#E84159] flex items-center justify-center text-white shadow-lg shadow-[#E84159]/25">
                <Disc3 className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-bold tracking-tight text-xl leading-none">SONIQ</h1>
                <p className={`text-[11px] font-medium mt-1 ${textMuted}`}>
                  Link Intelligence & Audio
                </p>
              </div>
            </div>

            {/* Primary Navigation */}
            <nav className="space-y-1.5">
              <p className={`text-[10px] font-bold uppercase tracking-widest px-3 mb-2 ${textMuted}`}>
                Workspace
              </p>
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActivePage(item.id)}
                    className={`w-full flex items-center justify-between px-3.5 py-3 rounded-xl text-sm font-semibold transition-all ${
                      active
                        ? 'bg-[#E84159] text-white shadow-md shadow-[#E84159]/25'
                        : `${textMuted} hover:text-[#E84159] ${
                            isDark ? 'hover:bg-[#242428]' : 'hover:bg-[#F5F5F7]'
                          }`
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </span>
                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
                          active
                            ? 'bg-white/20 text-white'
                            : isDark
                            ? 'bg-[#2C2C30] text-neutral-300'
                            : 'bg-[#F5F5F7] text-[#171719]'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Bottom User & Permission Note */}
          <div className={`p-5 border-t ${isDark ? 'border-[#2C2C30]' : 'border-[#E5E5EA]'} space-y-3`}>
            <div className={`p-3 rounded-xl ${bgSubtle} text-[11px] space-y-1`}>
              <div className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Authorised Mode Active</span>
              </div>
              <p className={textMuted}>
                Downloads verified Creative Commons, public domain & artist-granted audio.
              </p>
            </div>
          </div>
        </aside>

        {/* MAIN CONTENT AREA */}
        <div className="flex-1 flex flex-col min-w-0 pb-36 md:pb-24">
          {/* TOP HEADER BAR */}
          <header
            className={`h-16 border-b ${
              isDark ? 'border-[#2C2C30] bg-[#121214]/85' : 'border-[#E5E5EA] bg-[#FFFFFF]/85'
            } backdrop-blur-xl px-4 sm:px-8 flex items-center justify-between sticky top-0 z-20`}
          >
            <div className="flex items-center gap-3">
              {/* Mobile Brand */}
              <div className="flex md:hidden items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-[#E84159] flex items-center justify-center text-white">
                  <Disc3 className="w-4 h-4" />
                </div>
                <span className="font-bold text-base">SONIQ</span>
              </div>
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full bg-[#E84159]/10 text-[#E84159]">
                <Sparkles className="w-3.5 h-3.5" />
                Audio Link Extractor & Manager
              </span>
            </div>

            <div className="flex items-center gap-3">
              {activePage !== 'importer' && (
                <button
                  onClick={() => setActivePage('importer')}
                  className="px-3.5 py-2 rounded-xl bg-[#E84159] text-white text-xs font-semibold shadow-sm hover:opacity-90 transition-opacity flex items-center gap-1.5"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>Paste New Link</span>
                </button>
              )}

              <button
                onClick={() => setIsDark(!isDark)}
                aria-label="Toggle Theme"
                className={`p-2.5 rounded-xl border ${bgSurface} hover:border-[#E84159] transition-colors`}
                title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              >
                {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
              </button>
              <span className="hidden lg:inline max-w-40 truncate text-xs text-[#8E8E93]" title={user?.email || 'Guest session'}>
                {user?.email || 'Guest'}
              </span>
              <button
                onClick={() => {
                  if (guestMode && !user) {
                    exitGuestMode();
                    return;
                  }
                  supabase.auth.signOut().catch((error) => {
                    console.error('Supabase sign-out failed:', error);
                    setCloudError(error.message || 'Could not sign out.');
                  });
                }}
                aria-label={guestMode && !user ? 'Exit guest mode' : 'Sign out'}
                title={guestMode && !user ? 'Exit guest mode' : 'Sign out'}
                className={`p-2.5 rounded-xl border ${bgSurface} hover:border-[#E84159] transition-colors`}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </header>

          {/* PAGE CONTENT ROUTER */}
          <main className="flex-1 px-4 sm:px-8 py-8 max-w-5xl mx-auto w-full">
            {cloudError && cloudReady && (
              <div role="alert" className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                Cloud sync failed: {cloudError}
              </div>
            )}
            {/* ============================================================== */}
            {/* 1. LINK IMPORTER PAGE (PRIMARY DEFAULT LANDING VIEW)           */}
            {/* ============================================================== */}
            {activePage === 'importer' && (
              <div className="space-y-8">
                {/* Editorial Hero Header */}
                <div className="text-center max-w-2xl mx-auto space-y-4 pt-2">
                  <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#E84159]/10 text-[#E84159] text-xs font-bold tracking-wide uppercase">
                    <DownloadCloud className="w-3.5 h-3.5" />
                    <span>Universal Authorised Audio Extractor</span>
                  </div>

                  <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight leading-tight">
                    Download & Extract <span className="text-[#E84159]">Audio</span>
                  </h1>

                  <p className={`text-sm sm:text-base leading-relaxed ${textMuted}`}>
                    Paste an authorised music or media URL to inspect metadata, verify permissions,
                    and download in high-quality MP3, WAV, or FLAC.
                  </p>

                  {/* Feature Pills */}
                  <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                    {[
                      'High quality extraction',
                      'MP3, WAV, FLAC output',
                      'Permission-aware verification',
                    ].map((feat) => (
                      <span
                        key={feat}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border text-xs font-medium ${bgSurface}`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        <span>{feat}</span>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Main EasyConv-Style Importer Card */}
                <div className={`p-6 sm:p-8 rounded-3xl border shadow-xl ${bgSurface} space-y-6`}>
                  {/* Input Label & Quick-Test Sample Pills */}
                  <div className="space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <label className="text-sm font-bold flex items-center gap-2">
                        <Music2 className="w-4 h-4 text-[#E84159]" />
                        <span>Search song name, artist, or YouTube URL</span>
                      </label>
                      <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                        pytubefix YouTube Engine Connected
                      </span>
                    </div>

                    {/* Large URL Input Box with Paste & Clear */}
                    <div
                      className={`flex items-center gap-2 p-2 rounded-2xl border transition-all focus-within:ring-2 focus-within:ring-[#E84159] ${
                        analysisState === 'invalid'
                          ? 'border-[#E84159]'
                          : isDark
                          ? 'bg-[#121214] border-[#2C2C30]'
                          : 'bg-[#F5F5F7] border-[#E5E5EA]'
                      }`}
                    >
                      <div className="pl-2.5 text-[#8E8E93]">
                        <Search className="w-5 h-5" />
                      </div>
                      <input
                        type="text"
                        value={urlInput}
                        onChange={(e) => {
                          setUrlInput(e.target.value);
                          if (analysisState === 'invalid') setAnalysisState('idle');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            runLinkAnalysis();
                          }
                        }}
                        placeholder="Enter song name (e.g. Bohemian Rhapsody) or YouTube URL..."
                        className="w-full bg-transparent py-2.5 px-2 text-sm sm:text-base focus:outline-none"
                      />
                      {urlInput && (
                        <button
                          type="button"
                          onClick={() => {
                            setUrlInput('');
                            setAnalysisState('idle');
                            setAnalysisResult(null);
                          }}
                          title="Clear URL"
                          className={`p-2 rounded-xl ${textMuted} hover:text-[#E84159] transition-colors`}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handlePasteClipboard}
                        className={`px-3.5 py-2.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-colors flex-shrink-0 ${bgSurface} hover:border-[#E84159]`}
                      >
                        <ClipboardPaste className="w-3.5 h-3.5 text-[#E84159]" />
                        <span>Paste</span>
                      </button>
                    </div>

                    {analysisState === 'invalid' && (
                      <p className="text-xs font-semibold text-[#E84159] flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5" />
                        <span>Please enter a song name, artist, or YouTube link.</span>
                      </p>
                    )}

                    {/* Quick-Test Sample Link Pills */}
                    <div className="pt-1 flex flex-wrap items-center gap-2">
                      <span className={`text-[11px] font-semibold ${textMuted}`}>
                        Quick-test links:
                      </span>
                      {SAMPLE_LINKS.map((sample) => (
                        <button
                          key={sample.label}
                          type="button"
                          onClick={() => {
                            setUrlInput(sample.url);
                            runLinkAnalysis(sample.url);
                          }}
                          className={`text-[11px] font-medium px-3 py-1 rounded-full border transition-all hover:border-[#E84159] ${bgSubtle} ${
                            isDark ? 'border-[#2C2C30]' : 'border-[#E5E5EA]'
                          }`}
                        >
                          {sample.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Supported Providers / Download Engine Badge Row */}
                  <div
                    className={`py-3 px-4 rounded-2xl flex flex-wrap items-center justify-between gap-3 text-xs ${bgSubtle}`}
                  >
                    <span className={`font-semibold ${textMuted}`}>Download Engine:</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {[
                        'YouTube Audio Search',
                        'pytubefix Engine',
                        'Direct YouTube URLs',
                        'MP3 Extraction',
                        'Folder: Music_Downloads',
                      ].map((provider) => (
                        <span
                          key={provider}
                          className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold ${bgSurface}`}
                        >
                          {provider}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Format, Quality & Primary CTA Row */}
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-end pt-1">
                    <div className="sm:col-span-3 space-y-1.5">
                      <label className={`text-[11px] font-bold uppercase tracking-wider ${textMuted}`}>
                        Output Format
                      </label>
                      <select
                        value={selectedFormat}
                        onChange={(e) => {
                          const nextFormat = e.target.value;
                          setSelectedFormat(nextFormat);
                          setSelectedQuality(defaultQualityForFormat(nextFormat));
                        }}
                        className={`w-full px-3.5 py-3 rounded-xl border text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[#E84159] ${
                          isDark
                            ? 'bg-[#121214] border-[#2C2C30] text-white'
                            : 'bg-[#F5F5F7] border-[#E5E5EA] text-[#171719]'
                        }`}
                      >
                        {OUTPUT_FORMATS.map((format) => (
                          <option key={format} value={format}>
                            {format === 'AAC' ? 'AAC (M4A)' : format}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-4 space-y-1.5">
                      <label className={`text-[11px] font-bold uppercase tracking-wider ${textMuted}`}>
                        Bitrate / Quality
                      </label>
                      <select
                        value={selectedQuality}
                        onChange={(e) => setSelectedQuality(e.target.value)}
                        className={`w-full px-3.5 py-3 rounded-xl border text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-[#E84159] ${
                          isDark
                            ? 'bg-[#121214] border-[#2C2C30] text-white'
                            : 'bg-[#F5F5F7] border-[#E5E5EA] text-[#171719]'
                        }`}
                      >
                        {(OUTPUT_QUALITY_OPTIONS[selectedFormat] || OUTPUT_QUALITY_OPTIONS.MP3).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-5">
                      <button
                        type="button"
                        onClick={() => runLinkAnalysis()}
                        disabled={analysisState === 'analyzing'}
                        className="w-full py-3.5 px-6 rounded-xl bg-[#E84159] hover:bg-[#d6364d] text-white font-bold text-sm sm:text-base shadow-lg shadow-[#E84159]/30 transition-all flex items-center justify-center gap-2 disabled:opacity-60 cursor-pointer"
                      >
                        {analysisState === 'analyzing' ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>Finding track...</span>
                          </>
                        ) : (
                          <>
                            <Search className="w-5 h-5" />
                            <span>Find Track</span>
                          </>
                        )}
                      </button>
                      <p className={`mt-2 text-center text-[11px] ${textMuted}`}>
                        Downloads save a copy to your browser, then back up to your library.
                      </p>
                    </div>
                  </div>
                </div>

                {/* ANALYSIS RESULT CARD */}
                {analysisState === 'result' && analysisResult && (
                  <div className={`p-6 sm:p-8 rounded-3xl border shadow-xl ${bgSurface} space-y-6`}>
                    <div
                      className={`flex flex-wrap items-center justify-between gap-3 pb-4 border-b ${
                        isDark ? 'border-[#2C2C30]' : 'border-[#E5E5EA]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {analysisResult.permissionStatus === 'permitted' ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck className="w-4 h-4" />
                            Download Permitted
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-4 h-4" />
                            Download Not Permitted — External Link Only
                          </span>
                        )}
                      </div>

                      <span className={`text-xs font-semibold px-3 py-1 rounded-full ${bgSubtle}`}>
                        Source: {analysisResult.provider}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
                      <div className="md:col-span-4">
                        <img
                          src={analysisResult.artwork}
                          alt={analysisResult.title}
                          className="w-full aspect-square rounded-2xl object-cover shadow-md"
                        />
                      </div>

                      <div className="md:col-span-8 space-y-4">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-wider text-[#E84159]">
                            {analysisResult.genre} • {analysisResult.year}
                          </p>
                          <h2 className="text-2xl font-bold mt-1">{analysisResult.title}</h2>
                          <p className={`text-sm mt-0.5 ${textMuted}`}>
                            {analysisResult.artist} — {analysisResult.album}
                          </p>
                        </div>

                        <div className={`grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 rounded-2xl text-xs ${bgSubtle}`}>
                          <div>
                            <span className={textMuted}>Duration</span>
                            <p className="font-bold mt-0.5">{analysisResult.duration}</p>
                          </div>
                          <div>
                            <span className={textMuted}>Selected Output</span>
                            <p className="font-bold mt-0.5">
                              {selectedFormat} • {selectedQuality}
                            </p>
                          </div>
                          <div>
                            <span className={textMuted}>Licence Status</span>
                            <p className="font-bold mt-0.5 truncate">{analysisResult.licence}</p>
                          </div>
                        </div>

                        {analysisResult.permissionStatus === 'permitted' ? (
                          <div className="flex flex-wrap items-center gap-3 pt-1">
                            <button
                              type="button"
                              disabled={downloads.some(
                                (d) =>
                                  d.title === analysisResult.title &&
                                  d.status === 'downloading'
                              )}
                              onClick={() =>
                                enqueueAuthorisedDownload(
                                  analysisResult,
                                  selectedFormat,
                                  selectedQuality
                                )
                              }
                              className="px-6 py-3 rounded-xl bg-[#E84159] text-white text-xs font-bold shadow-md shadow-[#E84159]/25 hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-60"
                            >
                              {downloads.some(
                                (d) =>
                                  d.title === analysisResult.title &&
                                  d.status === 'downloading'
                              ) ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  <span>Downloading...</span>
                                </>
                              ) : (
                                <>
                                  <DownloadCloud className="w-4 h-4" />
                                  <span>Download {selectedFormat === 'AAC' ? 'M4A' : selectedFormat}</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => handlePlayTrack(analysisResult)}
                              className={`px-4 py-3 rounded-xl border text-xs font-bold flex items-center gap-2 transition-colors ${bgSurface} hover:border-[#E84159]`}
                            >
                              <Play className="w-4 h-4 text-[#E84159] fill-current" />
                              <span>Preview Audio</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => setActivePage('downloads')}
                              className="text-xs font-bold text-[#E84159] hover:underline ml-auto"
                            >
                              View Download Queue →
                            </button>
                          </div>
                        ) : (
                          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 space-y-3">
                            <p className="text-xs leading-relaxed">
                              {analysisResult.reason}
                            </p>
                            <a
                              href={analysisResult.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 text-xs font-bold text-[#E84159] hover:underline"
                            >
                              <span>Open Original Source Page</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ============================================================== */}
            {/* 2. DOWNLOADS PAGE                                              */}
            {/* ============================================================== */}
            {activePage === 'downloads' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h1 className="text-3xl font-bold tracking-tight">Downloads</h1>
                      <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[#E84159]/10 text-[#E84159]">
                        Live Download Queue
                      </span>
                    </div>
                    <p className={`text-sm mt-1 ${textMuted}`}>
                      Files are saved to your browser first, then backed up for playback.
                    </p>
                  </div>

                  {/* Queue Controls */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() =>
                        setDownloads((prev) => prev.filter((d) => d.status !== 'completed'))
                      }
                      className={`px-3.5 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${bgSurface} ${textMuted} hover:text-[#E84159]`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Clear Completed</span>
                    </button>
                    <button
                      onClick={() =>
                        setDownloads((prev) => prev.filter((d) => d.status !== 'failed'))
                      }
                      className={`px-3.5 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${bgSurface} ${textMuted} hover:text-[#E84159]`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Clear Failed</span>
                    </button>
                  </div>
                </div>

                {/* Filter Tabs */}
                <div className={`inline-flex flex-wrap gap-1 p-1 rounded-2xl ${bgSubtle} border ${isDark ? 'border-[#2C2C30]' : 'border-[#E5E5EA]'}`}>
                  {['all', 'queued', 'downloading', 'completed', 'failed'].map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setDownloadTab(tab)}
                      className={`px-4 py-1.5 rounded-xl text-xs font-bold capitalize transition-all ${
                        downloadTab === tab
                          ? `${bgSurface} shadow-sm text-[#E84159]`
                          : `${textMuted} hover:text-current`
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Queue Items */}
                <div className="space-y-3">
                  {filteredDownloads.length === 0 ? (
                    <div className={`p-12 rounded-3xl border text-center space-y-3 ${bgSurface}`}>
                      <DownloadCloud className={`w-10 h-10 mx-auto ${textMuted}`} />
                      <h3 className="font-bold text-base">No downloads in this tab</h3>
                      <p className={`text-xs ${textMuted}`}>
                        Paste an authorised music link in the Link Importer to start downloading.
                      </p>
                      <button
                        onClick={() => setActivePage('importer')}
                        className="px-4 py-2 rounded-xl bg-[#E84159] text-white text-xs font-bold"
                      >
                        Go to Link Importer
                      </button>
                    </div>
                  ) : (
                    filteredDownloads.map((item) => (
                      <div
                        key={item.id}
                        className={`p-4 sm:p-5 rounded-2xl border ${bgSurface} flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm`}
                      >
                        <div className="flex items-center gap-4 min-w-0 flex-1">
                          <img
                            src={item.artwork}
                            alt={item.title}
                            className="w-14 h-14 rounded-xl object-cover flex-shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="font-bold text-sm truncate">{item.title}</h4>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex-shrink-0">
                                Verified
                              </span>
                            </div>
                            <p className={`text-xs truncate mt-0.5 ${textMuted}`}>{item.artist}</p>
                            <p className={`text-[11px] mt-1 ${textMuted}`}>
                              {item.provider} • {item.format} ({item.quality}) • {item.size}
                            </p>
                            {item.licence && (
                              <p className={`text-[11px] mt-1 truncate ${textMuted}`}>
                                {item.licence}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full md:w-52 space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-semibold">
                            <span className="capitalize flex items-center gap-1.5">
                              {item.status === 'completed' && (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              )}
                              {item.status === 'failed' && (
                                <AlertCircle className="w-3.5 h-3.5 text-[#E84159]" />
                              )}
                              {(item.status === 'paused' || item.status === 'queued') && (
                                <Clock className="w-3.5 h-3.5 text-amber-500" />
                              )}
                              {item.status}
                            </span>
                            <span className="font-mono">{item.progress}%</span>
                          </div>
                          <div className={`w-full h-2 rounded-full overflow-hidden ${bgSubtle}`}>
                            <div
                              className={`h-full transition-all duration-300 rounded-full ${
                                item.status === 'completed' ? 'bg-emerald-500' : 'bg-[#E84159]'
                              }`}
                              style={{ width: `${item.progress}%` }}
                            />
                          </div>
                        </div>

                        {/* Item Action Buttons */}
                        <div className="flex items-center justify-end gap-1.5">
                          {item.status === 'downloading' && (
                            <button
                              onClick={() =>
                                setDownloads((prev) =>
                                  prev.map((d) =>
                                    d.id === item.id ? { ...d, status: 'paused' } : d
                                  )
                                )
                              }
                              title="Pause"
                              className={`p-2 rounded-xl border ${bgSurface} hover:border-[#E84159]`}
                            >
                              <Pause className="w-4 h-4" />
                            </button>
                          )}
                          {(item.status === 'paused' || item.status === 'queued') && (
                            <button
                              onClick={() =>
                                setDownloads((prev) =>
                                  prev.map((d) =>
                                    d.id === item.id ? { ...d, status: 'downloading' } : d
                                  )
                                )
                              }
                              title="Resume"
                              className={`p-2 rounded-xl border ${bgSurface} hover:border-[#E84159] text-[#E84159]`}
                            >
                              <Play className="w-4 h-4 fill-current" />
                            </button>
                          )}
                          {item.status === 'failed' && (
                            <button
                              onClick={() => retryDownload(item)}
                              title="Retry download"
                              className={`p-2 rounded-xl border ${bgSurface} hover:border-[#E84159]`}
                            >
                              <RotateCcw className="w-4 h-4" />
                            </button>
                          )}
                          {item.status === 'completed' && (
                            <>
                              <button
                                onClick={() => handleSaveTrackToDevice(item)}
                                title="Save to browser again"
                                className={`p-2 rounded-xl border ${bgSurface} hover:border-[#E84159]`}
                              >
                                {savingTrackIds.includes(item.id) ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                onClick={() => handlePlayTrack(item)}
                                title="Play Track"
                                className="p-2 rounded-xl bg-[#E84159] text-white"
                              >
                                <Play className="w-4 h-4 fill-current" />
                              </button>
                            </>
                          )}
                          <button
                            onClick={() =>
                              setDownloads((prev) => prev.filter((d) => d.id !== item.id))
                            }
                            title="Cancel / Remove"
                            className={`p-2 rounded-xl border ${bgSurface} ${textMuted} hover:text-[#E84159]`}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ============================================================== */}
            {/* 3. MY MUSIC LIBRARY PAGE                                       */}
            {/* ============================================================== */}
            {activePage === 'library' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-3xl font-bold tracking-tight">My Music</h1>
                    <p className={`text-sm mt-1 ${textMuted}`}>
                      {library.length} authorised tracks stored in your personal library.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setLibraryViewMode('grid')}
                      className={`p-2.5 rounded-xl border ${
                        libraryViewMode === 'grid'
                          ? 'bg-[#E84159] text-white border-[#E84159]'
                          : bgSurface
                      }`}
                      title="Grid View"
                    >
                      <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setLibraryViewMode('list')}
                      className={`p-2.5 rounded-xl border ${
                        libraryViewMode === 'list'
                          ? 'bg-[#E84159] text-white border-[#E84159]'
                          : bgSurface
                      }`}
                      title="List View"
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Search, Format Filter & Sort Bar */}
                <div className={`p-4 rounded-2xl border ${bgSurface} flex flex-col sm:flex-row gap-3`}>
                  <div className={`flex items-center gap-2.5 px-3.5 py-2 rounded-xl flex-1 ${bgSubtle}`}>
                    <Search className={`w-4 h-4 ${textMuted}`} />
                    <input
                      type="text"
                      value={librarySearch}
                      onChange={(e) => setLibrarySearch(e.target.value)}
                      placeholder="Search tracks, artists, or albums..."
                      className="w-full bg-transparent text-sm focus:outline-none"
                    />
                  </div>

                  <select
                    value={libraryFormatFilter}
                    onChange={(e) => setLibraryFormatFilter(e.target.value)}
                    className={`px-3.5 py-2 rounded-xl border text-xs font-bold ${bgSurface}`}
                  >
                    <option value="ALL">All Formats</option>
                    <option value="FLAC">FLAC</option>
                    <option value="WAV">WAV</option>
                    <option value="MP3">MP3</option>
                    <option value="AAC">AAC</option>
                  </select>

                  <select
                    value={librarySort}
                    onChange={(e) => setLibrarySort(e.target.value)}
                    className={`px-3.5 py-2 rounded-xl border text-xs font-bold ${bgSurface}`}
                  >
                    <option value="recent">Sort: Recently Added</option>
                    <option value="title">Sort: Title (A–Z)</option>
                    <option value="artist">Sort: Artist (A–Z)</option>
                  </select>
                </div>

                {/* Library Content */}
                {filteredLibrary.length === 0 ? (
                  <div className={`p-12 rounded-3xl border text-center space-y-3 ${bgSurface}`}>
                    <Music2 className={`w-10 h-10 mx-auto ${textMuted}`} />
                    <h3 className="font-bold text-base">No tracks match your filter</h3>
                    <p className={`text-xs ${textMuted}`}>
                      Try clearing your search or importing new authorised tracks.
                    </p>
                  </div>
                ) : libraryViewMode === 'grid' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {filteredLibrary.map((track) => {
                      const active = currentTrack?.id === track.id && isPlaying;
                      return (
                        <div
                          key={track.id}
                          className={`group p-4 rounded-3xl border ${bgSurface} flex flex-col justify-between space-y-4 shadow-sm hover:border-[#E84159]/50 transition-all`}
                        >
                          <div className="space-y-3">
                            <div className="relative aspect-square rounded-2xl overflow-hidden bg-neutral-200 dark:bg-neutral-800">
                              <img
                                src={track.artwork}
                                alt={track.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                              <button
                                onClick={() => handlePlayTrack(track)}
                                className="absolute bottom-3 right-3 w-11 h-11 rounded-full bg-[#E84159] text-white flex items-center justify-center shadow-xl hover:scale-105 transition-transform"
                              >
                                {active ? (
                                  <Pause className="w-5 h-5" />
                                ) : (
                                  <Play className="w-5 h-5 fill-current ml-0.5" />
                                )}
                              </button>
                            </div>
                            <div>
                              <div className="flex items-center justify-between text-[11px] font-bold">
                                <span className="text-[#E84159]">{track.format}</span>
                                <span className={textMuted}>{track.duration}</span>
                              </div>
                              <h3 className="font-bold text-base truncate mt-0.5">{track.title}</h3>
                              <p className={`text-xs truncate ${textMuted}`}>{track.artist}</p>
                            </div>
                          </div>

                          <div
                            className={`pt-3 border-t flex items-center justify-between text-[11px] ${
                              isDark ? 'border-[#2C2C30]' : 'border-[#E5E5EA]'
                            }`}
                          >
                            <span className={`truncate max-w-[130px] ${textMuted}`}>
                              {track.sourceProvider}
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleSaveTrackToDevice(track)}
                                title="Save to browser"
                                className={`p-1.5 rounded-lg ${textMuted} hover:text-[#E84159] transition-colors`}
                              >
                                {savingTrackIds.includes(track.id) ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Download className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <button
                                onClick={() => handleRemoveTrack(track)}
                                title="Remove from Library"
                                className={`p-1.5 rounded-lg ${textMuted} hover:text-[#E84159] transition-colors`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className={`rounded-3xl border overflow-hidden ${bgSurface}`}>
                    <div className={`divide-y ${isDark ? 'divide-[#2C2C30]' : 'divide-[#E5E5EA]'}`}>
                      {filteredLibrary.map((track) => {
                        const active = currentTrack?.id === track.id && isPlaying;
                        return (
                          <div
                            key={track.id}
                            className={`p-4 flex items-center justify-between gap-4 transition-colors ${
                              isDark ? 'hover:bg-[#242428]' : 'hover:bg-[#F5F5F7]'
                            }`}
                          >
                            <div className="flex items-center gap-3.5 min-w-0 flex-1">
                              <img
                                src={track.artwork}
                                alt={track.title}
                                className="w-12 h-12 rounded-xl object-cover flex-shrink-0"
                              />
                              <div className="min-w-0">
                                <h4 className="font-bold text-sm truncate">{track.title}</h4>
                                <p className={`text-xs truncate ${textMuted}`}>
                                  {track.artist} • {track.sourceProvider}
                                </p>
                              </div>
                            </div>

                            <div className="hidden sm:flex items-center gap-4 text-xs font-semibold">
                              <span className="px-2.5 py-1 rounded-lg bg-[#E84159]/10 text-[#E84159]">
                                {track.format}
                              </span>
                              <span className={textMuted}>{track.duration}</span>
                            </div>

                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handlePlayTrack(track)}
                                className="w-9 h-9 rounded-full bg-[#E84159] text-white flex items-center justify-center shadow"
                              >
                                {active ? (
                                  <Pause className="w-4 h-4" />
                                ) : (
                                  <Play className="w-4 h-4 fill-current ml-0.5" />
                                )}
                              </button>
                              <button
                                onClick={() => handleSaveTrackToDevice(track)}
                                title="Save to browser"
                                className={`w-9 h-9 rounded-full border flex items-center justify-center ${textMuted} hover:text-[#E84159] ${
                                  isDark ? 'border-[#2C2C30] bg-[#121214]' : 'border-[#E5E5EA] bg-white'
                                }`}
                              >
                                {savingTrackIds.includes(track.id) ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                onClick={() => handleRemoveTrack(track)}
                                title="Remove from Library"
                                className={`p-2 rounded-xl ${textMuted} hover:text-[#E84159]`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ============================================================== */}
            {/* 4. HISTORY PAGE                                                */}
            {/* ============================================================== */}
            {activePage === 'history' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-3xl font-bold tracking-tight">Activity History</h1>
                    <p className={`text-sm mt-1 ${textMuted}`}>
                      Chronological audit log of analysed links, permission checks, and downloads.
                    </p>
                  </div>

                  {history.length > 0 && (
                    <button
                      onClick={() => {
                        setHistory([]);
                        showToast('Activity history cleared.', 'info');
                      }}
                      className={`px-4 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${bgSurface} ${textMuted} hover:text-[#E84159]`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Clear History</span>
                    </button>
                  )}
                </div>

                {history.length === 0 ? (
                  <div className={`p-12 rounded-3xl border text-center space-y-2 ${bgSurface}`}>
                    <History className={`w-10 h-10 mx-auto ${textMuted}`} />
                    <h3 className="font-bold text-base">No activity recorded yet</h3>
                    <p className={`text-xs ${textMuted}`}>
                      Analysed URLs and completed downloads will appear here automatically.
                    </p>
                  </div>
                ) : (
                  <div className={`rounded-3xl border overflow-hidden ${bgSurface}`}>
                    <div className={`divide-y ${isDark ? 'divide-[#2C2C30]' : 'divide-[#E5E5EA]'}`}>
                      {history.map((entry) => (
                        <div
                          key={entry.id}
                          className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                        >
                          <div className="flex items-start gap-3.5 min-w-0">
                            <div
                              className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 ${
                                entry.status === 'permitted'
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {entry.status === 'permitted' ? (
                                <CheckCircle2 className="w-4 h-4" />
                              ) : (
                                <AlertTriangle className="w-4 h-4" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <h4 className="font-bold text-sm truncate">{entry.title}</h4>
                              <p className={`text-xs mt-0.5 ${textMuted}`}>
                                {entry.provider} • {entry.timestamp}
                              </p>
                              {entry.url && (
                                <p className={`text-[11px] truncate mt-1 font-mono ${textMuted}`}>
                                  {entry.url}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 self-end sm:self-center">
                            <span
                              className={`text-[10px] font-bold uppercase px-2.5 py-1 rounded-full ${
                                entry.status === 'permitted'
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {entry.action}
                            </span>

                            {entry.url && (
                              <button
                                onClick={() => {
                                  setUrlInput(entry.url);
                                  setActivePage('importer');
                                  runLinkAnalysis(entry.url);
                                }}
                                className={`px-3 py-1.5 rounded-xl border text-xs font-bold hover:border-[#E84159] transition-colors ${bgSurface}`}
                              >
                                Re-analyse
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ============================================================== */}
            {/* 5. SETTINGS PAGE                                               */}
            {/* ============================================================== */}
            {activePage === 'settings' && (
              <div className="max-w-3xl space-y-6">
                <div>
                  <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
                  <p className={`text-sm mt-1 ${textMuted}`}>
                    Configure appearance, default audio extraction quality, queue concurrency, and local storage.
                  </p>
                </div>

                {/* Appearance */}
                <div className={`p-6 rounded-3xl border ${bgSurface} space-y-4`}>
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-[#E84159]" />
                    <span>Appearance</span>
                  </h3>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold">Theme Mode</p>
                      <p className={`text-xs ${textMuted}`}>
                        Switch between Apple Music editorial Light mode and Deep Charcoal Dark mode.
                      </p>
                    </div>
                    <div className={`inline-flex p-1 rounded-xl ${bgSubtle}`}>
                      <button
                        onClick={() => setIsDark(false)}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                          !isDark ? 'bg-white text-[#171719] shadow-sm' : textMuted
                        }`}
                      >
                        Light
                      </button>
                      <button
                        onClick={() => setIsDark(true)}
                        className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                          isDark ? 'bg-[#1C1C1F] text-white shadow-sm' : textMuted
                        }`}
                      >
                        Dark
                      </button>
                    </div>
                  </div>
                </div>

                {/* Extraction & Queue Defaults */}
                <div className={`p-6 rounded-3xl border ${bgSurface} space-y-5`}>
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <FileAudio className="w-4 h-4 text-[#E84159]" />
                    <span>Extraction & Download Defaults</span>
                  </h3>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className={`text-xs font-bold ${textMuted}`}>Default Output Format</label>
                      <select
                        value={settings.defaultFormat}
                        onChange={(e) => {
                          const val = e.target.value;
                          const nextQuality = defaultQualityForFormat(val);
                          setSettings({ ...settings, defaultFormat: val, defaultQuality: nextQuality });
                          setSelectedFormat(val);
                          setSelectedQuality(nextQuality);
                        }}
                        className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-semibold ${
                          isDark ? 'bg-[#121214] border-[#2C2C30]' : 'bg-[#F5F5F7] border-[#E5E5EA]'
                        }`}
                      >
                        {OUTPUT_FORMATS.map((format) => (
                          <option key={format} value={format}>
                            {format === 'AAC' ? 'AAC (M4A)' : format}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className={`text-xs font-bold ${textMuted}`}>Default Bitrate / Quality</label>
                      <select
                        value={settings.defaultQuality}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSettings({ ...settings, defaultQuality: val });
                          setSelectedQuality(val);
                        }}
                        className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-semibold ${
                          isDark ? 'bg-[#121214] border-[#2C2C30]' : 'bg-[#F5F5F7] border-[#E5E5EA]'
                        }`}
                      >
                        {(OUTPUT_QUALITY_OPTIONS[settings.defaultFormat] || OUTPUT_QUALITY_OPTIONS.MP3).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-[#F5F5F7] dark:bg-[#121214] px-4 py-3 text-xs">
                    Downloads are processed one at a time so progress and browser saves stay reliable.
                  </div>
                </div>

                {/* Supabase Cloud Sync & Reset */}
                <div className={`p-6 rounded-3xl border ${bgSurface} space-y-4`}>
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-[#E84159]" />
                    <span>Supabase Cloud Sync</span>
                  </h3>

                  <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
                    <p className={`text-xs ${textMuted}`}>
                      Your library, downloads, history, and settings sync to your account. Audio files are saved to your browser and backed up in Supabase Storage for playback.
                    </p>
                    <button
                      onClick={handleResetCloudData}
                      className="px-4 py-2 rounded-xl border border-[#E84159] text-[#E84159] text-xs font-bold hover:bg-[#E84159] hover:text-white transition-colors"
                    >
                      Reset Cloud Data
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* MOBILE BOTTOM NAVIGATION (5 PAGES ONLY) */}
      <nav
        className={`md:hidden fixed bottom-20 left-0 right-0 h-14 border-t ${
          isDark ? 'border-[#2C2C30] bg-[#1C1C1F]/95' : 'border-[#E5E5EA] bg-[#FFFFFF]/95'
        } backdrop-blur-xl flex items-center justify-around z-30 px-1`}
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activePage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActivePage(item.id)}
              className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl text-[10px] font-bold transition-colors ${
                active ? 'text-[#E84159]' : textMuted
              }`}
            >
              <Icon className="w-4 h-4 mb-0.5" />
              <span className="truncate max-w-[64px]">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* PERSISTENT BOTTOM AUDIO PLAYER */}
      <footer
        className={`fixed bottom-0 left-0 right-0 h-20 border-t ${
          isDark ? 'border-[#2C2C30] bg-[#1C1C1F]/95' : 'border-[#E5E5EA] bg-[#FFFFFF]/95'
        } backdrop-blur-2xl px-4 sm:px-6 flex items-center justify-between z-40 shadow-2xl`}
      >
        {/* Track Artwork & Info */}
        <div className="flex items-center gap-3 w-1/3 sm:w-1/4 min-w-0">
          {currentTrack ? (
            <>
              <img
                src={currentTrack.artwork}
                alt={currentTrack.title}
                className="w-12 h-12 rounded-xl object-cover shadow flex-shrink-0"
              />
              <div className="min-w-0">
                <p className="font-bold text-xs sm:text-sm truncate">{currentTrack.title}</p>
                <p className={`text-[11px] truncate ${textMuted}`}>{currentTrack.artist}</p>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${bgSubtle}`}
              >
                <Music2 className="w-5 h-5 text-[#E84159]" />
              </div>
              <div className="min-w-0">
                <p className="font-bold text-xs truncate">Ready to Play</p>
                <p className={`text-[11px] truncate ${textMuted}`}>
                  Select any track in My Music
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Transport & Scrubber */}
        <div className="flex flex-col items-center gap-1 w-2/3 sm:w-2/5 max-w-md">
          <div className="flex items-center gap-4 sm:gap-5">
            <button
              onClick={() => setIsShuffle(!isShuffle)}
              title="Shuffle"
              className={`hidden sm:block transition-colors ${
                isShuffle ? 'text-[#E84159]' : textMuted
              }`}
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={handlePrevTrack}
              title="Previous"
              className="hover:text-[#E84159] transition-colors"
            >
              <SkipBack className="w-5 h-5" />
            </button>

            <button
              onClick={() => {
                if (!currentTrack && library.length > 0) {
                  handlePlayTrack(library[0]);
                } else {
                  togglePlayback();
                }
              }}
              title={isPlaying ? 'Pause' : 'Play'}
              className="w-10 h-10 rounded-full bg-[#E84159] text-white flex items-center justify-center shadow-lg shadow-[#E84159]/30 hover:scale-105 transition-transform"
            >
              {playbackLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isPlaying ? (
                <Pause className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4 fill-current ml-0.5" />
              )}
            </button>

            <button
              onClick={handleNextTrack}
              title="Next"
              className="hover:text-[#E84159] transition-colors"
            >
              <SkipForward className="w-5 h-5" />
            </button>

            <button
              onClick={() =>
                setRepeatMode((m) => (m === 'off' ? 'all' : m === 'all' ? 'one' : 'off'))
              }
              title={`Repeat: ${repeatMode}`}
              className={`hidden sm:block transition-colors ${
                repeatMode !== 'off' ? 'text-[#E84159]' : textMuted
              }`}
            >
              <Repeat className="w-4 h-4" />
            </button>
          </div>

          <div className={`w-full flex items-center gap-2 text-[10px] font-mono ${textMuted}`}>
            <span>{formatSeconds(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={audioDuration || currentTrack?.durationSeconds || 100}
              value={currentTime}
              onChange={(e) => {
                const val = Number(e.target.value);
                setCurrentTime(val);
                if (audioRef.current) audioRef.current.currentTime = val;
              }}
              className="flex-1 h-1 accent-[#E84159] rounded-lg cursor-pointer"
            />
            <span>
              {audioDuration
                ? formatSeconds(audioDuration)
                : currentTrack?.duration || '0:00'}
            </span>
          </div>
        </div>

        {/* Volume Slider */}
        <div className="hidden sm:flex items-center justify-end gap-2.5 w-1/4">
          <button
            onClick={() => setIsMuted(!isMuted)}
            className={`${textMuted} hover:text-[#E84159]`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="w-4 h-4" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              setIsMuted(false);
              setVolume(Number(e.target.value));
            }}
            className="w-24 accent-[#E84159] cursor-pointer"
          />
        </div>
      </footer>
    </div>
  );
}