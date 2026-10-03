// src/components/media/MultimediaTab.tsx
import { useState, useMemo, useRef, useEffect } from "react";
import {
    ArrowUpDown,
    CheckSquare,
    ExternalLink,
    Film,
    Folder,
    FolderPlus,
    LayoutGrid,
    List,
    ListMusic,
    Maximize2,
    Minimize2,
    Music,
    Pause,
    Play,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    Scaling,
    Search,
    Shuffle,
    SkipBack,
    SkipForward,
    Square,
    Subtitles,
    Trash2,
    Volume2,
    VolumeX,
    X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { DownloadRecord, NowPlaying } from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import { formatFileSize } from "../../lib/format";
import { formatDisplayBadge } from "../../lib/formatClassify";
import { routeAudioDevice, attachEqualizerToMedia, ensureAudioContext } from "../../lib/audioContext";
import { WaveformVisualizer } from "../common/WaveformVisualizer";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

function safeConvertFileSrc(filePath: string): string {
    const sanitized = filePath.replace(/#/g, "%23").replace(/\?/g, "%3F");
    return convertFileSrc(sanitized);
}

function extractYtId(url: string, id: string): string | null {
    if (!url && !id) return null;
    const m = url?.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    if (m && m[1]) return m[1];
    const firstPart = id?.split("-")[0];
    if (firstPart && /^[\w-]{11}$/.test(firstPart)) return firstPart;
    return null;
}

export function MultimediaTab({
    t: _t,
    history,
    isVideoFormat,
    isAudioFormat,
    openFolder,
    openFile,
    handleDeleteFile,
    formatSeconds,
    stopGlobalAudioPlayback,
    onNowPlayingChange,
    selectedAudioDevice,
    nowPlaying,
    volume,
    isMuted,
    onVolumeChange,
    onToggleMute,
    initialPlayRecord,
    onClearInitialPlayRecord,
}: {
    t: (key: TranslationKey) => string;
    history: DownloadRecord[];
    isVideoFormat: (fmt: string) => boolean;
    isAudioFormat: (fmt: string) => boolean;
    openFolder: (path?: string | null) => void;
    openFile: (path?: string | null) => void;
    handleDeleteFile: (id: string, filePath: string | null) => void;
    formatSeconds: (secs: number) => string;
    stopGlobalAudioPlayback?: () => void;
    onNowPlayingChange?: (now: NowPlaying) => void;
    selectedAudioDevice?: string;
    nowPlaying?: NowPlaying;
    volume: number;
    isMuted: boolean;
    onVolumeChange: (v: number) => void;
    onToggleMute: () => void;
    initialPlayRecord?: DownloadRecord | null;
    onClearInitialPlayRecord?: () => void;
}) {
    // Filters & view modes
    const [mediaFilter, setMediaFilter] = useState<"all" | "videos" | "audios">("all");
    const [searchQuery, setSearchQuery] = useState("");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [viewMode, setViewModeState] = useState<"grid" | "list">(() => {
        try {
            const saved = localStorage.getItem("devizee_media_view_mode");
            if (saved === "grid" || saved === "list") return saved;
        } catch { }
        return "grid";
    });

    const setViewMode = (mode: "grid" | "list") => {
        setViewModeState(mode);
        try {
            localStorage.setItem("devizee_media_view_mode", mode);
        } catch { }
    };
    const [videoError, setVideoError] = useState<string | null>(null);

    const [customFolders, setCustomFolders] = useState<string[]>(() => {
        try {
            const saved = localStorage.getItem("devizee_custom_folders");
            if (saved) return JSON.parse(saved);
        } catch { }
        return [];
    });
    const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

    // In-App Player State
    const [activePlayingItem, setActivePlayingItem] = useState<DownloadRecord | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubValue, setScrubValue] = useState(0);
    const [isShuffle, setIsShuffle] = useState(false);
    const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showNetflixDrawer, setShowNetflixDrawer] = useState(false);
    const [customSubtitleUrl, setCustomSubtitleUrl] = useState<string | null>(null);
    const [customSubtitleName, setCustomSubtitleName] = useState<string | null>(null);

    const handleAddSubtitleTrack = async (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        try {
            const selected = await open({
                title: "Select Subtitle File",
                multiple: false,
                filters: [{ name: "Subtitles", extensions: ["srt", "vtt", "txt"] }],
            });
            if (selected && typeof selected === "string") {
                const vttContent = await invoke<string>("read_subtitle_file", { path: selected });
                if (customSubtitleUrl) {
                    try { URL.revokeObjectURL(customSubtitleUrl); } catch (_) { }
                }
                const blob = new Blob([vttContent], { type: "text/vtt" });
                const blobUrl = URL.createObjectURL(blob);
                const filename = selected.split(/[\\/]/).pop() || "Subtitles";
                setCustomSubtitleUrl(blobUrl);
                setCustomSubtitleName(filename);
            }
        } catch (err) {
            console.error("Load subtitles error:", err);
        }
    };

    // Queue dismissals state
    const [dismissedQueueIds, setDismissedQueueIds] = useState<Set<string>>(new Set());
    const [videoFitMode, setVideoFitMode] = useState<"contain" | "cover">("contain");
    const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

    useEffect(() => {
        if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
        if (audioRef.current) audioRef.current.playbackRate = playbackSpeed;
    }, [playbackSpeed]);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const mediaContainerRef = useRef<HTMLDivElement | null>(null);

    // Guard: media elements fire a spurious `ended` event when src is changed
    // mid-playback (pause() + load() causes an implicit abort that some
    // WebView2 builds report as `ended`). Without this guard, every rapid
    // click cascades a spurious `handleNext()` and the queue jumps tracks.
    const suppressEndedRef = useRef(false);

    // Deferred video play: when clicking a video for the first time, the
    // <video> element isn't mounted yet (it lives inside a conditional block).
    // We stash the intent here and flush it in a useEffect after re-render.
    const pendingVideoPlayRef = useRef<string | null>(null);

    // Attach the 8-band Web Audio equalizer to both audio and video elements on mount.
    // Runs once after mount — attach is idempotent, so repeated calls are safe.
    useEffect(() => {
        if (audioRef.current) attachEqualizerToMedia(audioRef.current);
        if (videoRef.current) attachEqualizerToMedia(videoRef.current);
    }, []);

    type LocalMediaFile = {
        id: string;
        title: string;
        file_path: string;
        format: string;
        is_audio: boolean;
        file_size: number;
        modified_time: number;
        thumbnail?: string | null;
    };

    const [scannedLocalItems, setScannedLocalItems] = useState<DownloadRecord[]>([]);
    const [sortBy, setSortBy] = useState<"date_desc" | "date_asc" | "title" | "size_desc">("date_desc");
    const [localThumbnails, setLocalThumbnails] = useState<Record<string, string>>({});
    const attemptedThumbPaths = useRef<Set<string>>(new Set());

    const getItemThumbnail = (item?: DownloadRecord | null, quality: "mqdefault" | "hqdefault" = "mqdefault"): string | null => {
        if (!item) return null;
        const yId = extractYtId(item.url, item.id);
        if (yId) return `https://i.ytimg.com/vi/${yId}/${quality}.jpg`;
        if (item.thumbnail) {
            if (item.thumbnail.startsWith("http://") || item.thumbnail.startsWith("https://") || item.thumbnail.startsWith("asset://")) {
                return item.thumbnail;
            }
            return safeConvertFileSrc(item.thumbnail);
        }
        if (item.file_path && localThumbnails[item.file_path]) {
            return localThumbnails[item.file_path];
        }
        return null;
    };

    const scanFolders = async (foldersToScan: string[]) => {
        if (!foldersToScan || foldersToScan.length === 0) {
            setScannedLocalItems([]);
            return;
        }
        const collected: DownloadRecord[] = [];
        const seenPaths = new Set<string>();

        history.forEach((h) => {
            if (h.file_path) seenPaths.add(h.file_path.replace(/\\/g, "/").toLowerCase());
        });

        for (const folder of foldersToScan) {
            try {
                const files = await invoke<LocalMediaFile[]>("scan_local_folder", { path: folder });
                for (const f of files) {
                    const normPath = f.file_path.replace(/\\/g, "/").toLowerCase();
                    if (seenPaths.has(normPath)) continue;
                    seenPaths.add(normPath);
                    collected.push({
                        id: f.id,
                        url: "",
                        title: f.title,
                        file_path: f.file_path,
                        status: "completed",
                        percent: 100,
                        format: f.format,
                        date_added: f.modified_time,
                        hidden: false,
                        file_size: f.file_size,
                        thumbnail: f.thumbnail ? safeConvertFileSrc(f.thumbnail) : undefined,
                    });
                }
            } catch (err) {
                console.warn(`[Multimedia] Failed to scan local folder ${folder}:`, err);
            }
        }
        setScannedLocalItems(collected);
    };

    useEffect(() => {
        scanFolders(customFolders);
    }, [customFolders]);

    // Filter completed multimedia items (merges SQLite history and local scanned items)
    const allMediaItems = useMemo(() => {
        const historyCompleted = history.filter(
            (h) => h.status === "completed" && (isVideoFormat(h.format) || isAudioFormat(h.format))
        );
        const historyPaths = new Set(
            historyCompleted
                .filter((h) => h.file_path)
                .map((h) => h.file_path!.replace(/\\/g, "/").toLowerCase())
        );
        const dedupedScanned = scannedLocalItems.filter(
            (s) => !s.file_path || !historyPaths.has(s.file_path.replace(/\\/g, "/").toLowerCase())
        );
        return [...historyCompleted, ...dedupedScanned];
    }, [history, scannedLocalItems, isVideoFormat, isAudioFormat]);

    const folderFilteredItems = useMemo(() => {
        if (!selectedFolder) return allMediaItems;
        const normalizedFolder = selectedFolder.replace(/\\/g, "/").toLowerCase();
        return allMediaItems.filter((m) => {
            if (!m.file_path) return false;
            const p = m.file_path.replace(/\\/g, "/").toLowerCase();
            return p.startsWith(normalizedFolder);
        });
    }, [allMediaItems, selectedFolder]);

    const videoCount = useMemo(() => {
        return folderFilteredItems.filter((m) => isVideoFormat(m.format)).length;
    }, [folderFilteredItems, isVideoFormat]);

    const audioCount = useMemo(() => {
        return folderFilteredItems.filter((m) => isAudioFormat(m.format)).length;
    }, [folderFilteredItems, isAudioFormat]);

    // Filtered items by category, search & sorting
    const displayedItems = useMemo(() => {
        let items = folderFilteredItems;
        if (mediaFilter === "videos") {
            items = items.filter((m) => isVideoFormat(m.format));
        } else if (mediaFilter === "audios") {
            items = items.filter((m) => isAudioFormat(m.format));
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            items = items.filter(
                (m) => m.title.toLowerCase().includes(q) || m.format.toLowerCase().includes(q)
            );
        }

        return [...items].sort((a, b) => {
            if (sortBy === "date_desc") return (b.date_added || 0) - (a.date_added || 0);
            if (sortBy === "date_asc") return (a.date_added || 0) - (b.date_added || 0);
            if (sortBy === "size_desc") return (b.file_size || 0) - (a.file_size || 0);
            if (sortBy === "title") return a.title.localeCompare(b.title);
            return 0;
        });
    }, [folderFilteredItems, mediaFilter, searchQuery, sortBy, isVideoFormat, isAudioFormat]);

    // Media Queue for playback & drawer
    const currentQueue = useMemo(() => {
        let list = displayedItems.filter((item) => !dismissedQueueIds.has(item.id));
        if (isShuffle) {
            for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
            }
        }
        return list;
    }, [displayedItems, isShuffle, dismissedQueueIds]);

    // Fullscreen queue items (keep all items, active item is highlighted in UI)
    const upcomingQueue = useMemo(() => {
        return currentQueue;
    }, [currentQueue]);

    // Background thumbnail generator for local video files (throttled & pauses during active playback)
    useEffect(() => {
        if (isPlaying) return;

        const allCandidates = [...displayedItems, ...upcomingQueue];
        const itemsToFetch = allCandidates.filter(
            (item) =>
                item.file_path &&
                isVideoFormat(item.format) &&
                !extractYtId(item.url, item.id) &&
                !item.thumbnail &&
                !attemptedThumbPaths.current.has(item.file_path)
        );

        if (itemsToFetch.length === 0) return;

        // Deduplicate by file_path
        const uniqueItems = Array.from(new Map(itemsToFetch.map((item) => [item.file_path!, item])).values());
        for (const item of uniqueItems) {
            attemptedThumbPaths.current.add(item.file_path!);
        }

        let isCancelled = false;

        const generateThumbs = async () => {
            const batch: Record<string, string> = {};
            let count = 0;
            for (const item of uniqueItems) {
                if (isCancelled) break;
                try {
                    const thumbPath = await invoke<string>("get_video_thumbnail", { filePath: item.file_path });
                    if (thumbPath && !isCancelled) {
                        const assetUrl = safeConvertFileSrc(thumbPath);
                        batch[item.file_path!] = assetUrl;
                        count++;
                        if (count >= 4) {
                            setLocalThumbnails((prev) => ({ ...prev, ...batch }));
                            count = 0;
                        }
                    }
                } catch {
                    // Silently ignore extraction errors
                }
                // Yield to browser main thread between extractions
                await new Promise((r) => setTimeout(r, 150));
            }
            if (!isCancelled && count > 0) {
                setLocalThumbnails((prev) => ({ ...prev, ...batch }));
            }
        };

        const timer = setTimeout(generateThumbs, 300);

        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [displayedItems, upcomingQueue, isVideoFormat, isPlaying]);

    useEffect(() => {
        const handleFs = async () => {
            const isFs = !!document.fullscreenElement;
            setIsFullscreen(isFs);
            try {
                const appWindow = getCurrentWindow();
                await appWindow.setFullscreen(isFs);
            } catch { }
        };
        document.addEventListener("fullscreenchange", handleFs);
        return () => {
            document.removeEventListener("fullscreenchange", handleFs);
            try {
                getCurrentWindow().setFullscreen(false);
            } catch { }
        };
    }, []);

    const handleVolumeChange = (newVol: number) => {
        onVolumeChange(newVol);
    };

    const toggleMute = () => {
        onToggleMute();
    };

    const toggleFullscreen = async () => {
        if (!mediaContainerRef.current) return;
        const appWindow = getCurrentWindow();
        if (!document.fullscreenElement && !isFullscreen) {
            try {
                await mediaContainerRef.current.requestFullscreen();
            } catch { }
            try {
                await appWindow.setFullscreen(true);
            } catch { }
            setIsFullscreen(true);
        } else {
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                }
            } catch { }
            try {
                await appWindow.setFullscreen(false);
            } catch { }
            setIsFullscreen(false);
        }
    };


    // Keyboard Shortcuts for Multimedia Hub (Space, Arrows, M, F, Esc)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) {
                return;
            }

            if (!activePlayingItem) return;
            const isVid = isVideoFormat(activePlayingItem.format);
            const element = isVid ? videoRef.current : audioRef.current;
            if (!element) return;

            if (e.code === "Space") {
                e.preventDefault();
                togglePlayPause();
            } else if (e.code === "ArrowLeft") {
                e.preventDefault();
                const delta = (e.shiftKey || e.ctrlKey) ? 60 : 10;
                const nextTime = Math.max(0, element.currentTime - delta);
                handleSeek(nextTime);
            } else if (e.code === "ArrowRight") {
                e.preventDefault();
                const delta = (e.shiftKey || e.ctrlKey) ? 60 : 10;
                const nextTime = Math.min(element.duration || 86400, element.currentTime + delta);
                handleSeek(nextTime);
            } else if (e.code === "ArrowUp") {
                e.preventDefault();
                handleVolumeChange(Math.min(1, volume + 0.05));
            } else if (e.code === "ArrowDown") {
                e.preventDefault();
                handleVolumeChange(Math.max(0, volume - 0.05));
            } else if (e.code === "KeyM") {
                e.preventDefault();
                toggleMute();
            } else if (e.code === "KeyF" && isVid) {
                e.preventDefault();
                toggleFullscreen();
            } else if (e.code === "Escape" && isFullscreen) {
                e.preventDefault();
                toggleFullscreen();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [activePlayingItem, isPlaying, volume, isMuted, isFullscreen, selectedAudioDevice]);

    // Mouse Wheel Volume on Multimedia Player with queue drawer guard
    const handleWheelVolume = (e: React.WheelEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-queue-drawer="true"]')) return;

        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        const newVol = Math.max(0, Math.min(1, volume + delta));
        handleVolumeChange(newVol);
    };

    // Route audio output device to media elements with automatic fallback
    useEffect(() => {
        const el = activePlayingItem && isVideoFormat(activePlayingItem.format)
            ? videoRef.current
            : audioRef.current;
        routeAudioDevice(selectedAudioDevice || "default", el);
    }, [selectedAudioDevice, activePlayingItem]);

    // Sync global master volume into whichever media element is loaded
    useEffect(() => {
        const effective = isMuted ? 0 : volume;
        if (videoRef.current) videoRef.current.volume = effective;
        if (audioRef.current) {
            audioRef.current.volume = effective;
            attachEqualizerToMedia(audioRef.current);
        }
    }, [volume, isMuted, activePlayingItem]);

    // Mutual exclusion: pause if media outside Multimedia starts playing.
    // We use a ref for activePlayingItem to avoid this effect firing on
    // activePlayingItem changes — only on real nowPlaying changes.
    const activePlayingItemRef = useRef<DownloadRecord | null>(null);
    useEffect(() => {
        activePlayingItemRef.current = activePlayingItem;
    }, [activePlayingItem]);

    useEffect(() => {
        if (!nowPlaying || nowPlaying.type === "none") return;
        const active = activePlayingItemRef.current;
        if (!active) return;
        // If the parent's nowPlaying is for a DIFFERENT item AND it did
        // not originate from Multimedia, pause our media.
        if (nowPlaying.id !== active.id && nowPlaying.source !== "multimedia") {
            if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
            if (audioRef.current && !audioRef.current.paused) audioRef.current.pause();
            setIsPlaying(false);
        }
    }, [nowPlaying]);

    // Play Item In-App with strict single-element playback
    const playRequestIdRef = useRef(0);

    const playMediaItem = (item: DownloadRecord) => {
        if (!item.file_path) return;
        const requestId = ++playRequestIdRef.current;

        setVideoError(null);
        stopGlobalAudioPlayback?.();

        setActivePlayingItem(item);
        setIsPlaying(true);
        setCurrentTime(0);
        setDuration(0);

        const src = safeConvertFileSrc(item.file_path);
        const isVid = isVideoFormat(item.format);

        onNowPlayingChange?.({
            type: isVid ? "video" : "audio",
            id: item.id,
            state: "playing",
            source: "multimedia",
        });

        // Suppress any spurious `ended` that fires from the src-change abort
        suppressEndedRef.current = true;

        if (isVid) {
            // Pause the other element but DO NOT wipe its src (race trigger)
            if (audioRef.current) audioRef.current.pause();

            const el = videoRef.current;
            if (!el) {
                // Video element not mounted yet (first click on a video).
                // Stash and let the useEffect flush it after React re-renders.
                pendingVideoPlayRef.current = src;
                return;
            }
            el.pause();
            const ctx = ensureAudioContext();
            if (ctx && ctx.state === "suspended") {
                ctx.resume().catch(() => { });
            }
            attachEqualizerToMedia(el);
            el.src = src;
            el.volume = isMuted ? 0 : volume;
            routeAudioDevice(selectedAudioDevice || "default", el);
            el.play()
                .then(() => {
                    if (requestId !== playRequestIdRef.current) return;
                    suppressEndedRef.current = false;
                })
                .catch((err: any) => {
                    if (requestId !== playRequestIdRef.current) return; // stale request — ignore
                    console.warn("[Multimedia] Video play failed:", err?.name || err);
                    suppressEndedRef.current = false;
                });
        } else {
            if (videoRef.current) videoRef.current.pause();

            const el = audioRef.current;
            if (!el) return;
            el.pause();
            const ctx = ensureAudioContext();
            if (ctx && ctx.state === "suspended") {
                ctx.resume().catch(() => { });
            }
            attachEqualizerToMedia(el);       // idempotent — runs once
            el.src = src;
            el.volume = isMuted ? 0 : volume;
            routeAudioDevice(selectedAudioDevice || "default", el);
            el.play()
                .then(() => {
                    if (requestId !== playRequestIdRef.current) return;
                    suppressEndedRef.current = false;
                })
                .catch((err: any) => {
                    if (requestId !== playRequestIdRef.current) return; // stale
                    console.warn("[Multimedia] Audio play failed:", err?.name || err);
                    suppressEndedRef.current = false;
                });
        }
    };

    // Auto-play media item when requested from Downloads tab or other screens
    useEffect(() => {
        if (initialPlayRecord && initialPlayRecord.file_path) {
            playMediaItem(initialPlayRecord);
            onClearInitialPlayRecord?.();
        }
    }, [initialPlayRecord]);

    // Flush deferred video play once the <video> element has mounted
    useEffect(() => {
        if (!pendingVideoPlayRef.current) return;
        const el = videoRef.current;
        if (!el) return;

        const src = pendingVideoPlayRef.current;
        pendingVideoPlayRef.current = null;

        // Guard the src-change race on the deferred path too
        suppressEndedRef.current = true;

        const ctx = ensureAudioContext();
        if (ctx && ctx.state === "suspended") {
            ctx.resume().catch(() => { });
        }
        attachEqualizerToMedia(el);

        el.pause();
        el.src = src;
        el.volume = isMuted ? 0 : volume;
        routeAudioDevice(selectedAudioDevice || "default", el);
        el.play()
            .then(() => {
                suppressEndedRef.current = false;
            })
            .catch((err: any) => {
                console.warn("[Multimedia] Deferred video play failed:", err?.name || err);
                suppressEndedRef.current = false;
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePlayingItem]);

    const togglePlayPause = () => {
        if (!activePlayingItem) return;
        const isVid = isVideoFormat(activePlayingItem.format);
        const element = isVid ? videoRef.current : audioRef.current;
        if (!element) return;

        if (isPlaying) {
            element.pause();
            onNowPlayingChange?.({ type: isVid ? "video" : "audio", id: activePlayingItem.id, state: "paused", source: "multimedia" });
        } else {
            element.play().catch(() => { });
            onNowPlayingChange?.({ type: isVid ? "video" : "audio", id: activePlayingItem.id, state: "playing", source: "multimedia" });
        }
    };

    const handleSeek = (newTime: number) => {
        if (!activePlayingItem) return;
        const isVid = isVideoFormat(activePlayingItem.format);
        const element = isVid ? videoRef.current : audioRef.current;
        if (element) {
            if (isVid && typeof (element as any).fastSeek === "function") {
                try {
                    (element as any).fastSeek(newTime);
                } catch {
                    element.currentTime = newTime;
                }
            } else {
                element.currentTime = newTime;
            }
            setCurrentTime(newTime);
        }
    };

    const handleNext = () => {
        if (!activePlayingItem || currentQueue.length === 0) return;
        const idx = currentQueue.findIndex((x) => x.id === activePlayingItem.id);
        if (idx !== -1 && idx < currentQueue.length - 1) {
            playMediaItem(currentQueue[idx + 1]);
        } else if (repeatMode === "all" && currentQueue.length > 0) {
            playMediaItem(currentQueue[0]);
        }
    };

    const handlePrev = () => {
        if (!activePlayingItem || currentQueue.length === 0) return;
        if (currentTime > 3) {
            if (videoRef.current) videoRef.current.currentTime = 0;
            if (audioRef.current) audioRef.current.currentTime = 0;
            return;
        }
        const idx = currentQueue.findIndex((x) => x.id === activePlayingItem.id);
        if (idx > 0) {
            playMediaItem(currentQueue[idx - 1]);
        } else if (repeatMode === "all" && currentQueue.length > 0) {
            playMediaItem(currentQueue[currentQueue.length - 1]);
        }
    };

    const handleMediaEnded = () => {
        // Ignore spurious `ended` events that fire during a src transition.
        if (suppressEndedRef.current) {
            console.log("[Multimedia] Suppressed spurious ended event");
            return;
        }

        const active = activePlayingItemRef.current;
        if (repeatMode === "one" && active) {
            playMediaItem(active);
            return;
        }
        handleNext();
    };

    const closePlayer = () => {
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.src = "";
        }
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = "";
        }
        setActivePlayingItem(null);
        setIsPlaying(false);
        onNowPlayingChange?.({ type: "none", source: "multimedia" });
    };

    const dismissQueueItem = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setDismissedQueueIds((prev) => new Set([...prev, id]));
    };

    const handleAddFolder = async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
            });
            if (selected && typeof selected === "string") {
                const updated = Array.from(new Set([...customFolders, selected]));
                setCustomFolders(updated);
                setSelectedFolder(selected);
                try {
                    localStorage.setItem("devizee_custom_folders", JSON.stringify(updated));
                } catch { }
                scanFolders(updated);
            }
        } catch (err) {
            console.error("Add folder error:", err);
        }
    };

    const handleRemoveFolder = (folderPath: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const updated = customFolders.filter((f) => f !== folderPath);
        setCustomFolders(updated);
        if (selectedFolder === folderPath) setSelectedFolder(null);
        try {
            localStorage.setItem("devizee_custom_folders", JSON.stringify(updated));
        } catch { }
    };

    // Multi-Select Handlers
    const toggleSelect = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectAll = () => {
        setSelectedIds(new Set(displayedItems.map((x) => x.id)));
    };

    const deselectAll = () => {
        setSelectedIds(new Set());
    };

    const deleteSelected = () => {
        selectedIds.forEach((id) => {
            const item = history.find((h) => h.id === id);
            if (item) handleDeleteFile(item.id, item.file_path);
        });
        deselectAll();
    };

    const activeItemIsVideo = activePlayingItem ? isVideoFormat(activePlayingItem.format) : false;
    const displayScrubTime = isScrubbing ? scrubValue : currentTime;

    return (
        <div className="max-w-5xl xl:max-w-6xl mx-auto space-y-6">
            {/* Hidden Single HTML Audio Element for Audio Playback */}
            <audio
                ref={audioRef}
                preload="auto"
                crossOrigin="anonymous"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onTimeUpdate={() => {
                    if (audioRef.current && !isScrubbing) {
                        setCurrentTime(audioRef.current.currentTime);
                        setDuration(audioRef.current.duration || 0);
                    }
                }}
                onEnded={handleMediaEnded}
                className="hidden"
            />

            {/* ==================== 1. TOP HERO PLAYER (Image 3) ==================== */}
            {activePlayingItem && (
                <div className="bg-surface-1 rounded-2xl p-4 md:p-5 border border-border-subtle shadow-sm relative overflow-hidden animate-in fade-in duration-fast">
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
                        {/* LEFT: Compact Video / Art Box (~240px wide) */}
                        <div
                            ref={mediaContainerRef}
                            onWheel={handleWheelVolume}
                            onDoubleClick={(e) => {
                                if (!isFullscreen) return;
                                if ((e.target as HTMLElement).closest("[data-queue-drawer], button, input, select")) return;
                                e.stopPropagation();
                                toggleFullscreen();
                            }}
                            className={
                                isFullscreen
                                    ? "fixed inset-0 w-full h-full z-50 rounded-none border-0 bg-black flex items-center justify-center overflow-hidden group select-none aspect-auto"
                                    : "lg:col-span-3 aspect-video rounded-xl overflow-hidden bg-black relative flex items-center justify-center border border-border-subtle shadow-xs shrink-0 group"
                            }
                        >
                            <video
                                ref={videoRef}
                                preload="auto"
                                crossOrigin="anonymous"
                                playsInline
                                poster={getItemThumbnail(activePlayingItem, "hqdefault") || undefined}
                                onPlay={() => setIsPlaying(true)}
                                onPause={() => setIsPlaying(false)}
                                onLoadedData={() => {
                                    if (videoRef.current) {
                                        videoRef.current.volume = isMuted ? 0 : volume;
                                        attachEqualizerToMedia(videoRef.current);
                                    }
                                }}
                                onError={() => {
                                    if (activeItemIsVideo) {
                                        setVideoError("Playback failed or codec is not supported in built-in player.");
                                    }
                                }}
                                onTimeUpdate={() => {
                                    if (videoRef.current && !isScrubbing && activeItemIsVideo) {
                                        setCurrentTime(videoRef.current.currentTime);
                                        setDuration(videoRef.current.duration || 0);
                                    }
                                }}
                                onEnded={handleMediaEnded}
                                className={`w-full h-full cursor-pointer transition-all duration-200 ${
                                    !activeItemIsVideo ? "hidden" : videoFitMode === "cover" ? "object-cover" : "object-contain"
                                }`}
                                onClick={togglePlayPause}
                            >
                                {customSubtitleUrl && (
                                    <track
                                        key={customSubtitleUrl}
                                        src={customSubtitleUrl}
                                        kind="subtitles"
                                        label={customSubtitleName || "Subtitles"}
                                        default
                                    />
                                )}
                            </video>

                            {!activeItemIsVideo && (
                                getItemThumbnail(activePlayingItem, "hqdefault") ? (
                                    <img
                                        src={getItemThumbnail(activePlayingItem, "hqdefault")!}
                                        alt=""
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center bg-surface-2 text-accent">
                                        <Music size={28} />
                                        <span className="text-[10px] font-mono text-tertiary mt-1">
                                            {formatDisplayBadge(activePlayingItem.format)}
                                        </span>
                                    </div>
                                )
                            )}

                            {/* Video Playback Error Fallback Overlay */}
                            {videoError && (
                                <div className="absolute inset-0 z-30 bg-black/90 flex flex-col items-center justify-center p-4 text-center">
                                    <Film size={28} className="text-status-danger mb-2" />
                                    <p className="text-white text-caption font-semibold">{videoError}</p>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            openFile(activePlayingItem?.file_path);
                                        }}
                                        className="mt-3 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-caption font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                                    >
                                        <ExternalLink size={13} />
                                        <span>Open in System Player</span>
                                    </button>
                                </div>
                            )}

                            {/* Play Overlay if paused */}
                            {!isPlaying && !videoError && (
                                <button
                                    type="button"
                                    onClick={togglePlayPause}
                                    className="absolute inset-0 bg-black/40 flex items-center justify-center transition-colors cursor-pointer"
                                    title="Play"
                                >
                                    <div className="w-10 h-10 rounded-full bg-accent text-white flex items-center justify-center shadow-lg hover:scale-105 transition-transform pointer-events-none">
                                        <Play size={18} fill="currentColor" className="ml-0.5" />
                                    </div>
                                </button>
                            )}

                            {/* Subtitles Overlay Button */}
                            {activeItemIsVideo && !videoError && (
                                <button
                                    type="button"
                                    onClick={handleAddSubtitleTrack}
                                    className={`absolute top-2.5 right-12 w-8 h-8 rounded-lg ${customSubtitleUrl ? "bg-accent text-white" : "bg-black/60 hover:bg-black/85 text-white/90"} hover:scale-105 active:scale-95 backdrop-blur-md border border-white/20 flex items-center justify-center transition-all duration-200 opacity-0 group-hover:opacity-100 z-30 cursor-pointer shadow-md`}
                                    title={customSubtitleName ? `Subtitle: ${customSubtitleName}` : "Add Subtitles (.srt, .vtt)"}
                                >
                                    <Subtitles size={15} />
                                </button>
                            )}

                            {/* Aspect Ratio Toggle (Fit / Fill) in Fullscreen */}
                            {isFullscreen && activeItemIsVideo && !videoError && (
                                <button
                                    type="button"
                                    onClick={() => setVideoFitMode(videoFitMode === "contain" ? "cover" : "contain")}
                                    className={`absolute top-2.5 right-22 w-8 h-8 rounded-lg ${
                                        videoFitMode === "cover" ? "bg-accent text-white" : "bg-black/60 hover:bg-black/85 text-white/90"
                                    } hover:scale-105 active:scale-95 backdrop-blur-md border border-white/20 flex items-center justify-center transition-all duration-200 opacity-0 group-hover:opacity-100 z-30 cursor-pointer shadow-md`}
                                    title={videoFitMode === "cover" ? "Aspect: Fill Screen (Click for Fit/Letterbox)" : "Aspect: Fit Screen (Click to Fill & remove black bars)"}
                                >
                                    <Scaling size={15} />
                                </button>
                            )}

                            {/* Fullscreen Trigger Overlay for Video */}
                            {activeItemIsVideo && !videoError && (
                                <button
                                    type="button"
                                    onClick={toggleFullscreen}
                                    className="absolute top-2.5 right-2.5 w-8 h-8 rounded-lg bg-black/60 hover:bg-black/85 hover:scale-105 active:scale-95 text-white/90 hover:text-white backdrop-blur-md border border-white/20 flex items-center justify-center transition-all duration-200 opacity-0 group-hover:opacity-100 z-30 cursor-pointer shadow-md"
                                    title={isFullscreen ? "Exit Fullscreen (Esc or Double-Click)" : "Fullscreen Video"}
                                >
                                    {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                                </button>
                            )}

                            {/* Right-Side Upcoming Queue Drawer in Fullscreen */}
                            {isFullscreen && showNetflixDrawer && (
                                <div data-queue-drawer="true" className="absolute top-0 right-0 bottom-0 w-72 sm:w-80 bg-black/90 backdrop-blur-md z-50 p-4 border-l border-white/10 flex flex-col animate-in slide-in-from-right duration-fast">
                                    <div className="flex items-center justify-between pb-3 border-b border-white/10 mb-3 shrink-0">
                                        <div className="flex items-center gap-2">
                                            <ListMusic size={16} className="text-accent" />
                                            <span className="text-white font-bold text-caption">Upcoming Queue</span>
                                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/15 text-white/80 font-semibold">
                                                {upcomingQueue.length}
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setShowNetflixDrawer(false)}
                                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/15 text-white/70 hover:text-white transition-colors cursor-pointer"
                                            title="Close Queue"
                                        >
                                            <X size={15} />
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                                        {upcomingQueue.length === 0 ? (
                                            <div className="py-12 text-center text-white/50 text-caption">No videos in queue</div>
                                        ) : (
                                            upcomingQueue.map((qItem) => {
                                                const thumb = getItemThumbnail(qItem);
                                                const isActivelyPlaying = activePlayingItem?.id === qItem.id;
                                                return (
                                                    <div
                                                        key={qItem.id}
                                                        onClick={() => playMediaItem(qItem)}
                                                        className={`flex items-center gap-2.5 p-2 rounded-lg transition-all border cursor-pointer group/item ${
                                                            isActivelyPlaying
                                                                ? "bg-accent/25 hover:bg-accent/30 border-accent ring-1 ring-accent shadow-sm"
                                                                : "bg-white/5 hover:bg-white/15 border-white/10"
                                                        }`}
                                                    >
                                                        <div className="w-16 aspect-video rounded bg-black/80 overflow-hidden shrink-0 relative flex items-center justify-center">
                                                            {thumb ? (
                                                                <img src={thumb} alt="" className="w-full h-full object-cover" />
                                                            ) : isVideoFormat(qItem.format) ? (
                                                                <Film size={16} className={isActivelyPlaying ? "text-accent" : "text-white/40"} />
                                                            ) : (
                                                                <Music size={16} className={isActivelyPlaying ? "text-accent" : "text-white/40"} />
                                                            )}
                                                            {isActivelyPlaying && (
                                                                <div className="absolute inset-0 bg-accent/20 flex items-center justify-center">
                                                                    <Play size={12} fill="currentColor" className="text-white" />
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center justify-between gap-1">
                                                                <p className={`text-caption font-semibold truncate transition-colors ${
                                                                    isActivelyPlaying ? "text-accent font-bold" : "text-white group-hover/item:text-accent"
                                                                }`}>
                                                                    {qItem.title}
                                                                </p>
                                                                {isActivelyPlaying && (
                                                                    <span className="text-[9px] font-bold text-accent px-1.5 py-0.5 rounded bg-accent/20 shrink-0">
                                                                        Playing
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <span className="text-[10px] font-mono text-white/50">
                                                                {formatDisplayBadge(qItem.format)}
                                                            </span>
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Fullscreen Bottom Transport Controls Bar (Auto-Shows on Hover) */}
                            {isFullscreen && (
                                <div className="absolute bottom-0 inset-x-0 z-40 px-6 pt-2.5 pb-2 bg-gradient-to-t from-black/95 via-black/75 to-transparent flex flex-col gap-1.5 transition-opacity duration-300 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                                    {/* Fullscreen Scrubber */}
                                    <div className="flex items-center gap-3 w-full">
                                        <span className="text-[11px] font-mono text-white/70 w-12 text-left">
                                            {formatSeconds(displayScrubTime)}
                                        </span>
                                        <input
                                            type="range"
                                            min="0"
                                            max={duration || 100}
                                            step="0.5"
                                            value={displayScrubTime}
                                            onPointerDown={() => {
                                                setIsScrubbing(true);
                                                setScrubValue(currentTime);
                                            }}
                                            onChange={(e) => {
                                                setScrubValue(parseFloat(e.target.value));
                                            }}
                                            onPointerUp={(e) => {
                                                setIsScrubbing(false);
                                                handleSeek(parseFloat((e.target as HTMLInputElement).value));
                                            }}
                                            className="flex-1 h-1.5 rounded-full cursor-pointer accent-accent bg-white/20 transition-all hover:h-2"
                                        />
                                        <span className="text-[11px] font-mono text-white/70 w-12 text-right">
                                            {formatSeconds(duration || 0)}
                                        </span>
                                    </div>

                                    {/* Fullscreen Controls Row */}
                                    <div className="flex items-center justify-between gap-3">
                                        {/* Left: Prev, Play/Pause, Next, Volume */}
                                        <div className="flex items-center gap-2 sm:gap-3">
                                            <button
                                                type="button"
                                                onClick={handlePrev}
                                                className="p-2 text-white/80 hover:text-white hover:bg-white/15 rounded-lg transition-colors cursor-pointer"
                                                title="Previous Track"
                                            >
                                                <SkipBack size={18} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleSeek(Math.max(0, currentTime - 10))}
                                                className="p-1.5 text-white/80 hover:text-white hover:bg-white/15 rounded-lg transition-colors cursor-pointer flex items-center justify-center"
                                                title="Skip Back 10s"
                                            >
                                                <RotateCcw size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={togglePlayPause}
                                                className="w-10 h-10 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer"
                                                title={isPlaying ? "Pause" : "Play"}
                                            >
                                                {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleSeek(Math.min(duration || Infinity, currentTime + 10))}
                                                className="p-1.5 text-white/80 hover:text-white hover:bg-white/15 rounded-lg transition-colors cursor-pointer flex items-center justify-center"
                                                title="Skip Forward 10s"
                                            >
                                                <RotateCw size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleNext}
                                                className="p-2 text-white/80 hover:text-white hover:bg-white/15 rounded-lg transition-colors cursor-pointer"
                                                title="Next Track"
                                            >
                                                <SkipForward size={18} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const speeds = [1, 1.25, 1.5, 2, 0.75];
                                                    const nextIdx = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
                                                    setPlaybackSpeed(speeds[nextIdx]);
                                                }}
                                                className="px-2 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-white text-[11px] font-mono font-bold transition-colors cursor-pointer"
                                                title="Change Playback Speed"
                                            >
                                                {playbackSpeed}x
                                            </button>

                                            {/* Volume in Fullscreen */}
                                            <div className="flex items-center gap-1.5 ml-2 px-2 py-1 rounded-lg bg-white/10 backdrop-blur-sm border border-white/10">
                                                <button
                                                    type="button"
                                                    onClick={toggleMute}
                                                    className="text-white/80 hover:text-white transition-colors cursor-pointer"
                                                    title={isMuted ? "Unmute" : "Mute"}
                                                >
                                                    {isMuted || volume === 0 ? <VolumeX size={15} className="text-status-danger" /> : <Volume2 size={15} className="text-accent" />}
                                                </button>
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="1"
                                                    step="0.05"
                                                    value={isMuted ? 0 : volume}
                                                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                                                    className="w-16 sm:w-20 h-1.5 accent-accent cursor-pointer"
                                                />
                                            </div>
                                        </div>

                                        {/* Center: Title & Format */}
                                        <div className="hidden md:flex flex-col items-center min-w-0 max-w-md text-center">
                                            <p className="text-white text-caption font-bold truncate w-full" title={activePlayingItem?.title}>
                                                {activePlayingItem?.title}
                                            </p>
                                            <span className="text-[10px] font-mono text-white/60">
                                                {formatDisplayBadge(activePlayingItem?.format || "")}
                                            </span>
                                        </div>

                                        {/* Right: Shuffle, Repeat, Queue Drawer Toggle, Exit Fullscreen */}
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setIsShuffle(!isShuffle)}
                                                className={`p-2 rounded-lg transition-colors cursor-pointer ${isShuffle ? "text-accent bg-accent/20" : "text-white/70 hover:text-white hover:bg-white/15"
                                                    }`}
                                                title={isShuffle ? "Shuffle On" : "Shuffle Off"}
                                            >
                                                <Shuffle size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setRepeatMode(repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off")}
                                                className={`p-2 rounded-lg transition-colors cursor-pointer ${repeatMode !== "off" ? "text-accent bg-accent/20" : "text-white/70 hover:text-white hover:bg-white/15"
                                                    }`}
                                                title={`Repeat: ${repeatMode}`}
                                            >
                                                {repeatMode === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setVideoFitMode(videoFitMode === "contain" ? "cover" : "contain")}
                                                className={`p-2 rounded-lg transition-colors cursor-pointer ${
                                                    videoFitMode === "cover" ? "text-accent bg-accent/20" : "text-white/70 hover:text-white hover:bg-white/15"
                                                }`}
                                                title={videoFitMode === "cover" ? "Aspect: Fill Screen (Click for Fit/Letterbox)" : "Aspect: Fit Screen (Click to Fill & remove black bars)"}
                                            >
                                                <Scaling size={16} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setShowNetflixDrawer(!showNetflixDrawer)}
                                                className={`px-3 py-1.5 rounded-lg text-caption font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border ${showNetflixDrawer ? "bg-accent text-white border-accent" : "bg-white/15 hover:bg-white/25 text-white border-white/15"
                                                    }`}
                                                title="Toggle Queue"
                                            >
                                                <ListMusic size={15} />
                                                <span className="hidden sm:inline">Queue</span>
                                                <span className="text-[10px] font-mono opacity-80">({upcomingQueue.length})</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={toggleFullscreen}
                                                className="p-2 rounded-lg bg-white/15 hover:bg-white/25 text-white transition-colors cursor-pointer ml-1"
                                                title="Exit Fullscreen"
                                            >
                                                <Minimize2 size={16} />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* CENTER: Metadata, Waveform, Transport & Scrubber */}
                        <div className="lg:col-span-6 flex flex-col justify-between space-y-3 min-w-0 pr-0 lg:pr-2">
                            {/* Top Badge & Waveform */}
                            <div className="flex items-center gap-3">
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-accent-subtle text-accent text-[11px] font-bold shrink-0">
                                    {activeItemIsVideo ? <Film size={11} /> : <Music size={11} />}
                                    <span>Now Playing • {formatDisplayBadge(activePlayingItem.format)}</span>
                                </div>

                                <WaveformVisualizer
                                    mediaElement={activeItemIsVideo ? videoRef.current : audioRef.current}
                                    isPlaying={isPlaying}
                                    width={100}
                                    height={16}
                                />
                            </div>

                            {/* Title & Subtitle */}
                            <div className="min-w-0">
                                <h2 className="text-display font-extrabold text-primary truncate leading-tight tracking-tight" title={activePlayingItem.title}>
                                    {activePlayingItem.title}
                                </h2>
                                <p className="text-secondary text-caption font-medium truncate mt-0.5">
                                    Devizee Library • {formatFileSize(activePlayingItem.file_size)}
                                </p>
                            </div>

                            {/* Transport Controls Row with Volume Slider */}
                            <div className="flex flex-wrap items-center justify-between gap-3 py-1">
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setIsShuffle(!isShuffle)}
                                        className={`p-2 rounded-lg transition-colors cursor-pointer ${isShuffle ? "text-accent font-bold bg-accent-subtle" : "text-tertiary hover:text-primary"
                                            }`}
                                        title={isShuffle ? "Shuffle On" : "Shuffle Off"}
                                    >
                                        <Shuffle size={15} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handlePrev}
                                        className="p-2 text-secondary hover:text-primary hover:bg-surface-2 rounded-lg transition-all cursor-pointer"
                                        title="Previous Track"
                                    >
                                        <SkipBack size={18} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => handleSeek(Math.max(0, currentTime - 10))}
                                        className="p-1.5 text-secondary hover:text-primary hover:bg-surface-2 rounded-lg transition-all cursor-pointer flex items-center justify-center"
                                        title="Skip Back 10s"
                                    >
                                        <RotateCcw size={16} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={togglePlayPause}
                                        className="w-12 h-12 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center shadow-md transition-all hover:scale-105 active:scale-95 cursor-pointer"
                                        title={isPlaying ? "Pause" : "Play"}
                                    >
                                        {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => handleSeek(Math.min(duration || Infinity, currentTime + 10))}
                                        className="p-1.5 text-secondary hover:text-primary hover:bg-surface-2 rounded-lg transition-all cursor-pointer flex items-center justify-center"
                                        title="Skip Forward 10s"
                                    >
                                        <RotateCw size={16} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handleNext}
                                        className="p-2 text-secondary hover:text-primary hover:bg-surface-2 rounded-lg transition-all cursor-pointer"
                                        title="Next Track"
                                    >
                                        <SkipForward size={18} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            setRepeatMode(repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off");
                                        }}
                                        className={`p-2 rounded-lg transition-colors cursor-pointer ${repeatMode !== "off" ? "text-accent font-bold bg-accent-subtle" : "text-tertiary hover:text-primary"
                                            }`}
                                        title={`Repeat: ${repeatMode}`}
                                    >
                                        {repeatMode === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            const speeds = [1, 1.25, 1.5, 2, 0.75];
                                            const nextIdx = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
                                            setPlaybackSpeed(speeds[nextIdx]);
                                        }}
                                        className="px-2 py-1 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-primary text-[11px] font-mono font-bold transition-colors cursor-pointer shadow-2xs"
                                        title="Change Playback Speed"
                                    >
                                        {playbackSpeed}x
                                    </button>
                                </div>

                                {/* Persistent Media Volume Slider */}
                                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-2 border border-border-subtle shadow-2xs">
                                    <button
                                        type="button"
                                        onClick={toggleMute}
                                        className="text-secondary hover:text-primary transition-colors cursor-pointer"
                                        title={isMuted ? "Unmute" : "Mute"}
                                    >
                                        {isMuted || volume === 0 ? (
                                            <VolumeX size={14} className="text-status-danger" />
                                        ) : (
                                            <Volume2 size={14} className="text-accent" />
                                        )}
                                    </button>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={isMuted ? 0 : volume}
                                        onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                                        className="w-16 sm:w-20 h-1.5 accent-accent cursor-pointer rounded-lg"
                                        title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
                                    />
                                    <span className="text-[10px] font-mono text-tertiary w-6 text-right">
                                        {Math.round((isMuted ? 0 : volume) * 100)}%
                                    </span>
                                </div>
                            </div>

                            {/* Scrubber & Time */}
                            <div className="space-y-1">
                                <div className="flex items-center justify-between text-[11px] font-mono text-tertiary">
                                    <span>{formatSeconds(displayScrubTime)}</span>
                                    <span>{formatSeconds(duration || 0)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max={duration || 100}
                                    step="0.5"
                                    value={displayScrubTime}
                                    onPointerDown={() => {
                                        setIsScrubbing(true);
                                        setScrubValue(currentTime);
                                    }}
                                    onChange={(e) => {
                                        setScrubValue(parseFloat(e.target.value));
                                    }}
                                    onPointerUp={(e) => {
                                        setIsScrubbing(false);
                                        handleSeek(parseFloat((e.target as HTMLInputElement).value));
                                    }}
                                    className="w-full h-1.5 rounded-full cursor-pointer accent-accent bg-surface-2 transition-all"
                                />
                            </div>
                        </div>

                        {/* RIGHT: In-Hero Queue Panel */}
                        <div className="lg:col-span-3 border-t lg:border-t-0 lg:border-l border-border-subtle pt-3 lg:pt-0 lg:pl-4 space-y-2">
                            {/* Non-overlapping Queue Header with Integrated Close Button */}
                            <div className="flex items-center justify-between pb-1 border-b border-border-subtle/50">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-caption font-bold text-primary">Queue</span>
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-2 text-tertiary border border-border-subtle font-semibold">
                                        {upcomingQueue.length}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setDismissedQueueIds(new Set())}
                                        className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-2 text-tertiary hover:text-primary transition-colors cursor-pointer"
                                        title="Restore dismissed queue items"
                                    >
                                        <RotateCcw size={12} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={closePlayer}
                                        className="w-7 h-7 flex items-center justify-center rounded hover:bg-status-danger/15 hover:text-status-danger text-secondary transition-colors cursor-pointer"
                                        title="Close Hero Player"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            </div>

                            <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                                {upcomingQueue.length === 0 ? (
                                    <div className="py-6 text-center text-[11px] text-tertiary">
                                        Queue is empty
                                    </div>
                                ) : (
                                    upcomingQueue.map((item) => {
                                        const thumb = getItemThumbnail(item);
                                        const isVid = isVideoFormat(item.format);
                                        const isCurrentItem = activePlayingItem?.id === item.id;
                                        return (
                                            <div
                                                key={item.id}
                                                onClick={() => playMediaItem(item)}
                                                className={`flex items-center justify-between p-1.5 rounded-lg transition-colors cursor-pointer group ${isCurrentItem
                                                    ? "bg-accent/15 border border-accent/40 shadow-2xs"
                                                    : "bg-surface-2 hover:bg-surface-3"
                                                    }`}
                                            >
                                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                                    <div className="w-8 h-8 rounded-md bg-surface-1 overflow-hidden shrink-0 flex items-center justify-center border border-border-subtle/40">
                                                        {thumb ? (
                                                            <img
                                                                src={thumb}
                                                                alt=""
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : isVid ? (
                                                            <Film size={12} className="text-secondary" />
                                                        ) : (
                                                            <Music size={12} className="text-accent" />
                                                        )}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <p className={`text-caption font-semibold truncate leading-tight ${isCurrentItem ? "text-accent font-bold" : "text-primary"}`}>
                                                            {item.title}
                                                        </p>
                                                        <span className="text-[10px] font-mono text-tertiary">
                                                            {formatDisplayBadge(item.format)}
                                                        </span>
                                                    </div>
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={(e) => dismissQueueItem(item.id, e)}
                                                    className="w-6 h-6 flex items-center justify-center text-tertiary hover:text-status-danger rounded transition-colors ml-1 cursor-pointer shrink-0"
                                                    title="Remove from queue"
                                                >
                                                    <X size={12} />
                                                </button>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Folders Library Bar */}
            {customFolders.length > 0 && (
                <div className="bg-surface-1 p-3 rounded-xl border border-border-subtle shadow-2xs space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-caption font-bold text-secondary flex items-center gap-1.5">
                            <Folder size={14} className="text-accent" />
                            <span>Media Folders</span>
                        </span>
                        {selectedFolder && (
                            <button
                                type="button"
                                onClick={() => setSelectedFolder(null)}
                                className="text-[11px] font-semibold text-accent hover:underline cursor-pointer"
                            >
                                Reset to All Media
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setSelectedFolder(null)}
                            className={`px-3 py-1.5 rounded-lg text-caption font-semibold transition-all cursor-pointer border ${
                                selectedFolder === null
                                    ? "bg-accent text-white border-accent shadow-xs"
                                    : "bg-surface-2 text-secondary hover:text-primary hover:bg-surface-3 border-border-subtle"
                            }`}
                        >
                            All Folders ({allMediaItems.length})
                        </button>
                        {customFolders.map((folderPath) => {
                            const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
                            const count = allMediaItems.filter((m) => {
                                if (!m.file_path) return false;
                                return m.file_path.replace(/\\/g, "/").toLowerCase().startsWith(folderPath.replace(/\\/g, "/").toLowerCase());
                            }).length;
                            const isSelected = selectedFolder === folderPath;

                            return (
                                <div
                                    key={folderPath}
                                    onClick={() => setSelectedFolder(isSelected ? null : folderPath)}
                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-caption font-semibold transition-all cursor-pointer border shadow-2xs ${
                                        isSelected
                                            ? "bg-accent text-white border-accent shadow-xs"
                                            : "bg-surface-2 text-secondary hover:text-primary hover:bg-surface-3 border-border-subtle"
                                    }`}
                                    title={folderPath}
                                >
                                    <Folder size={13} className={isSelected ? "text-white" : "text-accent"} />
                                    <span>{folderName}</span>
                                    <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${isSelected ? "bg-white/20 text-white" : "bg-surface-3 text-tertiary"}`}>
                                        {count}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={(e) => handleRemoveFolder(folderPath, e)}
                                        className={`w-4 h-4 rounded flex items-center justify-center transition-colors cursor-pointer ${
                                            isSelected ? "hover:bg-white/20 text-white/80 hover:text-white" : "hover:bg-surface-3 text-tertiary hover:text-status-danger"
                                        }`}
                                        title="Remove folder from library"
                                    >
                                        <X size={11} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ==================== 2. CONTROL BAR (Filter Tabs, Search, Add Folder, View Mode) ==================== */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-surface-1 p-3 rounded-xl border border-border-subtle shadow-2xs">
                {/* Left: Filter Tabs */}
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => setMediaFilter("all")}
                        className={`px-3 py-1.5 rounded-lg text-caption font-bold transition-all cursor-pointer ${mediaFilter === "all"
                            ? "bg-accent text-white shadow-xs"
                            : "text-secondary hover:text-primary hover:bg-surface-2"
                            }`}
                    >
                        All Media ({allMediaItems.length})
                    </button>

                    <button
                        type="button"
                        onClick={() => setMediaFilter("videos")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-bold transition-all cursor-pointer ${mediaFilter === "videos"
                            ? "bg-accent text-white shadow-xs"
                            : "text-secondary hover:text-primary hover:bg-surface-2"
                            }`}
                    >
                        <Film size={13} />
                        <span>Videos ({videoCount})</span>
                    </button>

                    <button
                        type="button"
                        onClick={() => setMediaFilter("audios")}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-caption font-bold transition-all cursor-pointer ${mediaFilter === "audios"
                            ? "bg-accent text-white shadow-xs"
                            : "text-secondary hover:text-primary hover:bg-surface-2"
                            }`}
                    >
                        <Music size={13} />
                        <span>Audios ({audioCount})</span>
                    </button>
                </div>

                {/* Right: Search, Add Folder, Grid/List View Switcher */}
                <div className="flex items-center gap-2">
                    <div className="relative flex items-center">
                        <Search size={13} className="absolute left-2.5 text-tertiary pointer-events-none" />
                        <input
                            type="text"
                            placeholder="Search media..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="bg-surface-2 border border-border-subtle rounded-lg pl-8 pr-7 h-8 text-caption font-medium text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent w-36 sm:w-48"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery("")}
                                className="absolute right-2 text-tertiary hover:text-primary cursor-pointer"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>

                    {/* Add Folder Button */}
                    <button
                        type="button"
                        onClick={handleAddFolder}
                        className="h-8 px-2.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary border border-border-subtle text-caption font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
                        title="Add local media folder"
                    >
                        <FolderPlus size={13} className="text-accent" />
                        <span className="hidden sm:inline">Add Folder</span>
                    </button>

                    {/* Sort Dropdown */}
                    <div className="relative">
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as any)}
                            className="h-8 pl-2.5 pr-7 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold text-primary border border-border-subtle transition-colors cursor-pointer appearance-none outline-none focus:ring-1 focus:ring-accent shadow-2xs"
                            title="Sort media library"
                        >
                            <option value="date_desc" className="bg-surface-2 text-primary">Newest</option>
                            <option value="date_asc" className="bg-surface-2 text-primary">Oldest</option>
                            <option value="title" className="bg-surface-2 text-primary">Name</option>
                            <option value="size_desc" className="bg-surface-2 text-primary">Size</option>
                        </select>
                        <ArrowUpDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                    </div>

                    {/* View Switcher: Grid vs List */}
                    <div className="inline-flex p-0.5 rounded-lg bg-surface-2 border border-border-subtle">
                        <button
                            type="button"
                            onClick={() => setViewMode("grid")}
                            className={`p-1.5 rounded-md transition-all cursor-pointer ${viewMode === "grid"
                                ? "bg-surface-1 text-primary shadow-2xs"
                                : "text-tertiary hover:text-primary"
                                }`}
                            title="Gallery / Grid View"
                        >
                            <LayoutGrid size={14} />
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewMode("list")}
                            className={`p-1.5 rounded-md transition-all cursor-pointer ${viewMode === "list"
                                ? "bg-surface-1 text-primary shadow-2xs"
                                : "text-tertiary hover:text-primary"
                                }`}
                            title="List View"
                        >
                            <List size={14} />
                        </button>
                    </div>
                </div>
            </div>

            {/* ==================== 3. MULTI-SELECT TOOLBAR ==================== */}
            {selectedIds.size > 0 && (
                <div className="flex items-center justify-between p-3 bg-surface-2 rounded-xl border border-border-subtle animate-in fade-in duration-fast">
                    <span className="text-caption font-bold text-accent">
                        {selectedIds.size} of {displayedItems.length} media items selected
                    </span>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={selectAll}
                            className="px-2.5 py-1 rounded-lg bg-surface-1 hover:bg-surface-3 text-caption font-semibold text-primary border border-border-subtle transition-colors cursor-pointer"
                        >
                            Select All
                        </button>
                        <button
                            type="button"
                            onClick={deselectAll}
                            className="px-2.5 py-1 rounded-lg bg-surface-1 hover:bg-surface-3 text-caption font-semibold text-secondary transition-colors cursor-pointer"
                        >
                            Deselect All
                        </button>
                        <button
                            type="button"
                            onClick={deleteSelected}
                            className="px-3 py-1 rounded-lg bg-status-danger hover:bg-status-danger/90 text-white text-caption font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                        >
                            <Trash2 size={13} />
                            <span>Delete Selected</span>
                        </button>
                    </div>
                </div>
            )}

            {/* ==================== 4. MEDIA ITEMS DISPLAY (Grid vs. List) ==================== */}
            {displayedItems.length === 0 ? (
                <div className="py-20 text-center bg-surface-1 rounded-2xl border border-border-subtle space-y-3">
                    <div className="w-12 h-12 rounded-full bg-surface-2 mx-auto flex items-center justify-center text-tertiary">
                        {mediaFilter === "videos" ? <Film size={22} /> : <Music size={22} />}
                    </div>
                    <h3 className="text-body font-bold text-primary">No multimedia files found</h3>
                    <p className="text-secondary text-caption max-w-sm mx-auto">
                        Downloaded videos and audios will automatically appear here ready for playback and library management.
                    </p>
                </div>
            ) : viewMode === "grid" ? (
                /* GALLERY / GRID VIEW */
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {displayedItems.map((item) => {
                        const isVid = isVideoFormat(item.format);
                        const isSelected = selectedIds.has(item.id);
                        const isCurrentActive = activePlayingItem?.id === item.id;
                        const thumb = getItemThumbnail(item, "hqdefault");

                        return (
                            <div
                                key={item.id}
                                className={`group bg-surface-1 rounded-2xl border transition-all overflow-hidden flex flex-col justify-between shadow-2xs hover:shadow-raised ${isCurrentActive
                                    ? "ring-2 ring-accent border-accent"
                                    : isSelected
                                        ? "ring-1 ring-accent border-accent/60"
                                        : "border-border-subtle hover:border-border-strong"
                                    }`}
                            >
                                {/* Thumbnail Container */}
                                <div
                                    onClick={() => playMediaItem(item)}
                                    className="aspect-video w-full bg-surface-2 relative overflow-hidden cursor-pointer flex items-center justify-center"
                                >
                                    {thumb ? (
                                        <img
                                            src={thumb}
                                            alt=""
                                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                            onError={(e) => {
                                                e.currentTarget.style.display = "none";
                                            }}
                                        />
                                    ) : isVid ? (
                                        <Film size={28} className="text-tertiary" />
                                    ) : (
                                        <div className="w-12 h-12 rounded-full bg-accent-subtle text-accent flex items-center justify-center">
                                            <Music size={22} />
                                        </div>
                                    )}

                                    {/* Play Overlay */}
                                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                        <div className="w-10 h-10 rounded-full bg-accent text-white flex items-center justify-center shadow-floating">
                                            <Play size={16} fill="currentColor" className="ml-0.5" />
                                        </div>
                                    </div>

                                    {/* Format Badge */}
                                    <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/75 backdrop-blur-sm text-white font-mono text-[10px] font-semibold">
                                        {formatDisplayBadge(item.format)}
                                    </div>

                                    {/* Checkbox */}
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleSelect(item.id);
                                        }}
                                        className="absolute top-2 left-2 w-6 h-6 rounded-md bg-black/60 text-white flex items-center justify-center transition-colors cursor-pointer"
                                    >
                                        {isSelected ? <CheckSquare size={14} className="text-accent" /> : <Square size={14} />}
                                    </button>
                                </div>

                                {/* Body Information */}
                                <div className="p-3.5 space-y-2 flex-1 flex flex-col justify-between">
                                    <div>
                                        <h4
                                            onClick={() => playMediaItem(item)}
                                            className="text-body-sm font-bold text-primary line-clamp-2 cursor-pointer hover:text-accent transition-colors leading-snug"
                                            title={item.title}
                                        >
                                            {item.title}
                                        </h4>
                                        <div className="flex items-center gap-2 mt-1 text-[11px] font-mono text-tertiary">
                                            {item.file_size && item.file_size > 0 && (
                                                <span>{formatFileSize(item.file_size)}</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Action Bar */}
                                    <div className="flex items-center justify-between pt-2 border-t border-border-subtle/50">
                                        <button
                                            type="button"
                                            onClick={() => playMediaItem(item)}
                                            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent hover:bg-accent-hover text-white text-caption font-semibold transition-transform hover:scale-102 active:scale-98 shadow-xs cursor-pointer"
                                            title="Play in-app"
                                        >
                                            <Play size={10} fill="currentColor" />
                                            <span>Play</span>
                                        </button>

                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => openFolder(item.file_path)}
                                                className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                                                title="Reveal in Folder"
                                            >
                                                <Folder size={14} />
                                            </button>

                                            <button
                                                type="button"
                                                onClick={() => handleDeleteFile(item.id, item.file_path)}
                                                className="p-1.5 rounded-lg hover:bg-status-danger-subtle text-secondary hover:text-status-danger flex items-center justify-center transition-colors cursor-pointer"
                                                title="Delete file from disk"
                                            >
                                                <Trash2 size={14} />
                                            </button>

                                            <button
                                                type="button"
                                                onClick={() => openFile(item.file_path)}
                                                className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                                                title="Open in System Player"
                                            >
                                                <ExternalLink size={14} />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                /* LIST VIEW (Like Downloads Manager rows) */
                <div className="bg-surface-1 rounded-xl border border-border-subtle overflow-hidden">
                    {displayedItems.map((item) => {
                        const isVid = isVideoFormat(item.format);
                        const isSelected = selectedIds.has(item.id);
                        const isCurrentActive = activePlayingItem?.id === item.id;
                        const thumb = getItemThumbnail(item, "mqdefault");

                        return (
                            <div
                                key={item.id}
                                className={`flex items-center justify-between p-3 border-b border-border-subtle last:border-b-0 hover:bg-surface-2/40 transition-colors ${isCurrentActive ? "bg-accent-subtle/20" : ""
                                    }`}
                            >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelect(item.id)}
                                        className="w-3.5 h-3.5 rounded text-accent accent-accent cursor-pointer shrink-0"
                                    />

                                    {/* Thumbnail */}
                                    <div
                                        onClick={() => playMediaItem(item)}
                                        className="w-16 aspect-video rounded-md overflow-hidden bg-surface-2 shrink-0 relative flex items-center justify-center border border-border-subtle cursor-pointer group/item"
                                    >
                                        {thumb ? (
                                            <img
                                                src={thumb}
                                                alt=""
                                                className="w-full h-full object-cover"
                                            />
                                        ) : isVid ? (
                                            <Film size={16} className="text-secondary" />
                                        ) : (
                                            <Music size={16} className="text-accent" />
                                        )}
                                        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/item:opacity-100 flex items-center justify-center transition-opacity">
                                            <Play size={12} fill="white" className="text-white ml-0.5" />
                                        </div>
                                    </div>

                                    {/* Info */}
                                    <div className="min-w-0 flex-1 pr-2">
                                        <h4
                                            onClick={() => playMediaItem(item)}
                                            className="text-body-sm font-semibold truncate text-primary hover:text-accent cursor-pointer transition-colors"
                                            title={item.title}
                                        >
                                            {item.title}
                                        </h4>
                                        <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono text-tertiary">
                                            <span className="px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle text-secondary font-semibold">
                                                {formatDisplayBadge(item.format)}
                                            </span>
                                            {item.file_size && item.file_size > 0 && (
                                                <span>{formatFileSize(item.file_size)}</span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Always-Visible Actions matching Downloads Tab Design */}
                                <div className="flex items-center gap-1 shrink-0">
                                    <button
                                        type="button"
                                        onClick={() => openFolder(item.file_path)}
                                        className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                                        title="Open Folder"
                                    >
                                        <Folder size={15} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => handleDeleteFile(item.id, item.file_path)}
                                        className="p-1.5 rounded-lg hover:bg-status-danger-subtle text-secondary hover:text-status-danger flex items-center justify-center transition-colors cursor-pointer"
                                        title="Delete file"
                                    >
                                        <Trash2 size={15} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => openFile(item.file_path)}
                                        className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                                        title="Open in System Player"
                                    >
                                        <ExternalLink size={15} />
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => playMediaItem(item)}
                                        className="w-6 h-6 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center transition-transform hover:scale-105 active:scale-95 shadow-xs shrink-0 cursor-pointer ml-0.5"
                                        title="Play in-app"
                                    >
                                        <Play size={10} fill="currentColor" className="ml-0.5" />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
