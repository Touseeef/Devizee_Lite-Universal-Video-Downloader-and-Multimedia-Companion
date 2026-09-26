import { useState } from "react";
import type { RefObject } from "react";
import { AlertCircle, Download, Film, Layers, Loader2, Music, Pause, Play, RotateCcw, RotateCw, Trash2, Volume2 } from "lucide-react";
import type { FormatOption } from "../../types";
import { WaveformVisualizer } from "../common/WaveformVisualizer";

export type BatchItem = {
    id: string;
    url: string;
    title: string;
    thumbnail: string;
    site: string;
    format: FormatOption;
    duration_string?: string;
    estimatedSize?: string;
    /** Bug B: set to true when fetch_video_info fails for this item */
    metadataError?: boolean;
};

export const PRIMARY_BATCH_PRESETS: { id: string; label: string; format: FormatOption; isAudio: boolean }[] = [
    {
        id: "4k",
        label: "4K Video",
        isAudio: false,
        format: { format_id: "bestvideo[height<=2160]+bestaudio/best", label: "4K (Ultra HD)", ext: "mp4", is_audio_only: false, resolution: "3840x2160", filesize_approx: null },
    },
    {
        id: "1080p",
        label: "1080p Video",
        isAudio: false,
        format: { format_id: "bestvideo[height<=1080]+bestaudio/best", label: "1080p (Full HD)", ext: "mp4", is_audio_only: false, resolution: "1920x1080", filesize_approx: null },
    },
    {
        id: "720p",
        label: "720p Video",
        isAudio: false,
        format: { format_id: "bestvideo[height<=720]+bestaudio/best", label: "720p (HD)", ext: "mp4", is_audio_only: false, resolution: "1280x720", filesize_approx: null },
    },
    {
        id: "mp3_320",
        label: "MP3 Audio (320k)",
        isAudio: true,
        format: { format_id: "bestaudio/best", label: "MP3 Audio (320 kbps)", ext: "mp3", is_audio_only: true, resolution: null, filesize_approx: null },
    },
    {
        id: "mp3_128",
        label: "MP3 Audio (128k)",
        isAudio: true,
        format: { format_id: "bestaudio/best", label: "MP3 Audio (128 kbps)", ext: "mp3", is_audio_only: true, resolution: null, filesize_approx: null },
    },
];

export const MORE_BATCH_VIDEO_PRESETS: { id: string; label: string; format: FormatOption; isAudio: boolean }[] = [
    {
        id: "1440p",
        label: "2K Video (1440p)",
        isAudio: false,
        format: { format_id: "bestvideo[height<=1440]+bestaudio/best", label: "2K (1440p QHD)", ext: "mp4", is_audio_only: false, resolution: "2560x1440", filesize_approx: null },
    },
    {
        id: "480p",
        label: "480p Video",
        isAudio: false,
        format: { format_id: "bestvideo[height<=480]+bestaudio/best", label: "480p (SD)", ext: "mp4", is_audio_only: false, resolution: "854x480", filesize_approx: null },
    },
    {
        id: "360p",
        label: "360p Video",
        isAudio: false,
        format: { format_id: "bestvideo[height<=360]+bestaudio/best", label: "360p (Low)", ext: "mp4", is_audio_only: false, resolution: "640x360", filesize_approx: null },
    },
];

export const MORE_BATCH_AUDIO_PRESETS: { id: string; label: string; format: FormatOption; isAudio: boolean }[] = [
    {
        id: "m4a",
        label: "M4A Audio",
        isAudio: true,
        format: { format_id: "bestaudio/best", label: "M4A Audio (AAC)", ext: "m4a", is_audio_only: true, resolution: null, filesize_approx: null },
    },
    {
        id: "wav",
        label: "WAV (Uncompressed)",
        isAudio: true,
        format: { format_id: "bestaudio/best", label: "WAV (Lossless)", ext: "wav", is_audio_only: true, resolution: null, filesize_approx: null },
    },
    {
        id: "flac",
        label: "FLAC (Lossless)",
        isAudio: true,
        format: { format_id: "bestaudio/best", label: "FLAC (Lossless)", ext: "flac", is_audio_only: true, resolution: null, filesize_approx: null },
    },
    {
        id: "opus",
        label: "OPUS Audio",
        isAudio: true,
        format: { format_id: "bestaudio/best", label: "OPUS Audio", ext: "opus", is_audio_only: true, resolution: null, filesize_approx: null },
    },
];

export const ALL_BATCH_PRESETS = [
    ...PRIMARY_BATCH_PRESETS,
    ...MORE_BATCH_VIDEO_PRESETS,
    ...MORE_BATCH_AUDIO_PRESETS,
];

export function BatchQueuePanel({
    items,
    onStartBatchDownload,
    onClearBatch,
    onRemoveItem,
    onUpdateItemFormat,
    onPlayVideo,
    onPreviewAudio,
    previewingId,
    isAudioElementPlaying,
    isLoadingAudioId,
    previewTime = 0,
    previewDuration = 0,
    onSeek,
    onSeekRelative,
    onClosePreview,
    audioRef,
    formatSeconds = (s: number) => {
        if (!Number.isFinite(s) || s < 0) return "0:00";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec < 10 ? "0" : ""}${sec}`;
    },
}: {
    items: BatchItem[];
    onStartBatchDownload: (items: BatchItem[]) => void;
    onClearBatch: () => void;
    onRemoveItem: (id: string) => void;
    onUpdateItemFormat: (id: string, format: FormatOption) => void;
    onPlayVideo?: (item: BatchItem) => void;
    onPreviewAudio?: (url: string, id: string) => void;
    previewingId?: string | null;
    isAudioElementPlaying?: boolean;
    isLoadingAudioId?: string | null;
    previewTime?: number;
    previewDuration?: number;
    onSeek?: (seconds: number) => void;
    onSeekRelative?: (delta: number) => void;
    onClosePreview?: () => void;
    audioRef?: RefObject<HTMLAudioElement | null>;
    formatSeconds?: (s: number) => string;
}) {
    const [selectedGlobalPreset, setSelectedGlobalPreset] = useState("1080p");

    if (items.length === 0) return null;

    const handleApplyGlobalPreset = (presetId: string) => {
        setSelectedGlobalPreset(presetId);
        const preset = ALL_BATCH_PRESETS.find((p) => p.id === presetId);
        if (preset) {
            items.forEach((item) => {
                onUpdateItemFormat(item.id, preset.format);
            });
        }
    };

    const isDropdownSelected =
        MORE_BATCH_VIDEO_PRESETS.some((p) => p.id === selectedGlobalPreset) ||
        MORE_BATCH_AUDIO_PRESETS.some((p) => p.id === selectedGlobalPreset);

    return (
        <div className="bg-surface-1 rounded-2xl p-5 border border-border-subtle shadow-sm space-y-4 animate-in fade-in duration-fast">
            {/* Header with Global Format Bar */}
            <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 pb-4 border-b border-border-subtle">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-accent-subtle text-accent flex items-center justify-center shrink-0">
                        <Layers size={20} />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-body font-bold text-primary">Batch Download Queue</h3>
                            <span className="px-2 py-0.5 rounded-full font-mono text-[11px] font-bold bg-accent text-white shadow-2xs">
                                {items.length} items
                            </span>
                        </div>
                        <p className="text-[11px] text-tertiary">
                            Configure formats and download all selected media in one queue
                        </p>
                    </div>
                </div>

                {/* Primary Batch Action CTA */}
                <div className="flex items-center gap-2.5 w-full lg:w-auto justify-end">
                    <button
                        type="button"
                        onClick={onClearBatch}
                        className="px-3 py-2 rounded-xl bg-surface-2 hover:bg-surface-3 text-secondary hover:text-status-danger text-caption font-semibold transition-colors cursor-pointer border border-border-subtle"
                        title="Dismiss batch queue"
                    >
                        Dismiss All
                    </button>

                    <button
                        type="button"
                        onClick={() => onStartBatchDownload(items)}
                        className="flex-1 lg:flex-none px-6 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-body-sm font-bold flex items-center justify-center gap-2 shadow-raised transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                        title="Start downloading all items in this batch"
                    >
                        <Download size={16} strokeWidth={2.5} />
                        <span>Download All ({items.length} Media)</span>
                    </button>
                </div>
            </div>

            {/* Global Preset Selector Bar (Image 2 Redesign) */}
            <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-surface-2/60 border border-border-subtle">
                <span className="text-[11px] font-bold text-tertiary uppercase tracking-wider mr-1">
                    Apply to All:
                </span>

                {/* Primary Visible Pills: 4K, 1080p, 720p, MP3 320k, MP3 128k */}
                {PRIMARY_BATCH_PRESETS.map((preset) => {
                    const isSelected = selectedGlobalPreset === preset.id;
                    const Icon = preset.isAudio ? Music : Film;
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            onClick={() => handleApplyGlobalPreset(preset.id)}
                            className={`px-3 py-1.5 rounded-lg text-caption font-semibold flex items-center gap-1.5 transition-all border cursor-pointer ${isSelected
                                ? "bg-accent text-white border-accent shadow-xs ring-1 ring-accent"
                                : "bg-surface-1 text-secondary hover:text-primary border-border-subtle hover:bg-surface-2"
                                }`}
                            title={`Set all items to ${preset.label}`}
                        >
                            <Icon size={12} />
                            <span>{preset.label}</span>
                        </button>
                    );
                })}

                {/* Dropdown for other options with divider between video and audio */}
                <select
                    value={isDropdownSelected ? selectedGlobalPreset : ""}
                    onChange={(e) => handleApplyGlobalPreset(e.target.value)}
                    className={`px-3 py-1.5 rounded-lg text-caption font-semibold border outline-none cursor-pointer transition-all ${isDropdownSelected
                        ? "bg-accent text-white border-accent shadow-xs ring-1 ring-accent"
                        : "bg-surface-1 text-secondary hover:text-primary border-border-subtle hover:bg-surface-2"
                        }`}
                    title="Select more video and audio formats"
                >
                    <option value="" disabled className="bg-surface-1 text-secondary">
                        More Formats...
                    </option>
                    <optgroup label="── Video Resolutions ──" className="bg-surface-1 text-tertiary font-bold">
                        {MORE_BATCH_VIDEO_PRESETS.map((p) => (
                            <option key={p.id} value={p.id} className="bg-surface-1 text-primary font-normal">
                                {p.label}
                            </option>
                        ))}
                    </optgroup>
                    <optgroup label="── Audio Formats ──" className="bg-surface-1 text-tertiary font-bold">
                        {MORE_BATCH_AUDIO_PRESETS.map((p) => (
                            <option key={p.id} value={p.id} className="bg-surface-1 text-primary font-normal">
                                {p.label}
                            </option>
                        ))}
                    </optgroup>
                </select>
            </div>

            {/* List of Batch Media Items with Big Thumbnails */}
            <div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1 custom-scrollbar">
                {items.map((item, idx) => {
                    const isThisPreviewing = previewingId === item.id;

                    return (
                        <div
                            key={item.id}
                            className={`flex flex-col p-3 rounded-xl bg-surface-2/40 hover:bg-surface-2 border transition-all ${isThisPreviewing ? "border-accent/60 ring-1 ring-accent/30 shadow-xs" : "border-border-subtle"
                                }`}
                        >
                            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3.5">
                                {/* Left: Thumbnail & Index */}
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <span className="font-mono text-tertiary text-[11px] w-5 text-right shrink-0">
                                        {idx + 1}.
                                    </span>
                                    <div
                                        onClick={() => onPlayVideo?.(item)}
                                        className={`w-24 sm:w-28 aspect-video rounded-lg overflow-hidden shrink-0 relative border shadow-xs cursor-pointer group/thumb ${item.metadataError
                                            ? "bg-status-danger-subtle/30 border-status-danger/40"
                                            : "bg-black border-border-subtle"
                                            }`}
                                        title={
                                            item.metadataError
                                                ? "Metadata could not be fetched. The download may still work."
                                                : "Click to play in hero video player"
                                        }
                                    >
                                        {item.metadataError ? (
                                            <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-status-danger">
                                                <AlertCircle size={20} />
                                                <span className="text-[9px] font-bold uppercase tracking-wider">
                                                    Metadata failed
                                                </span>
                                            </div>
                                        ) : (
                                            <>
                                                <img
                                                    src={item.thumbnail}
                                                    alt=""
                                                    className="w-full h-full object-cover group-hover/thumb:scale-105 transition-transform duration-200"
                                                    onError={(e) => {
                                                        e.currentTarget.style.display = "none";
                                                    }}
                                                />
                                                <div className="absolute inset-0 bg-black/35 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity">
                                                    <Play size={16} fill="white" className="text-white ml-0.5" />
                                                </div>
                                                {item.duration_string && (
                                                    <span className="absolute bottom-1 right-1 bg-black/80 text-white font-mono text-[9px] px-1 py-0.2 rounded">
                                                        {item.duration_string}
                                                    </span>
                                                )}
                                            </>
                                        )}
                                    </div>

                                    {/* Title & Platform Info */}
                                    <div className="min-w-0 flex-1">
                                        <h4
                                            onClick={() => onPlayVideo?.(item)}
                                            className="text-body-sm font-bold text-primary truncate cursor-pointer hover:text-accent transition-colors"
                                            title={item.title}
                                        >
                                            {item.title}
                                        </h4>
                                        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-secondary">
                                            <span className="font-semibold text-accent">{item.site}</span>
                                            <span>•</span>
                                            {item.metadataError ? (
                                                <span className="font-mono text-status-danger truncate">
                                                    Title unavailable — will resolve on download
                                                </span>
                                            ) : (
                                                <span className="font-mono text-tertiary truncate">
                                                    {item.estimatedSize || "Standard stream"}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Right: Audio Preview, Format Dropdown & Delete */}
                                <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0">
                                    {onPreviewAudio && (
                                        <button
                                            type="button"
                                            onClick={() => onPreviewAudio(item.url, item.id)}
                                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer border shadow-2xs ${isThisPreviewing && isAudioElementPlaying
                                                ? "bg-accent text-white border-accent"
                                                : "bg-surface-1 hover:bg-surface-2 text-accent border-border-subtle"
                                                }`}
                                            title="Listen audio preview"
                                        >
                                            {isLoadingAudioId === item.id ? (
                                                <Loader2 size={13} className="animate-spin" />
                                            ) : isThisPreviewing && isAudioElementPlaying ? (
                                                <Pause size={13} fill="currentColor" />
                                            ) : (
                                                <Play size={13} fill="currentColor" className="ml-0.5" />
                                            )}
                                        </button>
                                    )}

                                    <select
                                        value={item.format.label}
                                        onChange={(e) => {
                                            const found = ALL_BATCH_PRESETS.find(
                                                (p) => p.format.label === e.target.value
                                            );
                                            if (found) {
                                                onUpdateItemFormat(item.id, found.format);
                                                setSelectedGlobalPreset("");
                                            }
                                        }}
                                        className="px-2.5 py-1.5 rounded-lg bg-surface-1 border border-border-subtle text-caption font-semibold text-primary outline-none cursor-pointer hover:border-accent/40 transition-colors"
                                        title="Choose format for this item"
                                    >
                                        <optgroup label="── Video Resolutions ──" className="bg-surface-1 text-tertiary font-bold">
                                            {PRIMARY_BATCH_PRESETS.filter((p) => !p.isAudio).concat(MORE_BATCH_VIDEO_PRESETS).map((p) => (
                                                <option key={p.id} value={p.format.label} className="bg-surface-1 text-primary font-normal">
                                                    {p.label}
                                                </option>
                                            ))}
                                        </optgroup>
                                        <optgroup label="── Audio Formats ──" className="bg-surface-1 text-tertiary font-bold">
                                            {PRIMARY_BATCH_PRESETS.filter((p) => p.isAudio).concat(MORE_BATCH_AUDIO_PRESETS).map((p) => (
                                                <option key={p.id} value={p.format.label} className="bg-surface-1 text-primary font-normal">
                                                    {p.label}
                                                </option>
                                            ))}
                                        </optgroup>
                                    </select>

                                    <button
                                        type="button"
                                        onClick={() => onRemoveItem(item.id)}
                                        className="w-8 h-8 rounded-lg bg-surface-1 hover:bg-status-danger/10 text-tertiary hover:text-status-danger flex items-center justify-center transition-colors cursor-pointer border border-border-subtle"
                                        title="Remove from batch"
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            </div>

                            {/* Inline Audio Preview Player Drawer (Matching PlaylistPanel) */}
                            {isThisPreviewing && (
                                <div className="mt-3 pt-2.5 border-t border-border-subtle/60 pl-8 pr-1 space-y-1.5 animate-in fade-in duration-fast">
                                    <div className="flex items-center justify-between text-caption text-secondary font-mono text-[10px]">
                                        <span className="flex items-center gap-1.5 text-accent font-semibold">
                                            <Volume2 size={11} className="animate-pulse" />
                                            <span>Playing Preview</span>
                                            {audioRef && (
                                                <WaveformVisualizer
                                                    mediaElement={audioRef.current}
                                                    isPlaying={!!isAudioElementPlaying}
                                                    width={80}
                                                    height={14}
                                                />
                                            )}
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
                                        onChange={(e) => onSeek?.(parseFloat(e.target.value))}
                                        className="w-full h-1 cursor-pointer rounded-full outline-none appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:-mt-0.75"
                                        style={{
                                            background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${(previewTime / Math.max(1, previewDuration)) * 100}%, var(--color-surface-3) ${(previewTime / Math.max(1, previewDuration)) * 100}%, var(--color-surface-3) 100%)`,
                                        }}
                                    />

                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => onSeekRelative?.(-10)}
                                                className="text-[10px] text-secondary hover:text-primary flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface-1 border border-border-subtle cursor-pointer hover:border-accent/30"
                                            >
                                                <RotateCcw size={9} /> -10s
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => onSeekRelative?.(10)}
                                                className="text-[10px] text-secondary hover:text-primary flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface-1 border border-border-subtle cursor-pointer hover:border-accent/30"
                                            >
                                                +10s <RotateCw size={9} />
                                            </button>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={onClosePreview}
                                            className="text-[10px] text-secondary hover:text-status-danger cursor-pointer"
                                        >
                                            Dismiss Preview
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
