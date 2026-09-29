import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core"; import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertCircle } from "lucide-react";

import { ErrorBoundary } from "./ErrorBoundary";

import type {
  FormatOption,
  VideoInfo,
  PlaylistEntry,
  PlaylistInfo,
  DownloadRecord,
  NowPlaying,
  PlaySource,
  TabType,
} from "./types";
import {
  parseTimeToSeconds,
  formatSecondsToTime,
} from "./lib/format";
import {
  isVideoFormat,
  isAudioFormat,
} from "./lib/formatClassify";
import { createTranslator } from "./lib/i18n";
import { globalAudioState, routeAudioDevice, applyEqualizerPreset, attachEqualizerToMedia } from "./lib/audioContext";

import { ConfirmDialog } from "./components/common/ConfirmDialog";
import { CloseAppConfirmDialog } from "./components/common/CloseAppConfirmDialog";
import { SettingsTab } from "./components/settings/SettingsTab";
import { MultimediaTab } from "./components/media/MultimediaTab";
import { DownloadsTab } from "./components/downloads/DownloadsTab";
import { UrlInput } from "./components/downloads/UrlInput";
import { SearchResults } from "./components/downloads/SearchResults";
import { VideoCard } from "./components/downloads/VideoCard";
import { PlaylistPanel } from "./components/downloads/PlaylistPanel";
import { BatchProgress } from "./components/downloads/BatchProgress";
import { DuplicateDialog } from "./components/common/DuplicateDialog";
import type { DuplicateDialogState } from "./components/common/DuplicateDialog";
import { RefreshUrlDialog } from "./components/common/RefreshUrlDialog";
import type { RefreshUrlDialogState } from "./components/common/RefreshUrlDialog";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
import { AppShell } from "./components/layout/AppShell";
import { Sidebar } from "./components/layout/Sidebar";
import { ClipboardHud } from "./components/hud/ClipboardHud";
import { BatchQueuePanel, type BatchItem } from "./components/downloads/BatchQueuePanel";


export default function App() {
  const isHud = window.location.search.includes("hud=true");

  // SC-2: The HUD window loads the full App bundle. To prevent it from
  // registering duplicate IPC listeners and calling loadHistory() on every
  // progress tick (which contends with the main window for the same SQLite
  // connection), we short-circuit the two heaviest effects below.

  // Navigation & Tabs
  const [activeTab, setActiveTab] = useState<TabType>("dashboard");
  const [playSource, setPlaySource] = useState<PlaySource>("none");
  const [url, setUrl] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [batchQueueItems, setBatchQueueItems] = useState<BatchItem[]>([]);
  const [showPreviews, setShowPreviews] = useState(true);
  const [duplicateDialog, setDuplicateDialog] = useState<DuplicateDialogState | null>(null);
  const [refreshUrlDialog, setRefreshUrlDialog] = useState<RefreshUrlDialogState | null>(null);
  const [selectedHistoryItems, setSelectedHistoryItems] = useState<Set<string>>(new Set());
  const [confirmDialogState, setConfirmDialogState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    confirmVariant?: "danger" | "accent";
    onConfirm: () => void;
  } | null>(null);

  // Playlist states
  const [playlistInfo, setPlaylistInfo] = useState<PlaylistInfo | null>(null);
  const [showPlaylistSection, setShowPlaylistSection] = useState(true);
  const [selectedPlaylistItems, setSelectedPlaylistItems] = useState<Set<string>>(new Set());

  // Single Global "Now Playing" state — union type distinguishes
  // "playing" from "paused" so the UI can render both correctly.
  const [nowPlaying, setNowPlaying] = useState<NowPlaying>({ type: "none" });

  // In-App Video Player State
  const [activeVideoPlaying, setActiveVideoPlaying] = useState(false);
  const [videoStreamUrl, setVideoStreamUrl] = useState<string | null>(null);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const videoStreamCache = useRef<Map<string, string>>(new Map());

  // ─── F-A1: Silent auto-retry for transient download failures ───
  // YouTube/CDNs intermittently throw 403 / rate-limits that yt-dlp reports
  // as "unavailable" or "network". Retry silently before showing an error.
  const AUTO_RETRY_MAX = 2;
  const AUTO_RETRY_DELAY_MS = 2000;      // base delay; actual = base * 2^attempt
  const TRANSIENT_ERROR_CODES = new Set(["network", "unavailable"]);
  const retryAttemptsRef = useRef<Map<string, number>>(new Map());
  const historyRef = useRef<DownloadRecord[]>([]);
  const handleRetryDownloadRef = useRef<((rec: DownloadRecord) => void) | null>(null);

  const resetInput = () => {
    setUrl("");
    setFetchError("");
    setSelectedFormat(null);
    setVideoInfo(null);
    setPlaylistInfo(null);
    setSearchResults(null);
    setVideoFullscreen(false);
    setShowPreviews(true);
    setIsTrimming(false);
    setActiveCardTaskId(null);
  };

  // YouTube IFrame API PostMessage Command Dispatcher
  const sendIframeCommand = useCallback((func: string, args: any[] = []) => {
    try {
      if (iframeRef.current && iframeRef.current.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          JSON.stringify({
            event: "command",
            func: func,
            args: args,
          }),
          "*"
        );
      }
    } catch (e) {
      console.warn("sendIframeCommand failed:", e);
    }
  }, []);

  // Single entry point for all nowPlaying state changes.
  // Handles mutual exclusion: when video takes over, audio pauses;
  // when audio takes over, video + iframe pause. When next.type is
  // "none", the caller is responsible for pausing whatever is playing.
  //
  // Guard: pausing one media element as a side-effect of the other
  // taking over fires that element's native onPause — which would call
  // us back with "I was paused" and overwrite the newer state. We
  // detect that cross-media pause and refuse to regress.
  // Mirrors `nowPlaying` so transitionPlayback can read the current value
  // synchronously — React state is async, and we need to reject echoes
  // before side effects fire.
  const nowPlayingRef = useRef<NowPlaying>({ type: "none" });

  const transitionPlayback = useCallback((next: NowPlaying) => {
    const prev = nowPlayingRef.current;

    // Cross-media pause echo guard: when video takes over we pause the
    // audio element, which fires audio's native onPause. That echo would
    // otherwise pause the video we just started. Same for the reverse.
    if (prev.type === "video" && next.type === "audio" && next.state === "paused") return;
    if (prev.type === "audio" && next.type === "video" && next.state === "paused") return;

    const source = next.source || (next.type !== "none" ? "dashboard" : undefined);
    const enrichedNext: NowPlaying = { ...next, source };

    nowPlayingRef.current = enrichedNext;
    setNowPlaying(enrichedNext);

    if (source === "multimedia") {
      setPlaySource("downloadedLibrary");
      // Stop all Dashboard playback (YouTube iframe and HTML5 video)
      sendIframeCommand("pauseVideo");
      if (videoElementRef.current && !videoElementRef.current.paused) {
        videoElementRef.current.pause();
      }
      setActiveVideoPlaying(false);
      // Stop Dashboard audio preview
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
      setisAudioElementPlaying(false);
      setPreviewingId(null);
    } else {
      if (next.type !== "none") {
        setPlaySource("livePlaylist");
      }
      if (next.type === "video") {
        if (audioRef.current && !audioRef.current.paused) {
          audioRef.current.pause();
        }
        setisAudioElementPlaying(false);
        setPreviewingId(null);
      } else if (next.type === "audio") {
        if (videoElementRef.current && !videoElementRef.current.paused) {
          videoElementRef.current.pause();
        }
        sendIframeCommand("pauseVideo");
        setActiveVideoPlaying(false);
      }
    }
  }, [sendIframeCommand]);
  // In-Line Audio Preview & Scrubbing State
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [isAudioElementPlaying, setisAudioElementPlaying] = useState(false);
  const [isLoadingAudioId, setIsLoadingAudioId] = useState<string | null>(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);

  // ─── F-29: Bounded audio blob cache with URL revocation ───
  // Every preview creates a Blob + object URL from raw bytes. Without a cap
  // and revoke, these accumulate in browser memory for the entire session.
  // Cap = 8 entries (older evicted first). Revoke on eviction AND on overwrite.
  const AUDIO_CACHE_CAP = 8;
  const audioStreamCache = useRef<Map<string, string>>(new Map());
  const cacheAudioBlobUrl = (songId: string, blobUrl: string) => {
    const cache = audioStreamCache.current;
    // If a stale entry exists for this key, revoke it before overwriting
    const existing = cache.get(songId);
    if (existing && existing !== blobUrl) {
      try { URL.revokeObjectURL(existing); } catch { }
      cache.delete(songId);
    }
    // FIFO eviction: Map preserves insertion order
    while (cache.size >= AUDIO_CACHE_CAP) {
      const firstKey = cache.keys().next().value as string | undefined;
      if (!firstKey) break;
      const firstUrl = cache.get(firstKey);
      if (firstUrl) {
        try { URL.revokeObjectURL(firstUrl); } catch { }
      }
      cache.delete(firstKey);
    }
    cache.set(songId, blobUrl);
  };

  // --- NEW: Audio Output Devices State ---
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>("default");

  const refreshAudioDevices = async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === "audiooutput");
      setAudioDevices(outputs.length > 0 ? outputs : [{ deviceId: "default", label: "Default System Audio", kind: "audiooutput", groupId: "", toJSON: () => ({}) }]);
    } catch (e) {
      console.error("Device enumeration error:", e);
    }
  };
  // W2-9: expose folder/file openers globally so PlaylistPanel chips can
  // trigger the same behavior without prop drilling.
  useEffect(() => {
    // SC-2: only the main window exposes these globals.
    if (isHud) return;

    (window as any).__onReveal = openFolder;
    (window as any).__onOpenFile = openFile;
  }, []);

  useEffect(() => {
    refreshAudioDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshAudioDevices);
    };
  }, []);

  const handleDeviceChange = async (deviceId: string) => {
    setSelectedAudioDevice(deviceId);
    try {
      await routeAudioDevice(deviceId, audioRef.current);
      await routeAudioDevice(deviceId, videoElementRef.current);
    } catch (e) {
      console.error("Audio routing failed", e);
    }
  };

  // Synchronous AudioContext Unlocker
  const unlockAudioContext = () => {
    if (!globalAudioState.ctx) {
      try { globalAudioState.ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch (e) { }
    }
    if (globalAudioState.ctx && globalAudioState.ctx.state === 'suspended') {
      globalAudioState.ctx.resume().catch(() => { });
    }
  };

  // Global Equalizer Preset State (Persisted)
  const [selectedEqPreset, setSelectedEqPreset] = useState<string>(() => {
    return localStorage.getItem("devizee_eq_preset") || "flat";
  });

  const handleEqPresetChange = (presetId: string) => {
    setSelectedEqPreset(presetId);
    applyEqualizerPreset(presetId);
  };


  // W3-9: Network status — tracks navigator.onLine for download UX
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  // Global Volume State (Persisted)
  const [volume, setVolume] = useState<number>(() => {
    const saved = localStorage.getItem("devizee_volume");
    return saved !== null ? parseFloat(saved) : 0.8;
  });
  const [isMuted, setIsMuted] = useState(false);

  // Clip-Before-Download (Trimming USP) State
  const [isTrimming, setIsTrimming] = useState(false);
  const [trimStart, setTrimStart] = useState("00:00");
  const [trimEnd, setTrimEnd] = useState("");

  // Card Download Live Status Tracker (Prevents Card Disappearing)
  const [activeCardTaskId, setActiveCardTaskId] = useState<string | null>(null);

  // Priority 3: Explicit Quality Selection State
  const [selectedFormat, setSelectedFormat] = useState<FormatOption | null>(null);

  // Audio Hub state (url/format now live inside AudioHubTab)
  const [activeAudioPlaying, setActiveAudioPlaying] = useState<DownloadRecord | null>(null);
  const [audioQueue, setAudioQueue] = useState<DownloadRecord[]>([]);
  const [audioQueuePos, setAudioQueuePos] = useState(0);
  const [audioShuffle, setAudioShuffle] = useState(false);
  const [audioRepeat, setAudioRepeat] = useState<"off" | "all" | "one">("off");

  const stopAudioPlayback = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
    setisAudioElementPlaying(false);
    setPreviewingId(null);
    setActiveAudioPlaying(null);
  }, []);

  // History, Queue Filtering & Sorting
  const [history, setHistory] = useState<DownloadRecord[]>([]);
  const [activitySearchQuery, setActivitySearchQuery] = useState("");
  const [queueFilter, setQueueFilter] = useState<"all" | "video" | "audio" | "active" | "queued" | "completed" | "attention">("all"); const [sortBy, setSortBy] = useState<"date_desc" | "date_asc" | "size_desc" | "size_asc" | "title" | "progress">("date_desc");
  const completedBatch = useRef<string[]>([]);
  const errorBatch = useRef<string[]>([]);
  const notificationTimer = useRef<any>(null);
  const userPausedTaskIds = useRef<Set<string>>(new Set());
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);

  // YouTube Keyword Search State
  const [searchResults, setSearchResults] = useState<PlaylistEntry[] | null>(null);
  const [isSearchingYoutube, setIsSearchingYoutube] = useState(false);

  const [activePlaylistBatch, setActivePlaylistBatch] = useState<{
    title: string;
    taskIds: string[];
    formatLabel: string;
  } | null>(null);

  // User Settings State
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem("devizee_settings");
    if (saved) {
      try { return JSON.parse(saved); } catch { }
    }
    return {
      // General
      language: "en",
      launchOnBoot: false,
      minimizeToTray: true,
      checkUpdates: "daily",
      theme: "dark",
      autoplay: false,
      // Downloads
      saveFolder: "Downloads/Devizee",
      videoFolder: "",
      audioFolder: "",
      documentsFolder: "",
      compressedFolder: "",
      programsFolder: "",
      tempFolder: "",
      autoOrganize: true,

      filenameTemplate: "%(title)s [%(id)s].%(ext)s",
      duplicateAction: "rename",
      defaultPreset: "best",
      oneClickDownload: false,
      maxParallel: 3,
      maxConnections: 8,
      // Connection & Speed
      speedLimit: "unlimited",
      customSpeedLimit: "2M",
      quietHoursSpeedLimit: false,
      proxyEnabled: false,
      proxyProtocol: "socks5",
      proxyHost: "127.0.0.1",
      proxyPort: "1080",
      proxyUser: "",
      proxyPass: "",
      connectionTimeout: 30,
      retryCount: 3,
      // Scheduler
      enableScheduler: false,
      scheduledTime: "02:00",
      quietHoursStart: "09:00",
      quietHoursEnd: "18:00",
      postDownloadAction: "nothing",
      // Security
      scanAntivirus: true,
      httpsWarnings: true,
      // Sounds & Notifications
      playSound: true,
      showNotifications: true,
      groupNotifications: true,
      // Helpers
      clipboardRadar: true,
      fake4kDetection: true,
      autoTagMusic: true,
      // Privacy & History
      historyLogging: true,
      autoClearDays: 30,
      // Advanced
      customFlags: "",
      logLevel: "info",
      downloadSubtitles: true,
      subtitleLanguages: "all",
    };
  });

  const [theme, setTheme] = useState<string>(() => settings.theme || localStorage.getItem("devizee_theme") || "dark");

  // Keep refs in sync with latest state / callbacks so the download-progress
  // listener can schedule retries without stale closures.
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const updateSetting = (key: string, val: any) => {
    setSettings((prev: any) => {
      const next = { ...prev, [key]: val };
      localStorage.setItem("devizee_settings", JSON.stringify(next));
      return next;
    });
  };

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    updateSetting("theme", newTheme);
  };

  // Immediate theme application (supports all 5 themes and sets data-theme attribute)
  useEffect(() => {
    localStorage.setItem("devizee_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
    // Light mode is the only non-dark theme; OLED, Sunset, and Frost are dark-variant themes
    document.documentElement.classList.toggle("dark", theme !== "light");
  }, [theme]);

  // Fullscreen change listener
  useEffect(() => {
    const onFsChange = () => {
      setVideoFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // W3-9: online/offline detection + notifications
  useEffect(() => {
    // SC-2: HUD does not need connectivity events.
    if (isHud) return;

    let wentOffline = false;

    const goOnline = () => {
      setIsOnline(true);
      if (wentOffline && settings.showNotifications) {
        sendNotification({
          title: "Devizee - Connection Restored",
          body: "Downloads are resuming automatically.",
        });
      }
      wentOffline = false;
    };
    const goOffline = () => {
      setIsOnline(false);
      wentOffline = true;
      if (settings.showNotifications) {
        sendNotification({
          title: "Devizee - No Internet Connection",
          body: "Active downloads are paused. They will resume automatically when the connection returns.",
        });
      }
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showNotifications]);

  // Single Consolidated Volume Controller
  const volumeDebounceTimer = useRef<any>(null);
  const handleVolumeChange = (newVol: number) => {
    const clamped = Math.max(0, Math.min(1, newVol));
    console.log("[Devizee Volume] change to", clamped, {
      hasAudioRef: !!audioRef.current,
      hasVideoRef: !!videoElementRef.current,
    });
    setVolume(clamped);
    setIsMuted(clamped === 0);
    if (audioRef.current) audioRef.current.volume = clamped;
    if (videoElementRef.current) videoElementRef.current.volume = clamped;
    sendIframeCommand("setVolume", [Math.round(clamped * 100)]);
    if (clamped === 0) {
      sendIframeCommand("mute");
    } else {
      sendIframeCommand("unMute");
    }
    if (volumeDebounceTimer.current) clearTimeout(volumeDebounceTimer.current);
    volumeDebounceTimer.current = setTimeout(() => {
      localStorage.setItem("devizee_volume", clamped.toString());
      updateSetting("volume", clamped);
    }, 250);
  };

  const toggleMute = () => {
    if (isMuted) {
      setIsMuted(false);
      const restore = volume > 0 ? volume : 0.8;
      if (audioRef.current) audioRef.current.volume = restore;
      if (videoElementRef.current) videoElementRef.current.volume = restore;
      sendIframeCommand("unMute");
      sendIframeCommand("setVolume", [Math.round(restore * 100)]);
    } else {
      setIsMuted(true);
      if (audioRef.current) audioRef.current.volume = 0;
      if (videoElementRef.current) videoElementRef.current.volume = 0;
      sendIframeCommand("mute");
    }
  };

  // Sync volume to audio/video elements and iframe on state change or mount
  useEffect(() => {
    const effective = isMuted ? 0 : volume;
    if (audioRef.current) audioRef.current.volume = effective;
    if (videoElementRef.current) videoElementRef.current.volume = effective;
    sendIframeCommand("setVolume", [Math.round(effective * 100)]);
    if (isMuted || effective === 0) {
      sendIframeCommand("mute");
    } else {
      sendIframeCommand("unMute");
    }
  }, [volume, isMuted, activeVideoPlaying]);

  // Unified Fullscreen Exit & Close Handlers
  const exitFullscreenAndKeepPlaying = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { });
    }
    setVideoFullscreen(false);
  };

  const handleCloseVideoPlayer = () => {
    exitFullscreenAndKeepPlaying();
    setActiveVideoPlaying(false);
    if (videoElementRef.current) videoElementRef.current.pause();
    sendIframeCommand("pauseVideo");
    transitionPlayback({ type: "none" });
  };

  // Load a track and start it. Used by queue navigation and library clicks.
  const playAudioItemNow = useCallback((item: DownloadRecord) => {
    if (!item.file_path || !audioRef.current) return;
    if (videoElementRef.current) videoElementRef.current.pause();
    sendIframeCommand("pauseVideo");
    setPreviewingId(null);
    setActiveAudioPlaying(item);
    transitionPlayback({ type: "audio", id: item.id, state: "playing" });
    audioRef.current.src = convertFileSrc(item.file_path);
    audioRef.current.volume = isMuted ? 0 : volume;
    audioRef.current.play()
      .then(() => setisAudioElementPlaying(true))
      .catch((err) => console.error("[AudioHub] Play failed:", err));
  }, [sendIframeCommand, transitionPlayback, isMuted, volume]);



  const audioNext = useCallback(() => {
    if (audioQueue.length === 0) return;
    const nextPos = audioQueuePos + 1;
    if (nextPos < audioQueue.length) {
      setAudioQueuePos(nextPos);
      playAudioItemNow(audioQueue[nextPos]);
    } else if (audioRepeat === "all") {
      setAudioQueuePos(0);
      playAudioItemNow(audioQueue[0]);
    }
  }, [audioQueue, audioQueuePos, audioRepeat, playAudioItemNow]);

  const audioPrev = useCallback(() => {
    if (audioQueue.length === 0 || !audioRef.current) return;
    if (audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    const prevPos = audioQueuePos - 1;
    if (prevPos >= 0) {
      setAudioQueuePos(prevPos);
      playAudioItemNow(audioQueue[prevPos]);
    } else if (audioRepeat === "all") {
      const lastPos = audioQueue.length - 1;
      setAudioQueuePos(lastPos);
      playAudioItemNow(audioQueue[lastPos]);
    }
  }, [audioQueue, audioQueuePos, audioRepeat, playAudioItemNow]);

  const toggleAudioShuffle = () => {
    setAudioShuffle((prev) => !prev);
  };

  const cycleAudioRepeat = () => {
    setAudioRepeat((prev) =>
      prev === "off" ? "all" : prev === "all" ? "one" : "off"
    );
  };

  // Global UI Zoom state with persistence
  const [zoomLevel, setZoomLevel] = useState<number>(() => {
    const saved = localStorage.getItem("devizee_zoom");
    return saved ? Math.min(140, Math.max(75, parseInt(saved, 10) || 100)) : 100;
  });

  useEffect(() => {
    (document.documentElement.style as any).zoom = "";
    document.documentElement.style.fontSize = `${(zoomLevel / 100) * 16}px`;
  }, [zoomLevel]);


  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      if (settings.showNotifications) {
        sendNotification({
          title: "Devizee - Connection Restored",
          body: "Downloads are resuming automatically.",
        });
      }
    };
    const goOffline = () => {
      setIsOnline(false);
      if (settings.showNotifications) {
        sendNotification({
          title: "Devizee - No Internet Connection",
          body: "Active downloads are paused. They will resume automatically when the connection returns.",
        });
      }
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [settings.showNotifications]);

  // Keyboard Shortcuts Handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Block Ctrl+R / Cmd+R and F5 to maintain native desktop application feel
      if (((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) || e.key === "F5") {
        e.preventDefault();
        return;
      }

      // Global IDE-style zoom shortcuts
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+" || e.key === "Add")) {
        e.preventDefault();
        setZoomLevel((prev) => {
          const next = Math.min(140, prev + 5);
          localStorage.setItem("devizee_zoom", String(next));
          return next;
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_" || e.key === "Subtract")) {
        e.preventDefault();
        setZoomLevel((prev) => {
          const next = Math.max(75, prev - 5);
          localStorage.setItem("devizee_zoom", String(next));
          return next;
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        setZoomLevel(100);
        localStorage.setItem("devizee_zoom", "100");
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||                                   // W3-6b
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return; // Do not intercept while typing or interacting with form controls
      }

      if (e.code === "Space") {
        if (nowPlaying.source === "multimedia") return;
        e.preventDefault();
        if (nowPlaying.type === "video" && videoElementRef.current) {
          if (videoElementRef.current.paused) videoElementRef.current.play();
          else videoElementRef.current.pause();
        } else if (nowPlaying.type === "audio" && audioRef.current) {
          if (isAudioElementPlaying) {
            audioRef.current.pause();
            setisAudioElementPlaying(false);
          } else {
            audioRef.current.play().then(() => setisAudioElementPlaying(true)).catch(() => { });
          }
        }
      } else if (e.code === "ArrowLeft") {
        if (nowPlaying.source === "multimedia") return;
        e.preventDefault();
        const delta = (e.shiftKey || e.ctrlKey) ? 60 : 10;
        if (nowPlaying.type === "video" && videoElementRef.current) {
          videoElementRef.current.currentTime = Math.max(0, videoElementRef.current.currentTime - delta);
        } else if (nowPlaying.type === "video") {
          sendIframeCommand("seekRelative", [-delta]);
        } else if (nowPlaying.type === "audio" && audioRef.current) {
          handleSeekRelative(-delta);
        }
      } else if (e.code === "ArrowRight") {
        if (nowPlaying.source === "multimedia") return;
        e.preventDefault();
        const delta = (e.shiftKey || e.ctrlKey) ? 60 : 10;
        if (nowPlaying.type === "video" && videoElementRef.current) {
          videoElementRef.current.currentTime = Math.min(
            videoElementRef.current.duration || 86400,
            videoElementRef.current.currentTime + delta
          );
        } else if (nowPlaying.type === "video") {
          sendIframeCommand("seekRelative", [delta]);
        } else if (nowPlaying.type === "audio" && audioRef.current) {
          handleSeekRelative(delta);
        }
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        handleVolumeChange(Math.min(1, volume + 0.05));
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        handleVolumeChange(Math.max(0, volume - 0.05));
      } else if (e.code === "Escape") {
        if (document.fullscreenElement) {
          e.preventDefault();
          exitFullscreenAndKeepPlaying();
        }
      } else if (e.code === "KeyM") {
        e.preventDefault();
        toggleMute();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nowPlaying, isAudioElementPlaying, volume, isMuted]);

  // Block default browser contextmenu across desktop app except inside text inputs (Image 5 fix)
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName !== "INPUT" && target?.tagName !== "TEXTAREA" && !target?.isContentEditable) {
        e.preventDefault();
      }
    };
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // Browse Folder via plugin-dialog
  const handleBrowseFolder = async (key: "saveFolder" | "videoFolder" | "audioFolder" | "documentsFolder" | "generalFolder" | "compressedFolder" | "programsFolder" | "tempFolder") => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: (settings as any)[key] || settings.saveFolder,
      });
      if (selected && typeof selected === "string") {
        updateSetting(key, selected);
      }
    } catch (err) {
      console.error(`Browse ${key} error:`, err);
    }
  };

  // Web Audio API Synthesized Completion Chime
  const playCompletionChime = () => {
    if (!settings.playSound || isMuted || volume === 0) return;
    try {
      if (!globalAudioState.ctx) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;
        globalAudioState.ctx = new AudioCtx();
      }
      const ctx = globalAudioState.ctx;
      if (ctx.state === "suspended") ctx.resume().catch(() => { });
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + idx * 0.12);
        gain.gain.setValueAtTime(0.22 * volume, now + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.12);
        osc.stop(now + idx * 0.12 + 0.4);
      });
    } catch (e) {
      console.error("Failed to play chime", e);
    }
  };

  // Translation helper
  const t = createTranslator(settings.language);

  // Autostart toggle handler
  const handleToggleAutostart = async (enable: boolean) => {
    updateSetting("launchOnBoot", enable);
    try {
      await invoke("set_autostart", { enable });
    } catch (err) {
      console.error("Autostart setting error:", err);
    }
  };

  const openFolder = async (path?: string | null) => {
    try {
      const resolved = await invoke<string>("resolve_folder_path", {
        path: path || null,
        baseDir: settings.saveFolder,
      });

      // If a specific file was requested, reveal it in its parent folder.
      // Otherwise open the resolved directory itself.
      if (path) {
        try {
          await revealItemInDir(resolved);
          return;
        } catch {
          // fall through to openPath
        }
      }
      await openPath(resolved);
    } catch (e) {
      console.error("openFolder failed:", e);
    }
  };
  // Open file handler (launches default player directly)
  const openFile = async (path?: string | null) => {
    if (!path) return;
    try {
      await invoke("open_file", { path });
    } catch (e) {
      console.error("Failed to open file", e);
    }
  };

  // Clipboard Radar Logic
  const lastClipboard = useRef<string>("");

  useEffect(() => {
    // HUD window listens for its own data inside ClipboardHud.
    // This effect only runs in the main app window.
    if (isHud) return;
    if (!settings.clipboardRadar) return;

    // F-31: pause polling when the window is hidden/minimized.
    // Uses the visibility API instead of a native clipboard-change hook —
    // Tauri v2's clipboard-manager doesn't expose change events on all
    // platforms, so we keep polling but stop it when nobody's watching.
    let interval: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const text = await readText();
        if (
          text &&
          text !== lastClipboard.current &&
          (text.includes("youtube.com") || text.includes("youtu.be"))
        ) {
          lastClipboard.current = text;
          const info: VideoInfo = await invoke("fetch_video_info", { url: text });
          let hudWin = await WebviewWindow.getByLabel("hud");
          if (!hudWin) {
            hudWin = new WebviewWindow("hud", {
              url: "/?hud=true",
              width: 350,
              height: 120,
              transparent: true,
              decorations: false,
              alwaysOnTop: true,
              resizable: false,
              focus: false,
            });
          }
          hudWin.emit("hud-data", { info, url: text });
          hudWin.show();
          setTimeout(() => {
            hudWin?.hide();
          }, 8000);
        }
      } catch { }
    };

    const startPolling = () => {
      if (interval) return;
      interval = setInterval(tick, 1500);
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) stopPolling();
      else startPolling();
    };

    if (!document.hidden) startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isHud, settings.clipboardRadar]);

  const flushNotifications = async () => {
    if (!settings.showNotifications) return;
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === "granted";
    }
    if (!granted) return;

    const comps = completedBatch.current.length;
    const errs = errorBatch.current.length;

    if (comps > 0) {
      sendNotification({
        title: "Devizee",
        body: comps === 1 ? "1 download completed successfully." : `${comps} downloads completed successfully.`,
      });
      playCompletionChime();
    }
    if (errs > 0) {
      sendNotification({
        title: "Devizee Error",
        body: errs === 1 ? "1 download failed." : `${errs} downloads failed. View queue for details.`,
      });
    }

    completedBatch.current = [];
    errorBatch.current = [];
  };

  const loadHistory = async () => {
    try {
      const recs: DownloadRecord[] = await invoke("get_history");
      setHistory(recs);
      if (playSource === "downloadedLibrary") {
        setAudioQueue((prev) => {
          if (prev.length === 0) return prev;
          const map = new Map(recs.map((r) => [r.id, r]));
          return prev.map((item) => map.get(item.id) || item);
        });
      }
    } catch (e) {
      console.error("Failed to load history", e);
    }
  };

  // Single-Instance Native Messaging Relay Listener (F-01: race-safe cleanup)
  useEffect(() => {
    // SC-2: HUD does not handle URLs — the main window does.
    if (isHud) return;

    let disposed = false;
    let unlistenFn: (() => void) | null = null;

    listen<string>("open-url", (event) => {
      if (event.payload) {
        setUrl(event.payload);
        setActiveTab("downloads");
        analyzeUrl(event.payload);
      }
    }).then((f) => {
      if (disposed) f();
      else unlistenFn = f;
    });

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // SC-1: Sleep/wake listener (F-01: race-safe cleanup)
  useEffect(() => {
    // SC-2: HUD does not need to know about system wake events.
    if (isHud) return;

    let disposed = false;
    let unlistenFn: (() => void) | null = null;

    listen("system-woke-from-sleep", () => {
      if (settings.showNotifications) {
        sendNotification({
          title: "Devizee - Downloads Paused After Sleep",
          body: "Your system woke from sleep. Interrupted downloads can be resumed from the Downloads tab.",
        });
      }
      loadHistory();
    }).then((f) => {
      if (disposed) f();
      else unlistenFn = f;
    });

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showNotifications]);

  // SC-3: sidecar fingerprint verification. On first run, we save the
  // current hashes as the baseline. On subsequent runs, if the hashes
  // differ we notify the user — they may have legitimately updated
  // yt-dlp, or the binary may have been tampered with.
  useEffect(() => {
    if (isHud) return;

    let disposed = false;
    let unlistenFn: (() => void) | null = null;

    listen<{ yt_dlp: string | null; ffmpeg: string | null }>(
      "sidecar-fingerprint",
      (event) => {
        const { yt_dlp, ffmpeg } = event.payload;
        const STORAGE_KEY = "devizee_sidecar_hashes_v1";

        try {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (!stored) {
            // First run: establish the baseline silently
            localStorage.setItem(
              STORAGE_KEY,
              JSON.stringify({ yt_dlp, ffmpeg })
            );
            console.log("[SC-3] Sidecar baseline established");
            return;
          }

          const baseline = JSON.parse(stored) as {
            yt_dlp: string | null;
            ffmpeg: string | null;
          };

          const ytChanged =
            baseline.yt_dlp && yt_dlp && baseline.yt_dlp !== yt_dlp;
          const ffChanged =
            baseline.ffmpeg && ffmpeg && baseline.ffmpeg !== ffmpeg;

          if (ytChanged || ffChanged) {
            const changed: string[] = [];
            if (ytChanged) changed.push("yt-dlp");
            if (ffChanged) changed.push("ffmpeg");

            console.warn(
              "[SC-3] Sidecar binary fingerprint changed:",
              changed.join(", ")
            );

            if (settings.showNotifications) {
              sendNotification({
                title: "Devizee - Download Engine Changed",
                body: `The ${changed.length === 2 ? "yt-dlp and ffmpeg binaries" : changed[0] + " binary"
                  } changed since last launch. If you didn't update them yourself, this may indicate tampering.`,
              });
            }

            // Update baseline to the new value (accept the change)
            localStorage.setItem(
              STORAGE_KEY,
              JSON.stringify({ yt_dlp, ffmpeg })
            );
          }
        } catch (e) {
          console.warn("[SC-3] Fingerprint check failed:", e);
        }
      }
    ).then((f) => {
      if (disposed) f();
      else unlistenFn = f;
    });

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showNotifications]);

  // Window close interceptor: hide to tray if minimizeToTray is enabled;
  // otherwise, prompt if downloads are running before exiting cleanly.
  const requestAppClose = useCallback(async () => {
    if (settings.minimizeToTray) {
      try {
        await getCurrentWindow().hide();
      } catch (err) {
        console.error("Failed to hide to tray:", err);
      }
      return;
    }

    const currentActive = historyRef.current.filter(
      (h) => h.status === "downloading" || h.status === "muxing" || h.status === "starting"
    ).length;

    if (currentActive > 0 && settings.warnOnCloseActiveDownloads !== false) {
      setIsCloseConfirmOpen(true);
      return;
    }

    try {
      await invoke("exit_app");
    } catch {
      try {
        await getCurrentWindow().close();
      } catch { }
    }
  }, [settings.minimizeToTray, settings.warnOnCloseActiveDownloads]);

  const handleConfirmCloseApp = async (dontWarnAgain: boolean) => {
    setIsCloseConfirmOpen(false);
    if (dontWarnAgain) {
      updateSetting("warnOnCloseActiveDownloads", false);
    }
    try {
      await invoke("exit_app");
    } catch {
      try {
        await getCurrentWindow().close();
      } catch { }
    }
  };

  const handleCancelCloseApp = () => {
    setIsCloseConfirmOpen(false);
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const appWindow = getCurrentWindow();
    appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        await requestAppClose();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to register onCloseRequested handler:", err);
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, [requestAppClose]);

  // Listen to YouTube iframe state changes so nowPlaying and audio exclusivity reflect reality.


  // Video playback time tracking ticker
  useEffect(() => {
    if (!activeVideoPlaying || nowPlaying.type !== "video" || nowPlaying.state !== "playing") return;
    const interval = setInterval(() => {
      if (videoElementRef.current) {
        setPreviewTime(videoElementRef.current.currentTime);
        if (videoElementRef.current.duration) {
          setPreviewDuration(videoElementRef.current.duration);
        }
      }
      // Removed the 'else' block that artificially increments previewTime for iframes.
      // We now strictly rely on YouTube's 'infoDelivery' messages to update previewTime.
    }, 500);
    return () => clearInterval(interval);
  }, [activeVideoPlaying, nowPlaying]);

  // F-02: On iframe focus, stop audio but DO NOT assert video is playing.
  // The YouTube postMessage listener will fire `infoDelivery` with
  // playerState=1 once the video actually begins — that's what drives
  // transitionPlayback. Assuming playback on focus-blur caused spurious
  // "playing" states when the user just clicked into the iframe chrome.
  useEffect(() => {
    const handleWindowBlur = () => {
      if (document.activeElement === iframeRef.current) {
        stopAudioPlayback();
      }
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [stopAudioPlayback]);


  useEffect(() => {
    // SC-2: HUD window must not poll history or subscribe to progress events.
    // The main window owns that responsibility exclusively.
    if (isHud) return;

    loadHistory();

    let disposed = false;
    let unlistenFn: (() => void) | null = null;

    // W3-5: fire-and-forget orphan cleanup on startup. Backend removes
    // any *.part / *.ytdl files older than 48 hours under the current
    // download root. Silent on success; logs to stdout if anything was
    // cleaned. Errors here are non-fatal — cleanup is best-effort.
    (async () => {
      try {
        const root = settings.saveFolder || "Downloads/Devizee";
        const removed = await invoke<number>("cleanup_orphan_parts", { root });
        if (removed > 0) {
          console.log(`[Devizee] Startup cleanup removed ${removed} orphan file(s)`);
        }
      } catch (err) {
        console.warn("[Devizee] Orphan cleanup skipped:", err);
      }
    })();

    listen<any>("download-progress", (event) => {
      const p = event.payload;

      // ─── F-A1: Silent auto-retry for transient errors ───
      // If the failure is transient (network/unavailable) and we still have
      // retry budget, schedule a background retry and swallow the error UI.
      if (
        p.status === "error" &&
        p.error_code &&
        TRANSIENT_ERROR_CODES.has(p.error_code)
      ) {
        const attempts = retryAttemptsRef.current.get(p.task_id) || 0;
        if (attempts < AUTO_RETRY_MAX) {
          retryAttemptsRef.current.set(p.task_id, attempts + 1);
          // F-13b: exponential backoff — 2s, 4s (2 * 2^attempt)
          const backoffMs = AUTO_RETRY_DELAY_MS * Math.pow(2, attempts);
          console.log(
            `[Auto-Retry] Scheduling attempt ${attempts + 1}/${AUTO_RETRY_MAX} for ${p.task_id} in ${backoffMs}ms`
          );
          setTimeout(() => {
            const rec = historyRef.current.find((h) => h.id === p.task_id);
            if (rec && handleRetryDownloadRef.current) {
              console.log(`[Auto-Retry] Firing retry for ${p.task_id}`);
              handleRetryDownloadRef.current(rec);
            }
          }, backoffMs);
          // Do NOT update state, do NOT push to errorBatch, do NOT notify.
          // The record stays as "downloading" until the retry flips it back
          // through Queued → Starting → Downloading.
          return;
        }
        console.log(
          `[Auto-Retry] Retries exhausted for ${p.task_id} — surfacing error`
        );
        // Fall through to normal error handling below
      }

      setHistory((prev) => {
        const idx = prev.findIndex((r) => r.id === p.task_id);
        const oldStatus = idx !== -1 ? prev[idx].status : null;

        if (p.status === "completed" && oldStatus !== "completed") {
          // Clear any retry counter for this task — it succeeded
          retryAttemptsRef.current.delete(p.task_id);
          if (!completedBatch.current.includes(p.task_id)) {
            completedBatch.current.push(p.task_id);
          }
          clearTimeout(notificationTimer.current);
          notificationTimer.current = setTimeout(flushNotifications, 1800);
        } else if (p.status === "error" && oldStatus !== "error") {
          if (!errorBatch.current.includes(p.task_id)) {
            errorBatch.current.push(p.task_id);
          }
          clearTimeout(notificationTimer.current);
          notificationTimer.current = setTimeout(flushNotifications, 1800);
        } else if (p.status === "interrupted" && oldStatus !== "interrupted") {
          const wasUserPaused = userPausedTaskIds.current.has(p.task_id);
          if (wasUserPaused) {
            userPausedTaskIds.current.delete(p.task_id);
          } else if (settings.showNotifications) {
            sendNotification({
              title: "Devizee - Download Interrupted",
              body: "A download was interrupted. Open the Downloads tab to resume, restart, or cancel it.",
            });
          }
        }

        if (idx === -1) {
          loadHistory();
          return prev;
        }

        const newHistory = [...prev];
        const prevPercent = newHistory[idx].percent || 0;
        const incoming = p.percent || 0;

        // ─── F-XX: Monotonic progress clamp for multi-stream downloads ───
        // HD downloads use DASH (separate video + audio streams). Each
        // stream emits 0% → 100% individually, so the raw stream percent
        // resets between streams. We clamp the displayed percent to never
        // regress while downloading, capped at 99% so the bar only hits
        // 100% when the file is truly finalized.
        let displayedPercent: number;
        if (p.status === "completed") {
          displayedPercent = 100;
        } else if (p.status === "downloading") {
          displayedPercent = Math.min(99, Math.max(prevPercent, incoming));
        } else if (p.status === "muxing" || p.status === "verifying") {
          // Hold the bar at the last high value during finalize/verify
          displayedPercent = Math.min(99.5, Math.max(prevPercent, incoming));
        } else {
          // error / cancelled / interrupted — hold at last value
          displayedPercent = prevPercent;
        }

        newHistory[idx] = {
          ...newHistory[idx],
          status: p.status,
          percent: displayedPercent,
          speed: p.speed,
          eta: p.eta,
          file_path: p.file_path || newHistory[idx].file_path,
          error_code: p.error_code || newHistory[idx].error_code,
          error_message: p.error || newHistory[idx].error_message,
        };
        return newHistory;
      });
    }).then((f) => {
      if (disposed) f();
      else unlistenFn = f;
    });

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);


  // In-App Video Playback Trigger (Plays video on thumbnail click)
  const handlePlayVideo = async (
    targetVideo: { id: string; url: string; title: string; thumbnail: string; duration_string: string },
    forceRefresh = false
  ) => {
    unlockAudioContext();
    // D7: only flip to livePlaylist if we're not already in downloadedLibrary
    // mode with an active queue. Otherwise the state machine gets confused
    // about which queue completion events should refresh.
    setPlaySource((prev) => (prev === "downloadedLibrary" ? prev : "livePlaylist"));
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setisAudioElementPlaying(false);
    setPreviewingId(null);
    setActiveAudioPlaying(null);
    transitionPlayback({ type: "video", id: targetVideo.id, state: "playing" });

    // If selecting a video from playlist, promote to active main card
    if (!videoInfo || videoInfo.id !== targetVideo.id) {
      setSelectedFormat(null);
      setVideoInfo({
        id: targetVideo.id,
        title: targetVideo.title,
        url: targetVideo.url,
        thumbnail: targetVideo.thumbnail,
        duration: null,
        duration_string: targetVideo.duration_string,
        uploader: "",
        video_formats: [],
        audio_formats: [],
        formats: [],
      });
      // Fetch full formats in background
      invoke<VideoInfo>("fetch_video_info", { url: targetVideo.url })
        .then(info => setVideoInfo(info))
        .catch(err => console.error(err));
    }
    setShowPreviews(true);

    // Smooth scroll to top of workspace
    mainScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });

    setActiveVideoPlaying(true);

    // Fast-Path for YouTube: Instant player activation without 4-7s yt-dlp latency
    const isYouTube = /youtu(\.be|be\.com)/i.test(targetVideo.url) || /^[a-zA-Z0-9_-]{11}$/.test(targetVideo.id);
    if (isYouTube) {
      setVideoStreamUrl(null);
      setIsVideoLoading(false);
      return;
    }

    setIsVideoLoading(true);

    if (forceRefresh) {
      videoStreamCache.current.delete(targetVideo.id);
    }

    // If stream URL is already cached, start immediate playback
    if (!forceRefresh && videoStreamCache.current.has(targetVideo.id)) {
      setVideoStreamUrl(videoStreamCache.current.get(targetVideo.id)!);
      setIsVideoLoading(false);
      return;
    }

    try {
      const streamUrl = await invoke<string>("get_video_stream_url", { url: targetVideo.url });
      if (videoStreamCache.current.size >= 20) {
        const firstKey = videoStreamCache.current.keys().next().value;
        if (firstKey) videoStreamCache.current.delete(firstKey);
      }
      videoStreamCache.current.set(targetVideo.id, streamUrl);
      setVideoStreamUrl(streamUrl);
    } catch (err) {
      console.error("Video stream extraction fallback:", err);
      setVideoStreamUrl(null);
    } finally {
      setIsVideoLoading(false);
    }
  };

  const toggleFullscreen = () => {
    if (!videoContainerRef.current) return;
    if (!document.fullscreenElement) {
      videoContainerRef.current.requestFullscreen().catch(() => { });
    } else {
      document.exitFullscreen().catch(() => { });
    }
  };

function detectAudioMime(arr: Uint8Array): string {
  if (arr.length >= 4) {
    if (arr[0] === 0x1a && arr[1] === 0x45 && arr[2] === 0xdf && arr[3] === 0xa3) {
      return "audio/webm";
    }
    if (arr[0] === 0x49 && arr[1] === 0x44 && arr[2] === 0x33) {
      return "audio/mpeg";
    }
    if (arr[0] === 0xff && (arr[1] & 0xe0) === 0xe0) {
      return "audio/mpeg";
    }
    if (arr[0] === 0x4f && arr[1] === 0x67 && arr[2] === 0x67 && arr[3] === 0x53) {
      return "audio/ogg";
    }
    if (arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46) {
      return "audio/wav";
    }
    if (arr[0] === 0x66 && arr[1] === 0x4c && arr[2] === 0x61 && arr[3] === 0x43) {
      return "audio/flac";
    }
  }
  if (arr.length >= 8 && arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70) {
    return "audio/mp4";
  }
  return "audio/mp4";
}

  // Audio preview playback handlers with instantaneous cache & seeking
  const toggleAudioPreview = async (targetUrl: string, songId: string, forceRefresh = false) => {
    unlockAudioContext();
    if (!audioRef.current) return;

    // FIX: yt-dlp defaults to extracting the whole playlist if the URL contains playlist parameters
    // Strip them so we strictly preview the individual song
    let cleanUrl = targetUrl;
    try {
      const parsed = new URL(targetUrl);
      parsed.searchParams.delete('list');
      parsed.searchParams.delete('index');
      cleanUrl = parsed.toString();
    } catch (e) { }

    // 1. Pause Video Element & Iframe (but keep it mounted so position is preserved)
    if (videoElementRef.current) videoElementRef.current.pause();
    sendIframeCommand("pauseVideo");
    // Do NOT call setActiveVideoPlaying(false) — that unmounts the video element and loses position.

    if (forceRefresh) {
      if (audioStreamCache.current.has(songId)) {
        const oldUrl = audioStreamCache.current.get(songId);
        if (oldUrl && oldUrl.startsWith("blob:")) {
          try { URL.revokeObjectURL(oldUrl); } catch (_) {}
        }
        audioStreamCache.current.delete(songId);
      }
    } else if (previewingId === songId) {
      if (isAudioElementPlaying) {
        audioRef.current.pause();
        setisAudioElementPlaying(false);
        transitionPlayback({ type: "none" });
      } else {
        audioRef.current.play().then(() => {
          setisAudioElementPlaying(true);
          transitionPlayback({ type: "audio", id: songId, state: "playing" });
        }).catch(() => { });
      }
      return;
    }

    audioRef.current.pause();
    setActiveAudioPlaying(null); // Fix: Clear Audio Hub state
    setPlaySource(playlistInfo ? "livePlaylist" : "none");
    setPreviewingId(songId);
    setisAudioElementPlaying(false);
    setPreviewTime(0);
    transitionPlayback({ type: "audio", id: songId, state: "playing" });

    // Apply persisted volume
    audioRef.current.volume = isMuted ? 0 : volume;
    // Ensure the shared EQ chain is attached before playback begins
    attachEqualizerToMedia(audioRef.current);

    // Instant Playback from cache if already resolved
    if (!forceRefresh && audioStreamCache.current.has(songId)) {
      const cachedUrl = audioStreamCache.current.get(songId)!;
      audioRef.current.src = cachedUrl;
      audioRef.current.play()
        .then(() => {
          setisAudioElementPlaying(true);
          setIsLoadingAudioId(null);
        })
        .catch((err) => {
          console.error("Playback error:", err);
          setIsLoadingAudioId(null);
        });
      return;
    }

    setIsLoadingAudioId(songId);

    try {
      const bytes: number[] = await invoke("fetch_audio_bytes", { url: cleanUrl });
      // Guard: if backend returned a tiny payload, it's almost certainly an HTTP
      // error page (403, 404, etc.) wrapped as bytes, not real audio.
      if (!bytes || bytes.length < 4096) {
        throw new Error(
          `Audio fetch returned ${bytes?.length ?? 0} bytes — likely an HTTP error, not real audio.`
        );
      }
      const u8 = new Uint8Array(bytes);
      const mime = detectAudioMime(u8);
      const blob = new Blob([u8], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      cacheAudioBlobUrl(songId, blobUrl);
      if (audioRef.current) {
        audioRef.current.src = blobUrl;
        audioRef.current.load();
        await audioRef.current.play();
        setisAudioElementPlaying(true);
      }
    } catch (err) {
      console.error("Audio stream error:", err);
      setPreviewingId(null);
      transitionPlayback({ type: "none" });
    } finally {
      setIsLoadingAudioId(null);
    }
  };

  const handleAudioTimeUpdate = () => {
    if (audioRef.current) {
      setPreviewTime(audioRef.current.currentTime);
      setPreviewDuration(audioRef.current.duration || 0);
    }
  };

  const handleAudioEnded = () => {
    setisAudioElementPlaying(false);
    setPreviewTime(0);

    // Preview (no queue) — just stop
    if (audioQueue.length === 0) {
      transitionPlayback({ type: "none" });
      setActiveAudioPlaying(null);
      return;
    }

    // Repeat one — replay current
    if (audioRepeat === "one" && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play()
        .then(() => setisAudioElementPlaying(true))
        .catch(() => { });
      return;
    }

    // Advance to next
    const nextPos = audioQueuePos + 1;
    if (nextPos < audioQueue.length) {
      setAudioQueuePos(nextPos);
      playAudioItemNow(audioQueue[nextPos]);
      return;
    }

    // Wrap if repeat all
    if (audioRepeat === "all" && audioQueue.length > 0) {
      setAudioQueuePos(0);
      playAudioItemNow(audioQueue[0]);
      return;
    }

    transitionPlayback({ type: "none" });
    setActiveAudioPlaying(null);
  };

  // Called when the in-app <video> element finishes playback.
  // If autoplay is on and we're inside a playlist, advance to the next
  // selected entry. Otherwise clear state.
  const handleVideoEnded = useCallback(() => {
    if (audioRepeat === "one") {
      if (videoElementRef.current) {
        videoElementRef.current.currentTime = 0;
        videoElementRef.current.play().catch(() => { });
        if (videoInfo) transitionPlayback({ type: "video", id: videoInfo.id, state: "playing" });
      } else {
        sendIframeCommand("seekTo", [0, true]);
        sendIframeCommand("playVideo");
        if (videoInfo) transitionPlayback({ type: "video", id: videoInfo.id, state: "playing" });
      }
      return;
    }

    if (!settings.autoplay) {
      setActiveVideoPlaying(false);
      transitionPlayback({ type: "none" });
      return;
    }

    if (playlistInfo && videoInfo) {
      const entries = playlistInfo.entries;
      const currentIdx = entries.findIndex((e) => e.id === videoInfo.id);
      if (currentIdx >= 0) {
        for (let i = currentIdx + 1; i < entries.length; i++) {
          if (selectedPlaylistItems.has(entries[i].id)) {
            handlePlayVideo(entries[i]);
            return;
          }
        }
        if (audioRepeat === "all" && entries.length > 0) {
          for (let i = 0; i <= currentIdx; i++) {
            if (selectedPlaylistItems.has(entries[i].id)) {
              handlePlayVideo(entries[i]);
              return;
            }
          }
        }
      }
    }

    setActiveVideoPlaying(false);
    transitionPlayback({ type: "none" });
  }, [settings.autoplay, playlistInfo, videoInfo, selectedPlaylistItems, handlePlayVideo, transitionPlayback, audioRepeat, sendIframeCommand]);

  const handleSeek = (seconds: number) => {
    if (audioRef.current && isAudioElementPlaying) {
      audioRef.current.currentTime = seconds;
      setPreviewTime(seconds);
    } else if (activeVideoPlaying) {
      if (videoElementRef.current) {
        videoElementRef.current.currentTime = seconds;
      } else {
        sendIframeCommand("seekTo", [seconds, true]);
      }
      setPreviewTime(seconds);
    }
  };

  function handleSeekRelative(delta: number) {
    if (audioRef.current && isAudioElementPlaying) {
      const total = audioRef.current.duration || 0;
      const nextTime = Math.max(0, Math.min(total, audioRef.current.currentTime + delta));
      audioRef.current.currentTime = nextTime;
      setPreviewTime(nextTime);
    } else if (activeVideoPlaying) {
      const total = videoInfo?.duration || previewDuration || 86400;
      const cur = videoElementRef.current ? videoElementRef.current.currentTime : previewTime;
      const nextTime = Math.max(0, Math.min(total, cur + delta));
      if (videoElementRef.current) {
        videoElementRef.current.currentTime = nextTime;
      } else {
        sendIframeCommand("seekTo", [nextTime, true]);
      }
      setPreviewTime(nextTime);
    }
  }

  const formatSeconds = (secs: number) => {
    // W3-6: Guard against NaN/Infinity from live streams or broken durations.
    // Prevents "NaN:NaN" from rendering in the UI.
    if (!Number.isFinite(secs) || secs < 0) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  // Adjust trim input via Arrow keys / Mouse Wheel (Step 5)
  const adjustTrimTimestamp = (currentVal: string, setter: (v: string) => void, delta: number) => {
    const totalMax = videoInfo?.duration ? videoInfo.duration : 86400;
    const currentSecs = parseTimeToSeconds(currentVal);
    const nextSecs = Math.max(0, Math.min(totalMax, currentSecs + delta));
    setter(formatSecondsToTime(nextSecs, totalMax >= 3600));
  };

  // URL Analysis Logic - Robust for single videos, YouTube mixes, playlists, and keyword search
  async function analyzeUrl(rawInput: string) {
    const clean = rawInput.trim();
    if (!clean) return;

    // Check if input is a direct URL or a keyword search for YouTube
    const isUrl = /^https?:\/\//i.test(clean) ||
      clean.startsWith("www.") ||
      clean.includes("youtube.com/") ||
      clean.includes("youtu.be/") ||
      clean.includes("soundcloud.com/") ||
      clean.includes("vimeo.com/");

    if (!isUrl) {
      // Direct YouTube Search via ytsearch5:
      setFetchError("");
      setSelectedFormat(null);
      setVideoInfo(null);
      setPlaylistInfo(null);
      setSearchResults(null);
      setIsSearchingYoutube(true);
      setIsFetching(true);
      try {
        const results = await invoke<PlaylistEntry[]>("search_youtube", { query: clean });
        setSearchResults(results);
        if (!results || results.length === 0) {
          setFetchError(`No YouTube results found for "${clean}".`);
        }
      } catch (err: any) {
        setFetchError(`YouTube search error: ${err.toString()}`);
      } finally {
        setIsSearchingYoutube(false);
        setIsFetching(false);
      }
      return;
    }

    setSearchResults(null);
    setFetchError("");
    setSelectedFormat(null);
    setVideoInfo(null);
    setPlaylistInfo(null);
    setSelectedPlaylistItems(new Set());
    setActiveCardTaskId(null);
    setActiveVideoPlaying(false);
    setVideoStreamUrl(null);
    setIsVideoLoading(false);
    setIsFetching(true);

    const listMatch = clean.match(/[?&]list=([^&]+)/);
    const listId = listMatch ? listMatch[1] : null;

    const videoMatch = clean.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
    const videoId = videoMatch ? videoMatch[1] : null;

    // Optimistic Instant UI for YouTube
    if (videoId) {
      setVideoInfo({
        id: videoId,
        title: "Resolving video information...",
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration: null,
        duration_string: "--:--",
        uploader: "Connecting to server...",
        video_formats: [],
        audio_formats: [],
        formats: [],
      });
    }

    try {
      if (listId) {
        setIsLoadingPlaylist(true);
        // If it's already a watch URL or a mix (RD...), pass clean; otherwise pass canonical playlist URL
        const plUrl = clean.includes("watch?") || listId.startsWith("RD")
          ? clean
          : `https://www.youtube.com/playlist?list=${listId}`;

        const plPromise = invoke<PlaylistInfo>("fetch_playlist_info", { url: plUrl })
          .then((plInfo) => {
            setPlaylistInfo(plInfo);
            setShowPlaylistSection(true);
            // Default select only the active song, not the whole playlist
            if (videoId) {
              setSelectedPlaylistItems(new Set([videoId]));
            } else if (plInfo.entries.length > 0) {
              setSelectedPlaylistItems(new Set([plInfo.entries[0].id]));
            }
          })
          .catch((plErr) => {
            console.error("Playlist error:", plErr);
          })
          .finally(() => {
            setIsLoadingPlaylist(false);
          });

        if (videoId) {
          const videoClean = `https://www.youtube.com/watch?v=${videoId}`;
          const info = await invoke<VideoInfo>("fetch_video_info", { url: videoClean });
          setVideoInfo(info);
          if (info.duration_string && info.duration_string !== "--:--") {
            setTrimEnd(info.duration_string);
          }
        }
        await plPromise;
      } else if (videoId) {
        const info = await invoke<VideoInfo>("fetch_video_info", { url: clean });
        setVideoInfo(info);
        if (info.duration_string && info.duration_string !== "--:--") {
          setTrimEnd(info.duration_string);
        }
      } else {
        const info = await invoke<VideoInfo>("fetch_video_info", { url: clean });
        setVideoInfo(info);
        if (info.duration_string && info.duration_string !== "--:--") {
          setTrimEnd(info.duration_string);
        }
      }
    } catch (err: any) {
      setFetchError(err.toString());
    } finally {
      setIsFetching(false);
    }
  }

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    await analyzeUrl(url);
  };

  const handleImportTxtLines = async (lines: string[]) => {
    if (lines.length === 0) return;

    // ─── Bug A: Deduplicate against existing queue and within the import ───
    // Playlists and "RD…" mixes often contain the same video multiple times.
    // Users may also re-import the same .txt. We canonicalize URLs and drop
    // any that already exist in the batch queue.
    const normalizeUrl = (u: string): string => {
      try {
        const parsed = new URL(u);
        // Canonicalize YouTube watch URLs (strip list/index/start_radio/t)
        const v = parsed.searchParams.get("v");
        if (v) return `https://www.youtube.com/watch?v=${v}`;
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return u.trim();
      }
    };

    const existingUrls = new Set(
      batchQueueItems.map((b) => normalizeUrl(b.url))
    );

    const seenInImport = new Set<string>();
    const uniqueLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const norm = normalizeUrl(trimmed);
      if (existingUrls.has(norm)) continue;
      if (seenInImport.has(norm)) continue;
      seenInImport.add(norm);
      uniqueLines.push(trimmed);
    }

    if (uniqueLines.length === 0) {
      // Everything was already queued. Nothing to add.
      setActiveTab("dashboard");
      return;
    }

    const defaultFmt: FormatOption = {
      format_id: "bestvideo[height<=1080]+bestaudio/best",
      label: "1080p (Full HD)",
      ext: "mp4",
      is_audio_only: false,
      resolution: null,
      filesize_approx: null,
    };

    const newItems: BatchItem[] = uniqueLines.map((line, idx) => {
      let hostname = "Web";
      try {
        hostname = new URL(line).hostname.replace(/^www\./, "");
      } catch { }

      return {
        id: `batch-${Date.now()}-${idx}`,
        url: line,
        title: line,
        thumbnail: "",
        site: hostname,
        format: defaultFmt,
        metadataError: false,
      };
    });

    setBatchQueueItems((prev) => [...prev, ...newItems]);
    setActiveTab("dashboard");

    // Fetch video info for each item in the background to show thumbnails and titles
    for (const item of newItems) {
      try {
        const info = await invoke<VideoInfo>("fetch_video_info", { url: item.url });
        setBatchQueueItems((prev) =>
          prev.map((b) =>
            b.id === item.id
              ? {
                ...b,
                title: info.title || b.title,
                thumbnail: info.thumbnail || b.thumbnail,
                duration_string: info.duration_string,
                site: info.uploader || b.site,
                metadataError: false,
              }
              : b
          )
        );
      } catch (err) {
        console.warn("Failed fetching batch item metadata:", item.url, err);
        // ─── Bug B: Mark item so UI renders an error badge instead of
        // a silent black thumbnail ───
        setBatchQueueItems((prev) =>
          prev.map((b) =>
            b.id === item.id ? { ...b, metadataError: true } : b
          )
        );
      }
    }
  };

  const handleStartBatchQueue = async (items: BatchItem[]) => {
    for (const item of items) {
      await handleStartDownload(
        item.format.format_id,
        item.format.ext,
        item.format.is_audio_only,
        {
          id: item.id,
          url: item.url,
          title: item.title,
        },
        item.format.label,
        "keep_both"
      );
    }
    setBatchQueueItems([]);
    setActiveTab("downloads");
  };
  const handleStartDownload = async (
    formatId: string,
    ext: string,
    isAudio: boolean,
    specificInfo?: any,
    formatLabel?: string,
    duplicateAction?: "overwrite" | "keep_both",
    customFolder?: string,
    downloadSubtitlesOverride?: boolean
  ) => {
    const info = specificInfo || videoInfo;
    if (!info) return;

    // 1. Define clip trimming status FIRST so displayFormat can use it
    const isClipTrimming = !specificInfo && isTrimming && trimStart && trimEnd;
    const downloadSectionsArg = isClipTrimming ? `*${trimStart}-${trimEnd}` : null;

    // 2. Compute display formats (Enhanced with Step 2's 1080p/720p fallbacks)
    const fallbackLabel = isAudio
      ? `Audio (${ext.toUpperCase()})`
      : formatId.includes("1080")
        ? "1080p Video"
        : formatId.includes("720")
          ? "720p Video"
          : `${ext.toUpperCase()} Video`;

    const baseDisplayFormat = formatLabel || fallbackLabel;
    const displayFormat = isClipTrimming
      ? `${baseDisplayFormat} [Clip ${trimStart}-${trimEnd}]`
      : baseDisplayFormat;

    // 3. Duplicate check logic (W2-8: capture the record for the enhanced dialog)
    if (!duplicateAction) {
      const existing = history.find(
        (h) =>
          h.url === info.url &&
          h.status === "completed" &&
          h.format.toLowerCase().includes(ext.toLowerCase())
      );
      if (existing) {
        // Try to compute an estimated size for the new download from
        // format metadata (yt-dlp provides filesize_approx when available)
        let newEstimatedSize: number | null = null;
        if (info.video_formats) {
          const m = info.video_formats.find((f: any) => f.format_id === formatId);
          if (m?.filesize_approx) newEstimatedSize = m.filesize_approx;
        }
        if (!newEstimatedSize && info.audio_formats) {
          const m = info.audio_formats.find((f: any) => f.format_id === formatId);
          if (m?.filesize_approx) newEstimatedSize = m.filesize_approx;
        }

        setDuplicateDialog({
          isOpen: true,
          formatId,
          ext,
          isAudio,
          specificInfo,
          formatLabel,
          existingRecord: {
            title: existing.title,
            format: existing.format,
            file_size: existing.file_size,
            file_path: existing.file_path,
            date_added: existing.date_added,
          },
          newEstimatedSize,
          newLabel: baseDisplayFormat,
        });
        return;
      }
    }

    // 4. Create task ID and new record
    const taskId = `${info.id}-${Date.now()}`;

    const newRecord: DownloadRecord = {
      id: taskId,
      url: info.url,
      title: info.title,
      file_path: null,
      status: "starting",
      percent: 0,
      format: displayFormat,
      date_added: Date.now() / 1000,
      hidden: false,
    };

    setHistory(prev => [newRecord, ...prev]);

    // Crucial Fix for Step 6: DO NOT WIPE videoInfo! Transition button to live status
    if (!specificInfo) {
      setActiveCardTaskId(taskId);
      setIsTrimming(false);
    }

    // Speed limit and proxy parameters
    const speedLimitArg = settings.speedLimit === "unlimited"
      ? null
      : settings.speedLimit === "custom"
        ? settings.customSpeedLimit
        : settings.speedLimit;

    const proxyArg = settings.proxyEnabled && settings.proxyHost
      ? `${settings.proxyProtocol}://${settings.proxyHost}:${settings.proxyPort}`
      : null;

    const targetBaseDir = customFolder || settings.saveFolder;
    const targetVideoDir = customFolder ? customFolder : (settings.videoFolder || null);
    const targetAudioDir = customFolder ? customFolder : (settings.audioFolder || null);

    try {
      // W3-2: pass an estimated size so backend can pre-flight disk space
      let estimatedSize: number | null = null;
      if (info.video_formats) {
        const m = info.video_formats.find((f: any) => f.format_id === formatId);
        if (m?.filesize_approx) estimatedSize = m.filesize_approx;
      }
      if (!estimatedSize && info.audio_formats) {
        const m = info.audio_formats.find((f: any) => f.format_id === formatId);
        if (m?.filesize_approx) estimatedSize = m.filesize_approx;
      }

      await invoke("start_download", {
        taskId: taskId,
        url: info.url,
        title: info.title,
        formatId: formatId,
        formatLabel: displayFormat,
        isAudioOnly: isAudio,
        ext: ext,
        baseDir: targetBaseDir,
        videoDir: targetVideoDir,
        audioDir: targetAudioDir,
        docsDir: settings.documentsFolder || settings.generalFolder || null,
        compDir: settings.compressedFolder || null,
        progDir: settings.programsFolder || null,
        tempDir: settings.tempFolder || null,
        speedLimit: speedLimitArg,
        proxy: proxyArg,
        customFlags: settings.customFlags ? settings.customFlags : null,
        scanAntivirus: settings.scanAntivirus,
        downloadSections: downloadSectionsArg,
        duplicateAction: duplicateAction || null,
        estimatedSizeBytes: estimatedSize,
        downloadSubtitles: downloadSubtitlesOverride !== undefined ? downloadSubtitlesOverride : (settings.downloadSubtitles ?? true),
        subtitleLanguages: settings.subtitleLanguages || "all",
      });
    } catch (e: any) {
      console.error("Start download failed:", e);
      // FIX: Force immediate state update even if the previous batch hasn't committed
      setHistory(prev => {
        const next = [...prev];
        const idx = next.findIndex(r => r.id === taskId);
        if (idx !== -1) {
          next[idx] = { ...next[idx], status: "error", error_code: "spawn_failed", error_message: e.toString() };
        } else {
          next.unshift({ ...newRecord, status: "error", error_code: "spawn_failed", error_message: e.toString() });
        }
        return next;
      });
      setActiveCardTaskId(null); // Clear spinner from main card
    }
  };

  const handleRetryDownload = async (record: DownloadRecord) => {
    const isAudio = isAudioFormat(record.format);
    const extMatch = record.format.match(/\(([A-Z0-9]+)\)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : (isAudio ? "mp3" : "mp4");
    const formatId = isAudio ? "bestaudio/best" : (record.format.includes("[") ? record.format : "bestvideo+bestaudio/best");

    setHistory(prev => prev.map(r => r.id === record.id ? {
      ...r,
      status: "starting",
      percent: 0,
      speed: "0 B/s",
      eta: "--",
      error_code: undefined,
      error_message: undefined,
    } : r));

    setActiveCardTaskId(record.id);

    const speedLimitArg = settings.speedLimit === "unlimited"
      ? null
      : settings.speedLimit === "custom"
        ? settings.customSpeedLimit
        : settings.speedLimit;

    const proxyArg = settings.proxyEnabled && settings.proxyHost
      ? `${settings.proxyProtocol}://${settings.proxyHost}:${settings.proxyPort}`
      : null;

    try {
      await invoke("start_download", {
        taskId: record.id,
        url: record.url,
        title: record.title,
        formatId: formatId,
        formatLabel: record.format,
        isAudioOnly: isAudio,
        ext: ext,
        baseDir: settings.saveFolder,
        videoDir: settings.videoFolder,
        audioDir: settings.audioFolder,
        docsDir: settings.generalFolder,
        compDir: settings.compressedFolder,
        progDir: settings.programsFolder,
        tempDir: settings.tempFolder,
        speedLimit: speedLimitArg,
        proxy: proxyArg,
        customFlags: settings.customFlags ? settings.customFlags : null,
        scanAntivirus: settings.scanAntivirus,
        downloadSections: null,
        duplicateAction: "overwrite",
        estimatedSizeBytes: record.file_size ?? null,
        downloadSubtitles: settings.downloadSubtitles !== false,
        subtitleLanguages: settings.subtitleLanguages || "all",
      });
    } catch (e: any) {
      console.error("Retry download failed:", e);
    }
  };

  // Keep the retry-handler ref current so the download-progress listener
  // can invoke it without stale closures
  useEffect(() => {
    handleRetryDownloadRef.current = handleRetryDownload;
  }, [handleRetryDownload]);

  // W2-10: Single source of truth for preset → yt-dlp format mapping
  const presetToFormat = (presetId: string): { formatId: string; ext: string; isAudio: boolean; label: string } => {
    const map: Record<string, { formatId: string; ext: string; isAudio: boolean; label: string }> = {
      "4k": { formatId: "bestvideo[height<=2160]+bestaudio/best[height<=2160]", ext: "mp4", isAudio: false, label: "4K Video (MP4)" },
      "1440p": { formatId: "bestvideo[height<=1440]+bestaudio/best[height<=1440]", ext: "mp4", isAudio: false, label: "1440p Video (MP4)" },
      "1080p": { formatId: "bestvideo[height<=1080]+bestaudio/best[height<=1080]", ext: "mp4", isAudio: false, label: "1080p Video (MP4)" },
      "720p": { formatId: "bestvideo[height<=720]+bestaudio/best[height<=720]", ext: "mp4", isAudio: false, label: "720p Video (MP4)" },
      "480p": { formatId: "bestvideo[height<=480]+bestaudio/best[height<=480]", ext: "mp4", isAudio: false, label: "480p Video (MP4)" },
      "360p": { formatId: "bestvideo[height<=360]+bestaudio/best[height<=360]", ext: "mp4", isAudio: false, label: "360p Video (MP4)" },
      "mp3": { formatId: "bestaudio/best", ext: "mp3", isAudio: true, label: "MP3 Audio (320 kbps)" },
      "m4a": { formatId: "bestaudio/best", ext: "m4a", isAudio: true, label: "M4A Audio (AAC)" },
      "flac": { formatId: "bestaudio/best", ext: "flac", isAudio: true, label: "FLAC Audio (Lossless)" },
      "wav": { formatId: "bestaudio/best", ext: "wav", isAudio: true, label: "WAV Audio (Uncompressed)" },
      "opus": { formatId: "bestaudio/best", ext: "opus", isAudio: true, label: "OPUS Audio" },
    };
    return map[presetId] || map["1080p"];
  };


  // W2-10: Accept a resolved list of {entry, preset} from PlaylistPanel.
  // F-13: Refresh a download's URL and resume from the existing .part file.
  // yt-dlp's native resume logic continues from where the .part left off,
  // so no backend changes are needed — we just pass the fresh URL through.
  const handleRefreshUrl = async (record: DownloadRecord, newUrl: string) => {
    const isAudio = isAudioFormat(record.format);
    const extMatch = record.format.match(/\(([A-Z0-9]+)\)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : (isAudio ? "mp3" : "mp4");
    const formatId = isAudio
      ? "bestaudio/best"
      : (record.format.includes("[") ? record.format : "bestvideo+bestaudio/best");

    // Optimistically update state so the UI reflects the retry immediately
    setHistory((prev) =>
      prev.map((r) =>
        r.id === record.id
          ? {
            ...r,
            url: newUrl,
            status: "starting" as const,
            percent: 0,
            speed: "0 B/s",
            eta: "--",
            error_code: undefined,
            error_message: undefined,
          }
          : r
      )
    );

    setActiveCardTaskId(record.id);
    setRefreshUrlDialog(null);

    const speedLimitArg =
      settings.speedLimit === "unlimited"
        ? null
        : settings.speedLimit === "custom"
          ? settings.customSpeedLimit
          : settings.speedLimit;

    const proxyArg = settings.proxyEnabled && settings.proxyHost
      ? `${settings.proxyProtocol}://${settings.proxyHost}:${settings.proxyPort}`
      : null;

    try {
      await invoke("start_download", {
        taskId: record.id,
        url: newUrl,                              // ← fresh URL
        title: record.title,
        formatId: formatId,
        formatLabel: record.format,
        isAudioOnly: isAudio,
        ext: ext,
        baseDir: settings.saveFolder,
        videoDir: settings.videoFolder,
        audioDir: settings.audioFolder,
        docsDir: settings.generalFolder,
        compDir: settings.compressedFolder,
        progDir: settings.programsFolder,
        tempDir: settings.tempFolder,
        speedLimit: speedLimitArg,
        proxy: proxyArg,
        customFlags: settings.customFlags ? settings.customFlags : null,
        scanAntivirus: settings.scanAntivirus,
        downloadSections: null,
        // "overwrite" here means "keep the .part and continue" — yt-dlp's
        // --force-overwrites flag combined with the existing .part file
        // results in a resume, not a restart.
        duplicateAction: "overwrite",
        estimatedSizeBytes: record.file_size ?? null,
        downloadSubtitles: settings.downloadSubtitles !== false,
        subtitleLanguages: settings.subtitleLanguages || "all",
      });
    } catch (e: any) {
      console.error("Refresh URL failed:", e);
      setHistory((prev) =>
        prev.map((r) =>
          r.id === record.id
            ? {
              ...r,
              status: "error" as const,
              error_code: "spawn_failed",
              error_message: e.toString(),
            }
            : r
        )
      );
    }
  };

  const handleBatchDownload = async (items: { entry: PlaylistEntry; preset: string }[]) => {
    if (!playlistInfo || !items || items.length === 0) return;

    const taskIds = items.map((t) => t.entry.id);
    setActivePlaylistBatch({
      title: playlistInfo.title,
      taskIds,
      formatLabel: items.length === 1 ? presetToFormat(items[0].preset).label : `${items.length} items`,
    });

    for (const { entry, preset } of items) {
      const f = presetToFormat(preset);
      await handleStartDownload(f.formatId, f.ext, f.isAudio, entry, f.label);
    }
  };
  const handleRemoveHistory = async (id: string) => {
    await invoke("hide_history_item", { id });
    loadHistory();
  };

  const handleDeleteFile = async (id: string, filePath: string | null) => {
    if (!filePath) return;
    setConfirmDialogState({
      isOpen: true,
      title: "Delete File",
      message: "Are you sure you want to delete this file from your disk?",
      confirmText: "Delete from Disk",
      confirmVariant: "danger",
      onConfirm: async () => {
        await invoke("delete_history_file", { id, filePath });
        loadHistory();
        setConfirmDialogState(null);
      }
    });
  };

  const togglePlaylistItem = (id: string) => {
    setSelectedPlaylistItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllPlaylist = () => {
    if (playlistInfo) {
      setSelectedPlaylistItems(new Set(playlistInfo.entries.map(e => e.id)));
    }
  };

  const deselectAllPlaylist = () => {
    setSelectedPlaylistItems(new Set());
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!e.origin.includes("youtube.com")) return;
      try {
        let data = e.data;
        if (typeof data === "string") {
          try {
            data = JSON.parse(data);
          } catch {
            return;
          }
        }
        if (!data || typeof data !== "object") return;

        if (data.event === "infoDelivery" && data.info) {
          if (typeof data.info.currentTime === "number" && !isNaN(data.info.currentTime)) {
            setPreviewTime(data.info.currentTime);
          }
          if (typeof data.info.duration === "number" && data.info.duration > 0) {
            setPreviewDuration(data.info.duration);
          }
        }

        let ytState: number | undefined = undefined;
        if (data.event === "infoDelivery" && data.info?.playerState !== undefined) {
          ytState = data.info.playerState;
        } else if (data.event === "onStateChange") {
          ytState = typeof data.info === "number" ? data.info : data.info?.playerState;
        }

        if (ytState === 1) { // Playing
          if (audioRef.current && !audioRef.current.paused) {
            audioRef.current.pause();
          }
          setisAudioElementPlaying(false);
          setActiveAudioPlaying(null);
          setPreviewingId(null);
          if (videoInfo) {
            transitionPlayback({ type: "video", id: videoInfo.id, state: "playing" });
          }
        } else if (ytState === 2) { // Paused
          if (videoInfo && nowPlayingRef.current.type === "video") {
            transitionPlayback({ type: "video", id: videoInfo.id, state: "paused" });
          }
        } else if (ytState === 0) { // Ended
          handleVideoEnded();
        }
      } catch { }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [videoInfo, transitionPlayback, handleVideoEnded]);

  // Status counters
  const activeCount = history.filter(h => h.status === "downloading" || h.status === "muxing" || h.status === "starting").length;
  const queuedCount = history.filter(h => h.status === "queued" || h.status === "fetching_metadata").length;
  const attentionCount = history.filter(h => h.status === "error" || h.status === "interrupted").length;
  const completedCount = history.filter(h => h.status === "completed").length;


  // Filtered & Sorted history with Real-Time Search & Attention Filter (1h: useMemo)
  const filteredHistory = useMemo(() => {
    return history.filter(item => {
      // 1. Keyword search across title, url, format
      if (activitySearchQuery.trim()) {
        const q = activitySearchQuery.toLowerCase().trim();
        const matchTitle = item.title?.toLowerCase().includes(q);
        const matchUrl = item.url?.toLowerCase().includes(q);
        const matchFormat = item.format?.toLowerCase().includes(q);
        if (!matchTitle && !matchUrl && !matchFormat) return false;
      }

      // 2. Queue filter category
      if (queueFilter === "all") return true;
      if (queueFilter === "video") return isVideoFormat(item.format);
      if (queueFilter === "audio") return isAudioFormat(item.format);
      if (queueFilter === "active") return item.status === "downloading" || item.status === "muxing" || item.status === "starting";
      if (queueFilter === "queued") return item.status === "queued" || item.status === "fetching_metadata";
      if (queueFilter === "completed") return item.status === "completed";
      if (queueFilter === "attention") return item.status === "error" || item.status === "interrupted" || item.status === "missing";
      return true;
    });
  }, [history, activitySearchQuery, queueFilter]);

  const sortedHistory = useMemo(() => {
    return [...filteredHistory].sort((a, b) => {
      if (sortBy === "date_desc") return b.date_added - a.date_added;
      if (sortBy === "date_asc") return a.date_added - b.date_added;
      if (sortBy === "size_desc") return (b.file_size || 0) - (a.file_size || 0);
      if (sortBy === "size_asc") return (a.file_size || 0) - (b.file_size || 0);
      if (sortBy === "title") return a.title.localeCompare(b.title);
      if (sortBy === "progress") return b.percent - a.percent;
      return 0;
    });
  }, [filteredHistory, sortBy]);

  const activeCardTask = activeCardTaskId ? history.find(h => h.id === activeCardTaskId) : null;

  // StatCard mini-lists (top 2 items per state)
  const cardItems = {
    active: history.filter(
      h => h.status === "downloading" || h.status === "muxing" || h.status === "starting"
    ),
    queued: history.filter(
      h => h.status === "queued" || h.status === "fetching_metadata"
    ),
    attention: history.filter(
      h => h.status === "error" || h.status === "interrupted"
    ),
    completed: history.filter(h => h.status === "completed"),
  };

  const firstActiveDownload = useMemo(() => {
    return history.find(h => h.status === "downloading" || h.status === "starting" || h.status === "muxing") || null;
  }, [history]);

  const handlePauseDownload = async (taskId: string) => {
    userPausedTaskIds.current.add(taskId);
    try {
      await invoke("pause_download", { taskId });
    } catch (err) {
      console.error("Pause failed:", err);
    }
    loadHistory();
  };

  const handleCancelDownload = async (taskId: string) => {
    try {
      await invoke("cancel_download", { taskId });
    } catch (err) {
      console.error("Cancel failed:", err);
    }
    loadHistory();
  };

  const handlePauseAll = async () => {
    for (const h of history) {
      if (h.status === "downloading" || h.status === "starting" || h.status === "fetching_metadata" || h.status === "muxing") {
        userPausedTaskIds.current.add(h.id);
        try {
          await invoke("pause_download", { taskId: h.id });
        } catch { }
      }
    }
    loadHistory();
  };

  const handleResumeAll = async () => {
    for (const h of history) {
      if (h.status === "interrupted" || h.status === "error") {
        handleRetryDownload(h);
      }
    }
  };

  const handleCancelAll = async () => {
    for (const h of history) {
      if (h.status === "downloading" || h.status === "starting" || h.status === "queued" || h.status === "interrupted") {
        try {
          await invoke("cancel_download", { taskId: h.id });
        } catch { }
      }
    }
    loadHistory();
  };

  const handlePauseSelected = async () => {
    for (const id of selectedHistoryItems) {
      userPausedTaskIds.current.add(id);
      try {
        await invoke("pause_download", { taskId: id });
      } catch { }
    }
    loadHistory();
  };

  const handleResumeSelected = async () => {
    for (const id of selectedHistoryItems) {
      const rec = history.find(h => h.id === id);
      if (rec && (rec.status === "interrupted" || rec.status === "error")) {
        handleRetryDownload(rec);
      }
    }
  };

  const handleCancelSelected = async () => {
    for (const id of selectedHistoryItems) {
      try {
        await invoke("cancel_download", { taskId: id });
      } catch { }
    }
    setSelectedHistoryItems(new Set());
    loadHistory();
  };

  if (isHud) {
    return <ClipboardHud settings={settings} />;
  }

  return (
    <AppShell
      mainRef={mainScrollRef}
      minimizeToTray={settings.minimizeToTray}
      onCloseClick={requestAppClose}
      sidebar={(collapsed, onToggleCollapse) => (
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onScrollToTop={() => {
            mainScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}
          activeCount={activeCount}
          queuedCount={queuedCount}
          activeDownload={firstActiveDownload}
          nowPlaying={nowPlaying}
          audioRef={audioRef}
          videoElementRef={videoElementRef}
          theme={theme}
          handleThemeChange={handleThemeChange}
          audioDevices={audioDevices}
          selectedAudioDevice={selectedAudioDevice}
          onSelectAudioDevice={handleDeviceChange}
          selectedEqPreset={selectedEqPreset}
          onSelectEqPreset={handleEqPresetChange}
          playSource={playSource}
          previewingId={previewingId}
          t={t}
        />
      )}
    >
      {/* Hidden Audio Player for In-line Previews */}
      <audio
        ref={audioRef}
        preload="auto"
        crossOrigin="anonymous"
        onPlay={() => {
          setisAudioElementPlaying(true);
        }}
        onPause={() => {
          setisAudioElementPlaying(false);
          // Distinguish user pause from stop: if audio is still loaded,
          // keep nowPlaying as {audio, paused} so the pill stays and
          // the user can resume. If it was a hard stop (ended, reset),
          // the ended handler will clear to {none}.
          if (audioRef.current && audioRef.current.currentTime > 0 &&
            audioRef.current.currentTime < (audioRef.current.duration || Infinity)) {
            const id = previewingId || activeAudioPlaying?.id;
            if (id) transitionPlayback({ type: "audio", id, state: "paused" });
          }
        }}
        onTimeUpdate={handleAudioTimeUpdate}
        onEnded={handleAudioEnded}
        onError={(e) => {
          console.error("Audio playback error on preview stream:", e);
          setIsLoadingAudioId(null);
          setisAudioElementPlaying(false);
          setPreviewingId(null);
          setActiveAudioPlaying(null);
          transitionPlayback({ type: "none" });
        }}
        className="hidden"
      />

      <ErrorBoundary fallbackTitle="An error occurred in this workspace view">

        {/* ===================== TAB 1: DASHBOARD ===================== */}
        <div className={activeTab === "dashboard" ? "tab-panel-active max-w-5xl xl:max-w-6xl mx-auto space-y-6" : "tab-panel-hidden max-w-5xl xl:max-w-6xl mx-auto space-y-6"}>

          {/* URL Input Form */}
          <UrlInput
            url={url}
            setUrl={setUrl}
            isFetching={isFetching}
            isSearchingYoutube={isSearchingYoutube}
            onAnalyze={handleAnalyze}
            onClear={resetInput}
            onImportTxtLines={handleImportTxtLines}
            placeholder={t("input_placeholder")}
            labelAnalyze={t("btn_analyze")}
            labelAnalyzing={t("analyzing")}
            hasActiveResult={!!(videoInfo && showPreviews)}
          />

          {fetchError && (
            <div className="bg-status-danger-subtle p-3.5 rounded-md flex items-start gap-2.5 text-status-danger animate-in fade-in duration-fast">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div className="text-body-sm font-medium">
                <span className="font-semibold">{t("analysis_failed")}: </span>{fetchError}
              </div>
            </div>
          )}

          {/* YouTube Keyword Search Results Grid */}
          {searchResults && (
            <SearchResults
              results={searchResults}
              onClose={() => setSearchResults(null)}
              onInspect={(u) => {
                setUrl(u);
                analyzeUrl(u);
              }}
              onPlay={(entry) => handlePlayVideo(entry)}
            />
          )}

          {/* Single Video Card Preview with Integrated In-App Player */}
          {videoInfo && showPreviews && (
            <VideoCard
              videoInfo={videoInfo}
              settings={settings}
              selectedFormat={selectedFormat}
              setSelectedFormat={setSelectedFormat}
              activeCardTask={activeCardTask}
              onDismissProgress={() => setActiveCardTaskId(null)}
              t={t}
              isAnalyzing={isFetching}
              existingDownloads={
                videoInfo
                  ? (() => {
                    // W2-9 fix: dedupe by normalized format so repeated
                    // downloads of the same format collapse into one chip.
                    const matches = history.filter(
                      (h) =>
                        h.url === videoInfo.url &&
                        h.status === "completed"
                    );
                    const seen = new Set<string>();
                    const unique: typeof matches = [];
                    for (const m of matches) {
                      const key = m.format.toLowerCase().trim();
                      if (seen.has(key)) continue;
                      seen.add(key);
                      unique.push(m);
                    }
                    return unique;
                  })()
                  : []
              }
              onRevealInFolder={openFolder}
              onOpenExistingFile={openFile}
              vm={{
                activeVideoPlaying,
                isVideoLoading,
                videoStreamUrl,
                videoFullscreen,
                videoContainerRef,
                videoElementRef,
                iframeRef,
                previewingId,
                isAudioElementPlaying,
                isLoadingAudioId,
                previewTime,
                previewDuration,
                audioRef,
                volume,
                isMuted,
                isTrimming,
                setIsTrimming,
                trimStart,
                setTrimStart,
                trimEnd,
                setTrimEnd,
                handlePlayVideo,
                handleVideoEnded,
                toggleFullscreen,
                handleCloseVideoPlayer,
                exitFullscreenAndKeepPlaying,
                sendIframeCommand,
                toggleAudioPreview,
                handleSeek,
                handleSeekRelative,
                toggleMute,
                handleVolumeChange,
                adjustTrimTimestamp,
                handleStartDownload,
                handleRetryDownload,
                openFile,
                formatSeconds,
                setisAudioElementPlaying,
                setPreviewingId,
                transitionPlayback,
                nowPlaying,
                stopAudioPlayback,
                repeatMode: audioRepeat,
                cycleRepeatMode: cycleAudioRepeat,
                audioShuffle,
                toggleAudioShuffle,
                audioNext,
                audioPrev,
                playlistInfo,
                selectedPlaylistItems,
              }}
            />
          )}

          {/* Batch Links Queue Panel */}
          {batchQueueItems.length > 0 && (
            <BatchQueuePanel
              items={batchQueueItems}
              onStartBatchDownload={handleStartBatchQueue}
              onClearBatch={() => setBatchQueueItems([])}
              onRemoveItem={(id) => setBatchQueueItems((prev) => prev.filter((b) => b.id !== id))}
              onUpdateItemFormat={(id, fmt) =>
                setBatchQueueItems((prev) =>
                  prev.map((b) => (b.id === id ? { ...b, format: fmt } : b))
                )
              }
              onPlayVideo={(item) =>
                handlePlayVideo({
                  id: item.id,
                  url: item.url,
                  title: item.title,
                  thumbnail: item.thumbnail,
                  duration_string: item.duration_string || "",
                })
              }
              onPreviewAudio={toggleAudioPreview}
              previewingId={previewingId}
              isAudioElementPlaying={isAudioElementPlaying}
              isLoadingAudioId={isLoadingAudioId}
              previewTime={previewTime}
              previewDuration={previewDuration}
              onSeek={handleSeek}
              onSeekRelative={handleSeekRelative}
              onClosePreview={() => {
                if (audioRef.current) audioRef.current.pause();
                setisAudioElementPlaying(false);
                setPreviewingId(null);
                transitionPlayback({ type: "none" });
              }}
              audioRef={audioRef}
              formatSeconds={formatSeconds}
            />
          )}

          {/* Playlist Banner & Items Drawer */}
          {(playlistInfo || isLoadingPlaylist) && showPreviews && (
            <PlaylistPanel
              t={t}
              playlistInfo={playlistInfo}
              isLoadingPlaylist={isLoadingPlaylist}
              showSection={showPlaylistSection}
              setShowSection={setShowPlaylistSection}
              selectedIds={selectedPlaylistItems}
              toggleItem={togglePlaylistItem}
              selectAll={selectAllPlaylist}
              deselectAll={deselectAllPlaylist}
              onBatchDownload={(items) => handleBatchDownload(items)}
              onSingleDownload={(entry, preset) => {
                const f = presetToFormat(preset);
                handleStartDownload(f.formatId, f.ext, f.isAudio, entry, f.label);
              }}
              onPlayVideo={handlePlayVideo}
              onPreviewAudio={toggleAudioPreview}
              previewingId={previewingId}
              isAudioElementPlaying={isAudioElementPlaying}
              isLoadingAudioId={isLoadingAudioId}
              previewTime={previewTime}
              previewDuration={previewDuration}
              onSeek={handleSeek}
              onSeekRelative={handleSeekRelative}
              onClosePreview={() => {
                if (audioRef.current) audioRef.current.pause();
                setisAudioElementPlaying(false);
                setPreviewingId(null);
                transitionPlayback({ type: "none" });
              }}
              history={history}
              audioRef={audioRef}
            />
          )}

          {/* BatchProgressView for Playlist Bulk Downloads */}
          {activePlaylistBatch && (
            <BatchProgress
              title={activePlaylistBatch.title}
              taskIds={activePlaylistBatch.taskIds}
              formatLabel={activePlaylistBatch.formatLabel}
              history={history}
              onClear={() => setActivePlaylistBatch(null)}
            />
          )}
        </div>

        {/* ===================== TAB 2: DOWNLOADS ===================== */}
        <div className={activeTab === "downloads" ? "tab-panel-active" : "tab-panel-hidden"}>
          <DownloadsTab
            t={t}
            isOnline={isOnline}
            sortedHistory={sortedHistory}
            activitySearchQuery={activitySearchQuery}
            setActivitySearchQuery={setActivitySearchQuery}
            queueFilter={queueFilter}
            setQueueFilter={setQueueFilter}
            sortBy={sortBy}
            setSortBy={setSortBy}
            selectedHistoryItems={selectedHistoryItems}
            setSelectedHistoryItems={setSelectedHistoryItems}
            activeCount={activeCount}
            queuedCount={queuedCount}
            attentionCount={attentionCount}
            completedCount={completedCount}
            cardItems={cardItems}
            openFolder={openFolder}
            openFile={openFile}
            handleRemoveHistory={handleRemoveHistory}
            handleDeleteFile={handleDeleteFile}
            handleRetryDownload={handleRetryDownload}
            onPauseAll={handlePauseAll}
            onResumeAll={handleResumeAll}
            onCancelAll={handleCancelAll}
            onCancelSelected={handleCancelSelected}
            onPauseDownload={handlePauseDownload}
            onResumeDownload={handleRetryDownload}
            onCancelDownload={handleCancelDownload}
            onPauseSelected={handlePauseSelected}
            onResumeSelected={handleResumeSelected}
            onRefreshUrl={(record) => {
              setRefreshUrlDialog({
                isOpen: true,
                record,
                oldUrl: record.url,
                errorCode: record.error_code,
              });
            }}
          />
        </div>

        {/* ===================== TAB 3: MULTIMEDIA HUB ===================== */}
        <div className={activeTab === "multimedia" ? "tab-panel-active" : "tab-panel-hidden"}>
          <MultimediaTab
            t={t}
            history={history}
            isVideoFormat={isVideoFormat}
            isAudioFormat={isAudioFormat}
            openFolder={openFolder}
            openFile={openFile}
            handleDeleteFile={handleDeleteFile}
            formatSeconds={formatSeconds}
            stopGlobalAudioPlayback={stopAudioPlayback}
            onNowPlayingChange={transitionPlayback}
            selectedAudioDevice={selectedAudioDevice}
            nowPlaying={nowPlaying}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={handleVolumeChange}
            onToggleMute={toggleMute}
          />
        </div>

        {/* ===================== TAB 4: COMPLETE SETTINGS ===================== */}
        <div className={activeTab === "settings" ? "tab-panel-active" : "tab-panel-hidden"}>
          <SettingsTab
            t={t}
            settings={settings}
            updateSetting={updateSetting}
            theme={theme}
            handleThemeChange={handleThemeChange}
            audioDevices={audioDevices}
            selectedAudioDevice={selectedAudioDevice}
            handleDeviceChange={handleDeviceChange}
            volume={volume}
            isMuted={isMuted}
            handleVolumeChange={handleVolumeChange}
            toggleMute={toggleMute}
            handleToggleAutostart={handleToggleAutostart}
            handleBrowseFolder={handleBrowseFolder}
            openFolder={openFolder}
          />
        </div>

      </ErrorBoundary>

      {duplicateDialog && (
        <DuplicateDialog
          state={duplicateDialog}
          onOverwrite={() => {
            handleStartDownload(
              duplicateDialog.formatId,
              duplicateDialog.ext,
              duplicateDialog.isAudio,
              duplicateDialog.specificInfo,
              duplicateDialog.formatLabel,
              "overwrite"
            );
            setDuplicateDialog(null);
          }}
          onKeepBoth={() => {
            handleStartDownload(
              duplicateDialog.formatId,
              duplicateDialog.ext,
              duplicateDialog.isAudio,
              duplicateDialog.specificInfo,
              duplicateDialog.formatLabel,
              "keep_both"
            );
            setDuplicateDialog(null);
          }}
          onCancel={() => setDuplicateDialog(null)}
        />
      )}

      {refreshUrlDialog && (
        <RefreshUrlDialog
          state={refreshUrlDialog}
          onResume={handleRefreshUrl}
          onCancel={() => setRefreshUrlDialog(null)}
        />
      )}

      {confirmDialogState && (
        <ConfirmDialog
          isOpen={confirmDialogState.isOpen}
          title={confirmDialogState.title}
          message={confirmDialogState.message}
          confirmText={confirmDialogState.confirmText}
          confirmVariant={confirmDialogState.confirmVariant}
          onConfirm={confirmDialogState.onConfirm}
          onCancel={() => setConfirmDialogState(null)}
        />
      )}

      <CloseAppConfirmDialog
        isOpen={isCloseConfirmOpen}
        activeCount={history.filter(h => h.status === "downloading" || h.status === "muxing" || h.status === "starting").length}
        onContinueDownloading={handleCancelCloseApp}
        onCloseApp={handleConfirmCloseApp}
      />
    </AppShell>
  );
}


