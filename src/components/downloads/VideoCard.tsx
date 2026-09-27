import { useState, useRef } from "react";
import type { RefObject } from "react";
import {
    Calendar,
    CheckCircle2,
    Clock,
    Download,
    Film,
    Folder,
    Loader2,
    Maximize2,
    Minimize2,
    Moon,
    Music,
    Play,
    RotateCcw,
    RotateCw,
    Scissors,
    Volume2,
    VolumeX,
    X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { formatFileSize } from "../../lib/format";
import { WaveformVisualizer } from "../common/WaveformVisualizer";
import type { DownloadRecord, FormatOption, VideoInfo } from "../../types";
import type { TranslationKey } from "../../lib/i18n";

export type VideoManagerApi = {
    activeVideoPlaying: boolean;
    isVideoLoading: boolean;
    videoStreamUrl: string | null;
    videoFullscreen: boolean;
    videoContainerRef: RefObject<HTMLDivElement | null>;
    videoElementRef: RefObject<HTMLVideoElement | null>;
    iframeRef: RefObject<HTMLIFrameElement | null>;
    previewingId: string | null;
    isAudioElementPlaying: boolean;
    isLoadingAudioId: string | null;
    previewTime: number;
    previewDuration: number;
    audioRef: RefObject<HTMLAudioElement | null>;
    volume: number;
    isMuted: boolean;
    isTrimming: boolean;
    setIsTrimming: (v: boolean) => void;
    trimStart: string;
    setTrimStart: (v: string) => void;
    trimEnd: string;
    setTrimEnd: (v: string) => void;
    handlePlayVideo: (entry: { id: string; url: string; title: string; thumbnail: string; duration_string: string }) => void;
    handleVideoEnded: () => void;
    toggleFullscreen: () => void;
    handleCloseVideoPlayer: () => void;
    exitFullscreenAndKeepPlaying: () => void;
    sendIframeCommand: (func: string, args?: any[]) => void;
    toggleAudioPreview: (url: string, id: string) => void;
    handleSeek: (seconds: number) => void;
    handleSeekRelative: (offset: number) => void;
    toggleMute: () => void;
    handleVolumeChange: (newVol: number) => void;
    adjustTrimTimestamp: (currentVal: string, setter: (v: string) => void, delta: number) => void;
    handleStartDownload: (
        formatId: string,
        ext: string,
        isAudio: boolean,
        specificInfo?: any,
        formatLabel?: string,
        duplicateAction?: "overwrite" | "keep_both",
        customFolder?: string
    ) => Promise<void>;
    handleRetryDownload: (record: DownloadRecord) => void;
    openFile: (path: string | null) => void;
    formatSeconds: (secs: number) => string;
    setisAudioElementPlaying: (v: boolean) => void;
    setPreviewingId: (id: string | null) => void;
    transitionPlayback: (next: import("../../types").NowPlaying) => void;
    nowPlaying: import("../../types").NowPlaying;
    stopAudioPlayback: () => void;
    repeatMode: "off" | "all" | "one";
    cycleRepeatMode: () => void;
    audioShuffle: boolean;
    toggleAudioShuffle: () => void;
    audioNext: () => void;
    audioPrev: () => void;
    playlistInfo: import("../../types").PlaylistInfo | null;
    selectedPlaylistItems: Set<string>;
};

export function VideoCard({
    videoInfo,
    settings,
    selectedFormat,
    setSelectedFormat,
    activeCardTask,
    onDismissProgress,
    t: _t,
    vm,
    isAnalyzing = false,
    existingDownloads = [],
    onRevealInFolder,
    onOpenExistingFile,
}: {
    videoInfo: VideoInfo;
    settings: any;
    selectedFormat: FormatOption | null;
    setSelectedFormat: (f: FormatOption) => void;
    activeCardTask: DownloadRecord | null | undefined;
    onDismissProgress: () => void;
    t: (key: TranslationKey) => string;
    vm: VideoManagerApi;
    isAnalyzing?: boolean;
    /** W2-9: completed downloads already in the library for this URL */
    existingDownloads?: DownloadRecord[];
    /** W2-9: single-click handler for library chips — reveal in Explorer */
    onRevealInFolder?: (path: string | null) => void;
    /** W2-9: double-click handler for library chips — open in default player */
    onOpenExistingFile?: (path: string | null) => void;
}) {
    const {
        activeVideoPlaying,
        isVideoLoading,
        videoStreamUrl,
        videoFullscreen,
        videoContainerRef,
        videoElementRef,
        iframeRef,
        isAudioElementPlaying,
        previewingId,
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
        toggleMute,
        handleVolumeChange,
        adjustTrimTimestamp,
        handleStartDownload,
        stopAudioPlayback,
        transitionPlayback,
        nowPlaying,
        previewTime,
        previewDuration,
        audioRef,
        handleSeek,
        handleSeekRelative,
        formatSeconds,
    } = vm;

    const [isStartingDownload, setIsStartingDownload] = useState(false);
    const [customSaveFolder, setCustomSaveFolder] = useState<string | null>(null);

    const isAudioSelected = !!selectedFormat?.is_audio_only;
    const isAudioPreviewing = previewingId === videoInfo.id && isAudioElementPlaying;

    // Schedule Download State
    const [isScheduleOpen, setIsScheduleOpen] = useState(false);
    const [scheduleDateTime, setScheduleDateTime] = useState(() => {
        const d = new Date();
        d.setHours(d.getHours() + 1);
        d.setMinutes(0);
        const tzOffset = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
    });
    const [activeScheduleTime, setActiveScheduleTime] = useState<string | null>(null);
    const scheduleTimerRef = useRef<any>(null);

    const handleConfirmSchedule = () => {
        const target = new Date(scheduleDateTime);
        const delay = target.getTime() - Date.now();
        if (delay <= 0) {
            onDownloadClick();
            setIsScheduleOpen(false);
            return;
        }

        const timeLabel = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
        setActiveScheduleTime(timeLabel);
        setIsScheduleOpen(false);

        clearTimeout(scheduleTimerRef.current);
        scheduleTimerRef.current = setTimeout(async () => {
            try {
                await onDownloadClick();
            } catch (e) {
                console.error("Scheduled download failed:", e);
            }
            setActiveScheduleTime(null);
        }, delay);
    };

    const handleCancelSchedule = () => {
        clearTimeout(scheduleTimerRef.current);
        setActiveScheduleTime(null);
    };

    const setSchedulePreset = (offsetHours: number, fixedHour?: number) => {
        const d = new Date();
        if (fixedHour !== undefined) {
            if (d.getHours() >= fixedHour) {
                d.setDate(d.getDate() + 1);
            }
            d.setHours(fixedHour, 0, 0, 0);
        } else {
            d.setHours(d.getHours() + offsetHours);
        }
        const tzOffset = d.getTimezoneOffset() * 60000;
        setScheduleDateTime(new Date(d.getTime() - tzOffset).toISOString().slice(0, 16));
    };

    const handleBrowseCustomFolder = async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                defaultPath: customSaveFolder || settings.saveFolder,
            });
            if (selected && typeof selected === "string") {
                setCustomSaveFolder(selected);
            }
        } catch (err) {
            console.error("Browse destination folder error:", err);
        }
    };

    const onDownloadClick = async () => {
        setIsStartingDownload(true);
        try {
            const fmtId = selectedFormat?.format_id || "best";
            const ext = selectedFormat?.ext || (isAudioSelected ? "mp3" : "mp4");
            const isAud = !!selectedFormat?.is_audio_only;
            const label = selectedFormat?.label || (isAud ? "Audio (MP3)" : "Best Video");
            await handleStartDownload(fmtId, ext, isAud, videoInfo, label, undefined, customSaveFolder || undefined);
        } finally {
            setIsStartingDownload(false);
        }
    };

    const currentDestination = customSaveFolder || (
        isAudioSelected
            ? (settings.audioFolder || (settings.saveFolder ? `${settings.saveFolder}/Music` : "Downloads/Devizee/Music"))
            : (settings.videoFolder || (settings.saveFolder ? `${settings.saveFolder}/Videos` : "Downloads/Devizee/Videos"))
    );
    const displayFolder = currentDestination.length > 32
        ? "..." + currentDestination.slice(-28)
        : currentDestination;

    return (
        <div className="bg-surface-1 rounded-2xl p-5 border border-border-subtle relative overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-fast shadow-sm space-y-4">
            {/* 2-Column Inspector Layout: col-span-5 for video, col-span-7 for settings */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* COLUMN 1: Visual Media Inspection Box & Audio Preview */}
                <div className="lg:col-span-5 space-y-3">
                    <div
                        ref={videoContainerRef}
                        onPointerDown={() => stopAudioPlayback()}
                        onWheel={(e) => {
                            if ((e.target as HTMLElement)?.closest('[data-queue-drawer="true"]')) {
                                return;
                            }
                            e.preventDefault();
                            if (e.deltaY < 0) {
                                handleVolumeChange(Math.min(1, volume + 0.05));
                            } else if (e.deltaY > 0) {
                                handleVolumeChange(Math.max(0, volume - 0.05));
                            }
                        }}
                        className="aspect-video rounded-xl overflow-hidden bg-black shrink-0 relative shadow-sm group border border-border-subtle/60"
                    >
                        {activeVideoPlaying ? (
                            <div className="w-full h-full relative flex items-center justify-center bg-black">
                                {isVideoLoading ? (
                                    <div className="flex flex-col items-center gap-2 text-white text-caption">
                                        <Loader2 size={24} className="animate-spin text-accent" />
                                        <span className="font-semibold tracking-wide">Loading Video...</span>
                                    </div>
                                ) : videoStreamUrl ? (
                                    <video
                                        ref={videoElementRef}
                                        src={videoStreamUrl}
                                        controls
                                        autoPlay
                                        crossOrigin="anonymous"
                                        onEnded={handleVideoEnded}
                                        onPlay={() => {
                                            stopAudioPlayback();
                                            transitionPlayback({ type: "video", id: videoInfo.id, state: "playing" });
                                        }}
                                        onPause={() => {
                                            if (nowPlaying.type === "video") {
                                                transitionPlayback({ type: "video", id: videoInfo.id, state: "paused" });
                                            }
                                        }}
                                        className="w-full h-full object-contain"
                                    />
                                ) : (
                                    /* Interactive YouTube Player Perfectly Centered */
                                    <div className="w-full h-full relative overflow-hidden bg-black flex items-center justify-center group/yt">
                                        <iframe
                                            ref={iframeRef}
                                            src={`https://www.youtube.com/embed/${videoInfo.id}?enablejsapi=1&autoplay=1&rel=0&modestbranding=1&playsinline=1&controls=1`}
                                            title={videoInfo.title}
                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                                            allowFullScreen
                                            onLoad={() => {
                                                const effective = isMuted ? 0 : volume;
                                                sendIframeCommand("setVolume", [Math.round(effective * 100)]);
                                                if (isMuted || effective === 0) {
                                                    sendIframeCommand("mute");
                                                } else {
                                                    sendIframeCommand("unMute");
                                                }
                                            }}
                                            className="w-full h-full border-0 aspect-video object-contain"
                                        />
                                    </div>
                                )}

                                {/* Top Floating Window Controls (Fullscreen & Close only, no duplicate mute overlay) */}
                                <div className="absolute top-2 right-2 flex items-center gap-1.5 z-30 bg-black/75 backdrop-blur-md p-1 rounded-lg border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        type="button"
                                        onClick={toggleFullscreen}
                                        className="w-7 h-7 rounded-md bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
                                        title={videoFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                                    >
                                        {videoFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (videoFullscreen) exitFullscreenAndKeepPlaying();
                                            else handleCloseVideoPlayer();
                                        }}
                                        className="w-7 h-7 rounded-md bg-white/10 hover:bg-status-danger/80 text-white flex items-center justify-center transition-colors cursor-pointer"
                                        title="Close Video Preview"
                                    >
                                        <X size={13} />
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* Clean Poster Thumbnail with Click-To-Play Overlay */
                            <div
                                className="w-full h-full relative cursor-pointer"
                                onClick={() => handlePlayVideo(videoInfo)}
                                title="Click to inspect video in-app"
                            >
                                <img
                                    src={videoInfo.thumbnail}
                                    alt="Thumbnail"
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                    onError={(e) => {
                                        e.currentTarget.src = `https://i.ytimg.com/vi/${videoInfo.id}/hqdefault.jpg`;
                                    }}
                                />
                                <div className="absolute inset-0 bg-black/20 group-hover:bg-black/35 flex items-center justify-center transition-colors">
                                    <div className="w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center shadow-floating group-hover:scale-110 transition-transform">
                                        <Play size={20} fill="currentColor" className="ml-0.5" />
                                    </div>
                                </div>
                                <div className="absolute bottom-2 right-2 bg-black/80 text-white font-mono text-[10px] px-2 py-0.5 rounded-md shadow-sm">
                                    {videoInfo.duration_string}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Title, Channel & Play Audio Preview Bar with Volume Slider */}
                    <div>
                        <h3 className="text-body font-bold leading-snug line-clamp-2 text-primary" title={videoInfo.title}>
                            {videoInfo.title}
                        </h3>
                        <p className="text-secondary text-caption truncate mt-0.5 font-medium">{videoInfo.uploader}</p>

                        <div className="flex flex-wrap items-center justify-between gap-2.5 mt-3 pt-2.5 border-t border-border-subtle/50">
                            {/* Bandwidth Saver: Play Audio Only Preview Button */}
                            <div className="flex flex-col items-start gap-1">
                                <button
                                    type="button"
                                    onClick={() => toggleAudioPreview(videoInfo.url, videoInfo.id)}
                                    className={`px-3 py-1.5 rounded-lg text-caption font-semibold flex items-center gap-1.5 transition-all shadow-2xs cursor-pointer border ${isAudioPreviewing
                                        ? "bg-accent text-white border-accent ring-1 ring-accent"
                                        : "bg-surface-2 hover:bg-surface-3 text-primary border-border-subtle hover:border-accent/40"
                                        }`}
                                    title="Stream lightweight audio only to check contents and save network bandwidth"
                                >
                                    {isAudioPreviewing ? (
                                        <>
                                            <VolumeX size={13} className="text-white animate-pulse" />
                                            <span>Stop Audio Preview</span>
                                        </>
                                    ) : (
                                        <>
                                            <Volume2 size={13} className="text-accent" />
                                            <span>Play Audio Preview</span>
                                        </>
                                    )}
                                </button>

                                <span className="text-[10px] text-tertiary flex items-center gap-1 font-medium pl-0.5 select-none">
                                    <span className="text-accent font-bold">!</span> Data Saver
                                </span>
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
                                        <VolumeX size={13} className="text-status-danger" />
                                    ) : (
                                        <Volume2 size={13} className="text-accent" />
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

                        {/* Audio Preview Transport Controls & Scrubber (Matching Playlist Panel) */}
                        {isAudioPreviewing && (
                            <div className="mt-3 p-3 rounded-xl bg-surface-2/70 border border-border-subtle space-y-2 animate-in fade-in duration-fast">
                                <div className="flex items-center justify-between text-caption text-secondary font-mono text-[10px]">
                                    <span className="flex items-center gap-1.5 text-accent font-semibold">
                                        <Volume2 size={12} className="animate-pulse" />
                                        <span>Playing Audio Preview</span>
                                        <WaveformVisualizer
                                            mediaElement={audioRef.current}
                                            isPlaying={isAudioElementPlaying}
                                        />
                                    </span>
                                    <span className="font-bold text-primary">
                                        {formatSeconds(previewTime)} / {formatSeconds(previewDuration || 0)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max={previewDuration || 100}
                                    step="0.5"
                                    value={previewTime}
                                    onChange={(e) => handleSeek(parseFloat(e.target.value))}
                                    className="w-full h-1 cursor-pointer rounded-full outline-none appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:-mt-1"
                                    style={{
                                        background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${(previewTime / Math.max(1, previewDuration)) * 100}%, var(--color-surface-3) ${(previewTime / Math.max(1, previewDuration)) * 100}%, var(--color-surface-3) 100%)`,
                                    }}
                                />
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => handleSeekRelative(-10)}
                                            className="text-[10px] text-secondary hover:text-primary flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-1 border border-border-subtle cursor-pointer hover:border-accent/30 transition-colors"
                                        >
                                            <RotateCcw size={10} /> -10s
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleSeekRelative(10)}
                                            className="text-[10px] text-secondary hover:text-primary flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-1 border border-border-subtle cursor-pointer hover:border-accent/30 transition-colors"
                                        >
                                            +10s <RotateCw size={10} />
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            stopAudioPlayback();
                                            transitionPlayback({ type: "none" });
                                        }}
                                        className="text-[10px] text-secondary hover:text-status-danger transition-colors cursor-pointer"
                                    >
                                        Dismiss Audio
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* COLUMN 2: Apple-HIG "Configure & Go" Settings Panel */}
                <div className="lg:col-span-7 space-y-4 lg:border-l border-border-subtle lg:pl-6">
                    {/* Header */}
                    <div className="flex items-center justify-between pb-2.5 border-b border-border-subtle/60">
                        <div>
                            <h4 className="text-body-sm font-bold text-primary">Configure & Go</h4>
                            <p className="text-[11px] text-tertiary">Select media type, quality tier & destination</p>
                        </div>
                        <span className="text-[11px] font-mono font-medium text-tertiary px-2 py-0.5 rounded bg-surface-2 border border-border-subtle">
                            {videoInfo.duration_string}
                        </span>
                    </div>

                    {/* Section 1: Video Resolutions */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <label className="text-[10px] uppercase font-bold tracking-wider text-tertiary">
                                🎬 Video Formats (HD / 4K)
                            </label>
                            {!isAudioSelected && selectedFormat && (
                                <span className="text-[11px] text-accent font-semibold">Active: {selectedFormat.label}</span>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {isAnalyzing || !videoInfo.video_formats || videoInfo.video_formats.length === 0 ? (
                                <div className="flex items-center gap-2 py-1">
                                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 text-secondary text-caption border border-border-subtle animate-pulse">
                                        <Loader2 size={12} className="animate-spin text-accent" />
                                        <span>Analyzing video resolutions...</span>
                                    </div>
                                    <div className="h-7 w-16 rounded-lg bg-surface-2/50 animate-pulse border border-border-subtle/40" />
                                    <div className="h-7 w-16 rounded-lg bg-surface-2/50 animate-pulse border border-border-subtle/40" />
                                </div>
                            ) : (
                                <>
                                    {videoInfo.video_formats.slice(0, 4).map((f) => {
                                        const isSelected = selectedFormat?.format_id === f.format_id && !selectedFormat?.is_audio_only;
                                        return (
                                            <button
                                                key={f.format_id + f.label}
                                                type="button"
                                                onClick={() => setSelectedFormat(f)}
                                                className={`px-3 py-1.5 rounded-lg text-caption font-semibold transition-all border cursor-pointer ${isSelected
                                                    ? "bg-accent/15 text-accent border-accent ring-2 ring-accent/40 font-bold shadow-xs"
                                                    : "bg-surface-2 text-primary border-border-subtle hover:border-accent/40 hover:bg-surface-3"
                                                    }`}
                                                title={`Download video in ${f.label}`}
                                            >
                                                {f.label}
                                            </button>
                                        );
                                    })}

                                    {videoInfo.video_formats.length > 4 && (() => {
                                        const isDropdownSelected = !selectedFormat?.is_audio_only &&
                                            videoInfo.video_formats.slice(4).some(x => x.format_id === selectedFormat?.format_id);
                                        return (
                                            <select
                                                value={isDropdownSelected ? selectedFormat?.format_id : ""}
                                                onChange={(e) => {
                                                    const f = videoInfo.video_formats?.find(x => x.format_id === e.target.value);
                                                    if (f) setSelectedFormat(f);
                                                }}
                                                className={`px-2.5 py-1.5 rounded-lg text-caption font-medium outline-none cursor-pointer border ${isDropdownSelected
                                                    ? "bg-accent/15 text-accent border-accent ring-2 ring-accent/40 font-bold"
                                                    : "bg-surface-2 text-primary border-border-subtle hover:border-accent/40"
                                                    }`}
                                                title="Select more video resolutions"
                                            >
                                                <option value="" disabled>More Resolutions...</option>
                                                {videoInfo.video_formats.slice(4).map(f => (
                                                    <option key={f.format_id + f.label} value={f.format_id} className="bg-surface-1 text-primary">
                                                        {f.label}
                                                    </option>
                                                ))}
                                            </select>
                                        );
                                    })()}
                                </>
                            )}
                        </div>
                    </div>

                    {/* Divider between Video and Audio */}
                    <div className="border-t border-border-subtle/50 my-1" />

                    {/* Section 2: Audio Extraction Formats */}
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <label className="text-[10px] uppercase font-bold tracking-wider text-tertiary">
                                🎵 Audio Formats (Audio Extraction)
                            </label>
                            {isAudioSelected && selectedFormat && (
                                <span className="text-[11px] text-accent font-semibold">Active: {selectedFormat.label}</span>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {isAnalyzing ? (
                                <div className="flex items-center gap-2 py-1">
                                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 text-secondary text-caption border border-border-subtle animate-pulse">
                                        <Loader2 size={12} className="animate-spin text-accent" />
                                        <span>Probing audio streams...</span>
                                    </div>
                                    <div className="h-7 w-16 rounded-lg bg-surface-2/50 animate-pulse border border-border-subtle/40" />
                                </div>
                            ) : (
                                (videoInfo.audio_formats && videoInfo.audio_formats.length > 0
                                    ? videoInfo.audio_formats
                                    : [
                                        { format_id: "bestaudio/best", label: "MP3 (320 kbps)", ext: "mp3", is_audio_only: true, resolution: null, filesize_approx: null },
                                        { format_id: "bestaudio/best", label: "M4A (256 kbps AAC)", ext: "m4a", is_audio_only: true, resolution: null, filesize_approx: null },
                                        { format_id: "bestaudio/best", label: "FLAC (Lossless)", ext: "flac", is_audio_only: true, resolution: null, filesize_approx: null },
                                        { format_id: "bestaudio/best", label: "WAV (Uncompressed)", ext: "wav", is_audio_only: true, resolution: null, filesize_approx: null },
                                    ]
                                ).slice(0, 4).map((f) => {
                                    const isSelected = !!selectedFormat?.is_audio_only && (selectedFormat.ext?.toLowerCase() === f.ext?.toLowerCase());
                                    return (
                                        <button
                                            key={f.format_id + f.label + f.ext}
                                            type="button"
                                            onClick={() => setSelectedFormat(f)}
                                            className={`px-3 py-1.5 rounded-lg text-caption font-semibold transition-all border cursor-pointer ${isSelected
                                                ? "bg-accent/15 text-accent border-accent ring-2 ring-accent/40 font-bold shadow-xs"
                                                : "bg-surface-2 text-primary border-border-subtle hover:border-accent/40 hover:bg-surface-3"
                                                }`}
                                            title={`Extract audio stream as ${f.label}`}
                                        >
                                            🎵 {f.label}
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>

                    {/* W2-9: Already in Library row */}
                    {existingDownloads.length > 0 && (
                        <div className="p-2.5 rounded-xl bg-status-success-subtle/30 border border-status-success/30 space-y-1.5">
                            <div className="flex items-center gap-1.5">
                                <CheckCircle2 size={12} className="text-status-success" />
                                <span className="text-[10px] uppercase font-bold tracking-wider text-status-success">
                                    Already in library
                                </span>
                                <span className="text-[10px] text-tertiary">
                                    · {existingDownloads.length} {existingDownloads.length === 1 ? "copy" : "copies"}
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {existingDownloads.map((rec) => {
                                    const isAudio = rec.format.toLowerCase().includes("mp3")
                                        || rec.format.toLowerCase().includes("m4a")
                                        || rec.format.toLowerCase().includes("flac")
                                        || rec.format.toLowerCase().includes("opus")
                                        || rec.format.toLowerCase().includes("wav");
                                    const shortFormat = rec.format
                                        .replace(/\s*\(.*?\)\s*/g, "")
                                        .replace(/\[.*?\]/g, "")
                                        .trim()
                                        .slice(0, 24);
                                    const sizeLabel = rec.file_size
                                        ? formatFileSize(rec.file_size)
                                        : "size unknown";
                                    const dateLabel = rec.date_added
                                        ? new Date(rec.date_added * 1000).toLocaleDateString(undefined, {
                                            month: "short",
                                            day: "numeric",
                                        })
                                        : "—";
                                    return (
                                        <button
                                            key={rec.id}
                                            type="button"
                                            onClick={(e) => {
                                                // Defer single-click 250ms so a double-click can cancel it
                                                const target = e.currentTarget;
                                                const path = rec.file_path;
                                                const timer = window.setTimeout(() => {
                                                    onRevealInFolder?.(path);
                                                    delete (target as any).__pendingClickTimer;
                                                }, 250);
                                                (target as any).__pendingClickTimer = timer;
                                            }}
                                            onDoubleClick={(e) => {
                                                const target = e.currentTarget;
                                                const pending = (target as any).__pendingClickTimer;
                                                if (pending) {
                                                    clearTimeout(pending);
                                                    delete (target as any).__pendingClickTimer;
                                                }
                                                onOpenExistingFile?.(rec.file_path);
                                            }}
                                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-1 hover:bg-surface-2 border border-status-success/30 hover:border-status-success/60 text-caption transition-colors cursor-pointer shadow-2xs group/chip"
                                            title={`${rec.file_path || "path unknown"}\n\nClick to reveal in Explorer · Double-click to open`}
                                        >
                                            {isAudio ? (
                                                <Music size={11} className="text-accent shrink-0" />
                                            ) : (
                                                <Film size={11} className="text-accent shrink-0" />
                                            )}
                                            <span className="font-semibold text-primary">
                                                {shortFormat || rec.format}
                                            </span>
                                            <span className="text-tertiary">·</span>
                                            <span className="font-mono text-[10px] text-tertiary">
                                                {sizeLabel}
                                            </span>
                                            <span className="text-tertiary">·</span>
                                            <span className="font-mono text-[10px] text-tertiary">
                                                {dateLabel}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {/* Row 3: Destination Folder Selector & Clip Trimmer Button */}
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center pt-1">
                        {/* Destination Folder */}
                        <div className="sm:col-span-9 space-y-1">
                            <label className="text-[10px] uppercase font-bold tracking-wider text-tertiary">Destination</label>
                            <button
                                type="button"
                                onClick={handleBrowseCustomFolder}
                                className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-surface-2 hover:bg-surface-3 border border-border-subtle text-caption transition-all text-left group cursor-pointer shadow-2xs"
                                title="Click to choose a custom save folder for this specific file"
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <Folder size={14} className="text-accent shrink-0" />
                                    <span className="truncate font-medium text-primary">
                                        {displayFolder}
                                    </span>
                                </div>
                                <span className="px-2.5 py-1 rounded-lg bg-surface-3 hover:bg-accent text-primary hover:text-white border border-border-subtle font-bold text-[11px] shadow-2xs transition-colors shrink-0 ml-2">
                                    Change...
                                </span>
                            </button>
                        </div>

                        {/* Clip Trimmer Action */}
                        <div className="sm:col-span-3 space-y-1">
                            <label className="text-[10px] uppercase font-bold tracking-wider text-tertiary">Trim Section</label>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsTrimming(!isTrimming);
                                    if (!trimEnd && videoInfo.duration_string !== "--:--") {
                                        setTrimEnd(videoInfo.duration_string);
                                    }
                                }}
                                className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-caption font-bold transition-all cursor-pointer shadow-2xs ${isTrimming
                                    ? "bg-accent text-white border-accent shadow-xs"
                                    : "bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary border-border-subtle"
                                    }`}
                                title="Trim video segment before downloading without fetching full video"
                            >
                                <Scissors size={14} />
                                <span className="truncate">{isTrimming ? "Trimming On" : "Clip Trimmer"}</span>
                            </button>
                        </div>
                    </div>

                    {/* Optional Trimming Bar */}
                    {isTrimming && (
                        <div className="p-3 bg-surface-2/60 rounded-xl border border-border-subtle space-y-2 animate-in fade-in duration-fast">
                            <div className="flex items-center justify-between text-caption font-semibold text-primary">
                                <span className="flex items-center gap-1 text-accent">
                                    <Scissors size={13} />
                                    <span>Download Specific Section</span>
                                </span>
                                <span className="text-[11px] font-mono text-tertiary">HH:MM:SS</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex-1 space-y-1">
                                    <label className="text-[10px] uppercase font-bold text-tertiary">Start Time</label>
                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => adjustTrimTimestamp(trimStart, setTrimStart, -5)}
                                            className="px-1.5 py-1 rounded bg-surface-3 text-[10px] font-mono text-secondary hover:text-primary"
                                        >
                                            -5s
                                        </button>
                                        <input
                                            type="text"
                                            value={trimStart}
                                            onChange={(e) => setTrimStart(e.target.value)}
                                            className="w-full bg-surface-1 border border-border-subtle rounded-md px-2 py-1 text-caption font-mono text-primary text-center outline-none focus:border-accent"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => adjustTrimTimestamp(trimStart, setTrimStart, 5)}
                                            className="px-1.5 py-1 rounded bg-surface-3 text-[10px] font-mono text-secondary hover:text-primary"
                                        >
                                            +5s
                                        </button>
                                    </div>
                                </div>

                                <div className="flex-1 space-y-1">
                                    <label className="text-[10px] uppercase font-bold text-tertiary">End Time</label>
                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => adjustTrimTimestamp(trimEnd, setTrimEnd, -5)}
                                            className="px-1.5 py-1 rounded bg-surface-3 text-[10px] font-mono text-secondary hover:text-primary"
                                        >
                                            -5s
                                        </button>
                                        <input
                                            type="text"
                                            value={trimEnd}
                                            onChange={(e) => setTrimEnd(e.target.value)}
                                            className="w-full bg-surface-1 border border-border-subtle rounded-md px-2 py-1 text-caption font-mono text-primary text-center outline-none focus:border-accent"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => adjustTrimTimestamp(trimEnd, setTrimEnd, 5)}
                                            className="px-1.5 py-1 rounded bg-surface-3 text-[10px] font-mono text-secondary hover:text-primary"
                                        >
                                            +5s
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Active Scheduled Download Banner */}
                    {activeScheduleTime && (
                        <div className="p-3 bg-accent/10 border border-accent/30 rounded-xl text-caption font-semibold flex items-center justify-between text-accent animate-in fade-in">
                            <div className="flex items-center gap-2">
                                <Clock size={15} />
                                <span>Scheduled to start on {activeScheduleTime}</span>
                            </div>
                            <button
                                type="button"
                                onClick={handleCancelSchedule}
                                className="text-[11px] px-2.5 py-1 rounded-md bg-surface-1 text-secondary hover:text-status-danger border border-border-subtle cursor-pointer transition-colors"
                            >
                                Cancel Schedule
                            </button>
                        </div>
                    )}

                    {/* Primary Download Action Row */}
                    <div className="flex items-center gap-2 pt-1">
                        <button
                            type="button"
                            onClick={onDownloadClick}
                            disabled={isStartingDownload}
                            className="flex-1 py-3 px-4 rounded-xl bg-accent hover:bg-accent-hover text-white font-bold text-body-sm shadow-md transition-all active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            title={isAudioSelected ? "Extract audio stream now" : "Download full video stream now"}
                        >
                            {isStartingDownload ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : isAudioSelected ? (
                                <Music size={16} />
                            ) : (
                                <Download size={16} strokeWidth={2.5} />
                            )}
                            <span>
                                {isStartingDownload
                                    ? "Starting Download..."
                                    : isAudioSelected
                                        ? `Download Audio (${selectedFormat?.label || "MP3"})`
                                        : `Download Video (${selectedFormat?.label || "Best Quality"})`}
                            </span>
                        </button>

                        <button
                            type="button"
                            onClick={() => setIsScheduleOpen(true)}
                            disabled={isStartingDownload}
                            className={`px-3.5 py-3 rounded-xl border transition-all cursor-pointer shadow-2xs shrink-0 flex items-center justify-center ${activeScheduleTime
                                ? "bg-accent text-white border-accent"
                                : "bg-surface-2 hover:bg-surface-3 border-border-subtle text-secondary hover:text-accent"
                                }`}
                            title="Schedule Download (Night Mode / Off-Peak Queue)"
                        >
                            <Moon size={16} />
                        </button>
                    </div>

                    {/* Active Download Progress Card (if actively running) */}
                    {activeCardTask && (
                        <div className="p-3 bg-surface-2 rounded-xl border border-border-subtle space-y-2">
                            <div className="flex items-center justify-between text-caption font-semibold">
                                <span className="flex items-center gap-1.5 text-primary">
                                    <Clock size={13} className="text-accent" />
                                    <span>Task Status: {activeCardTask.status}</span>
                                </span>
                                <span className="font-mono text-accent">{activeCardTask.percent}%</span>
                            </div>
                            <div className="w-full bg-surface-3 rounded-full h-1.5 overflow-hidden">
                                <div
                                    className="bg-accent h-full transition-all duration-300"
                                    style={{ width: `${Math.min(100, Math.max(0, activeCardTask.percent))}%` }}
                                />
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-tertiary">
                                <span>{activeCardTask.speed || "Calculating..."}</span>
                                <button
                                    type="button"
                                    onClick={onDismissProgress}
                                    className="text-secondary hover:text-primary cursor-pointer"
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Schedule Download Modal */}
            {isScheduleOpen && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-fast">
                    <div className="bg-surface-1 border border-border-subtle rounded-2xl p-6 max-w-md w-full shadow-floating space-y-4">
                        <div className="flex items-center justify-between pb-2 border-b border-border-subtle">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
                                    <Calendar size={16} />
                                </div>
                                <div>
                                    <h3 className="font-bold text-body text-primary">Schedule Download</h3>
                                    <p className="text-caption text-secondary">Set a future time for automated download</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsScheduleOpen(false)}
                                className="p-1 rounded-lg text-tertiary hover:text-primary transition-colors cursor-pointer"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="space-y-3">
                            <label className="text-caption font-bold text-primary block">
                                Choose Start Date & Time
                            </label>
                            <input
                                type="datetime-local"
                                value={scheduleDateTime}
                                onChange={(e) => setScheduleDateTime(e.target.value)}
                                className="w-full px-3 py-2.5 rounded-xl bg-surface-2 border border-border-subtle text-body-sm font-semibold text-primary outline-none focus:border-accent"
                            />

                            {/* Quick Presets */}
                            <div className="space-y-1.5 pt-1">
                                <span className="text-[11px] font-bold text-tertiary uppercase tracking-wider">Quick Presets:</span>
                                <div className="grid grid-cols-3 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setSchedulePreset(1)}
                                        className="py-1.5 px-2 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold text-secondary hover:text-primary border border-border-subtle transition-colors cursor-pointer"
                                    >
                                        In 1 Hour
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSchedulePreset(0, 2)}
                                        className="py-1.5 px-2 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold text-secondary hover:text-primary border border-border-subtle transition-colors cursor-pointer"
                                    >
                                        Tonight 2 AM
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSchedulePreset(0, 8)}
                                        className="py-1.5 px-2 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold text-secondary hover:text-primary border border-border-subtle transition-colors cursor-pointer"
                                    >
                                        Tomorrow 8 AM
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-border-subtle">
                            <button
                                type="button"
                                onClick={() => setIsScheduleOpen(false)}
                                className="px-4 py-2 rounded-xl bg-surface-2 hover:bg-surface-3 text-secondary text-caption font-bold transition-colors cursor-pointer"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmSchedule}
                                className="px-5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-caption font-bold shadow-sm transition-all cursor-pointer"
                            >
                                Confirm Schedule
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}