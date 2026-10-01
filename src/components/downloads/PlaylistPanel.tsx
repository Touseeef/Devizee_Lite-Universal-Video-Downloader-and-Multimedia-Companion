import { useState } from "react";
import {
    AlertCircle,
    CheckSquare,
    Download,
    ListPlus,
    Loader2,
    Music,
    Pause,
    Play,
    PlayCircle,
    RotateCcw,
    RotateCw,
    Square,
    Volume2,
} from "lucide-react";
import type {
    DownloadRecord,
    PlaylistEntry,
    PlaylistInfo,
    VideoInfo,
} from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import { WaveformVisualizer } from "../common/WaveformVisualizer";
import { formatFileSize, parseTimeToSeconds, estimateFormatBytes } from "../../lib/format";

export function PlaylistPanel({
    t,
    playlistInfo,
    isLoadingPlaylist,
    showSection,
    setShowSection,
    selectedIds,
    toggleItem,
    selectAll,
    deselectAll,
    onBatchDownload,
    onSingleDownload,
    onPlayVideo,
    onPreviewAudio,
    previewingId,
    isAudioElementPlaying,
    isLoadingAudioId,
    previewTime,
    previewDuration,
    onSeek,
    onSeekRelative,
    onClosePreview,
    history,
    audioRef,
    activeVideoInfo,
}: {
    t: (key: TranslationKey) => string;
    playlistInfo: PlaylistInfo | null;
    isLoadingPlaylist: boolean;
    showSection: boolean;
    setShowSection: (v: boolean) => void;
    selectedIds: Set<string>;
    toggleItem: (id: string) => void;
    selectAll: () => void;
    deselectAll: () => void;

    onBatchDownload: (items: { entry: PlaylistEntry; preset: string }[]) => void;
    onSingleDownload: (entry: PlaylistEntry, preset: string) => void;
    onPlayVideo: (entry: PlaylistEntry) => void;
    onPreviewAudio: (url: string, id: string) => void;
    previewingId: string | null;
    isAudioElementPlaying: boolean;
    isLoadingAudioId: string | null;
    previewTime: number;
    previewDuration: number;
    onSeek: (s: number) => void;
    onSeekRelative: (delta: number) => void;
    onClosePreview: () => void;
    history: DownloadRecord[];
    audioRef: React.RefObject<HTMLAudioElement | null>;
    activeVideoInfo?: VideoInfo | null;
}) {
    const formatSeconds = (secs: number) => {
        // W3-6: Guard against NaN/Infinity from live streams or broken durations.
        // Prevents "NaN:NaN" from rendering in the UI.
        if (!Number.isFinite(secs) || secs < 0) return "0:00";
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? "0" : ""}${s}`;
    };


    // ─── W2-10: Full preset system ───
    // Each playlist item resolves to a preset ID. If no per-item override
    // is set, it falls back to globalVideoPreset (items are videos by default).
    // Two global dropdowns at the top: video and audio, independent.
    const ALL_PRESETS: { id: string; label: string; isAudio: boolean }[] = [
        { id: "4k", label: "4K Video", isAudio: false },
        { id: "1440p", label: "1440p Video", isAudio: false },
        { id: "1080p", label: "1080p Video", isAudio: false },
        { id: "720p", label: "720p Video", isAudio: false },
        { id: "480p", label: "480p Video", isAudio: false },
        { id: "360p", label: "360p Video", isAudio: false },
        { id: "mp3", label: "MP3 (320 kbps)", isAudio: true },
        { id: "m4a", label: "M4A (AAC)", isAudio: true },
        { id: "flac", label: "FLAC (Lossless)", isAudio: true },
        { id: "wav", label: "WAV (Uncompressed)", isAudio: true },
        { id: "opus", label: "OPUS Audio", isAudio: true },
    ];
    const VIDEO_PRESETS = ALL_PRESETS.filter((p) => !p.isAudio);
    const AUDIO_PRESETS = ALL_PRESETS.filter((p) => p.isAudio);

    const RESOLUTION_RANKS: Record<string, number> = {
        "4k": 2160,
        "2160p": 2160,
        "1440p": 1440,
        "1080p": 1080,
        "720p": 720,
        "480p": 480,
        "360p": 360,
    };

    const getKnownMaxResolution = (entryId: string): { label: string; height: number } | null => {
        const matching = history.filter(
            (h) => (h.url.includes(entryId) || h.id.startsWith(entryId)) && h.status === "completed"
        );
        let maxHeight = 0;
        let maxLabel = "";
        for (const h of matching) {
            const m = h.format.toLowerCase();
            for (const [key, height] of Object.entries(RESOLUTION_RANKS)) {
                if (m.includes(key) && height > maxHeight) {
                    maxHeight = height;
                    maxLabel = key.toUpperCase();
                }
            }
        }
        if (maxHeight > 0) {
            return { label: maxLabel, height: maxHeight };
        }
        return null;
    };

    const [itemPresetIds, setItemPresetIds] = useState<Map<string, string>>(new Map());
    const [defaultPreset, setDefaultPreset] = useState("1080p");

    const getItemPreset = (entryId: string): string => {
        const override = itemPresetIds.get(entryId);
        if (override) return override;
        return defaultPreset;
    };

    const handleApplyPreset = (p: string) => {
        if (selectedIds.size === 0) {
            // No selection -> change default for whole playlist
            setDefaultPreset(p);
            setItemPresetIds(new Map());
        } else {
            // Selection exists -> apply ONLY to the selected items!
            setItemPresetIds((prev) => {
                const next = new Map(prev);
                for (const id of selectedIds) {
                    next.set(id, p);
                }
                return next;
            });
        }
    };

    const getEntryMaxResolution = (entryId: string): { label: string; height: number } | null => {
        // 1. If currently active video info matches this entry, check its detected formats
        if (activeVideoInfo && activeVideoInfo.id === entryId && activeVideoInfo.video_formats?.length) {
            let maxHeight = 0;
            let maxLabel = "";
            for (const f of activeVideoInfo.video_formats) {
                const label = (f.label || "").toLowerCase();
                const res = (f.resolution || "").toLowerCase();
                for (const [key, height] of Object.entries(RESOLUTION_RANKS)) {
                    if ((label.includes(key) || res.includes(key)) && height > maxHeight) {
                        maxHeight = height;
                        maxLabel = key.toUpperCase();
                    }
                }
            }
            if (maxHeight > 0) {
                return { label: maxLabel, height: maxHeight };
            }
        }

        // 2. Check download history
        return getKnownMaxResolution(entryId);
    };

    const getEstimatedEntryBytes = (entry: PlaylistEntry, presetId: string): number => {
        const secs = parseTimeToSeconds(entry.duration_string);
        const preset = ALL_PRESETS.find((p) => p.id === presetId);
        return (
            estimateFormatBytes(
                {
                    resolution: preset?.id,
                    label: preset?.label,
                    is_audio_only: preset?.isAudio,
                },
                secs
            ) || 0
        );
    };

    const selectedArray = Array.from(selectedIds);
    const selectedPresets = selectedArray.map((id) => getItemPreset(id));
    const allSelectedSamePreset =
        selectedArray.length === 0 ||
        (selectedPresets.length > 0 && selectedPresets.every((pr) => pr === selectedPresets[0]));
    const topDropdownValue = selectedArray.length === 0
        ? defaultPreset
        : allSelectedSamePreset
            ? selectedPresets[0]
            : "";
    const hasMixedFormats = selectedArray.length > 0 && !allSelectedSamePreset;

    // Only show high-res warning pill if any SELECTED item has 4k or 1440p requested
    const has4kOr1440pSelected = selectedArray.length === 0
        ? (defaultPreset === "4k" || defaultPreset === "1440p")
        : selectedArray.some((id) => {
            const pr = getItemPreset(id);
            return pr === "4k" || pr === "1440p";
        });

    const totalSelectedBytes = selectedArray.reduce((acc, id) => {
        const entry = playlistInfo?.entries.find((e) => e.id === id);
        if (!entry) return acc;
        return acc + getEstimatedEntryBytes(entry, getItemPreset(id));
    }, 0);

    if (!playlistInfo && !isLoadingPlaylist) return null;

    return (
        <div className="bg-surface-1 rounded-md shadow-raised overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-fast">
            <div className="p-3.5 flex items-center justify-between border-b border-border-subtle">
                <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-md bg-accent-subtle text-accent flex items-center justify-center shrink-0">
                        {isLoadingPlaylist ? (
                            <Loader2 size={15} className="animate-spin" />
                        ) : (
                            <ListPlus size={15} />
                        )}
                    </div>
                    <div>
                        <h4 className="font-semibold text-body-sm text-primary">
                            {isLoadingPlaylist
                                ? "Resolving playlist tracks..."
                                : playlistInfo?.title}
                        </h4>
                        <p className="text-caption text-secondary">
                            {playlistInfo
                                ? `${playlistInfo.entries.length} videos detected • ${selectedIds.size} selected${totalSelectedBytes > 0 ? ` (~${formatFileSize(totalSelectedBytes)})` : ""}`
                                : "Analyzing list..."}
                        </p>
                    </div>
                </div>

                {playlistInfo && (
                    <button
                        type="button"
                        onClick={() => setShowSection(!showSection)}
                        className="px-3 py-1 rounded-md bg-surface-2 hover:bg-surface-0 text-primary text-caption font-semibold transition-colors border border-border-subtle"
                    >
                        {showSection ? "Collapse" : "Expand Playlist"}
                    </button>
                )}
            </div>

            {playlistInfo && showSection && (
                <div className="p-3.5 space-y-3 bg-surface-0/40">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-1 border-b border-border-subtle/50">
                        <div className="flex items-center gap-3 text-caption font-semibold">
                            <button
                                type="button"
                                onClick={selectAll}
                                className="px-3 py-1 rounded-md border border-border-subtle bg-surface-1 hover:bg-surface-2 flex items-center gap-1.5 text-accent shadow-sm transition-colors"
                            >
                                <CheckSquare size={13} />
                                <span>{t("select_all")}</span>
                            </button>
                            <button
                                type="button"
                                onClick={deselectAll}
                                className="px-3 py-1 rounded-md border border-border-subtle bg-surface-1 hover:bg-surface-2 flex items-center gap-1.5 text-secondary hover:text-primary shadow-sm transition-colors"
                            >
                                <Square size={13} />
                                <span>{t("deselect_all")}</span>
                            </button>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                            {/* Preset dropdown: applies to selected items, or all if none selected */}
                            <span className="text-caption font-semibold text-tertiary whitespace-nowrap">
                                {selectedIds.size === 0
                                    ? "Apply to All:"
                                    : `Apply to ${selectedIds.size} Selected:`}
                            </span>
                            <select
                                value={topDropdownValue}
                                onChange={(e) => handleApplyPreset(e.target.value)}
                                className={`border rounded-md px-2.5 py-1 text-caption font-semibold outline-none cursor-pointer transition-all ${allSelectedSamePreset && (topDropdownValue === "4k" || topDropdownValue === "1440p")
                                    ? "bg-accent/15 text-accent border-accent ring-1 ring-accent/40"
                                    : "bg-surface-1 text-primary border-border-subtle hover:border-accent/40"
                                    }`}
                                title={selectedIds.size === 0 ? "Apply this format to all items" : `Apply this format to the ${selectedIds.size} selected items`}
                            >
                                {hasMixedFormats && (
                                    <option value="" disabled>
                                        Mixed Formats...
                                    </option>
                                )}
                                <optgroup label="── Video ──">
                                    {VIDEO_PRESETS.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.label}
                                        </option>
                                    ))}
                                </optgroup>
                                <optgroup label="── Audio ──">
                                    {AUDIO_PRESETS.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.label}
                                        </option>
                                    ))}
                                </optgroup>
                            </select>

                            {hasMixedFormats && (
                                <span className="text-[10px] italic text-tertiary whitespace-nowrap">
                                    (mixed formats)
                                </span>
                            )}

                            {has4kOr1440pSelected && (
                                <span
                                    className="text-[10px] text-amber-400/90 flex items-center gap-1 font-medium bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 cursor-help"
                                    title="Selected videos without 4K/1440p support will automatically download at their highest available resolution (e.g. 1080p)"
                                >
                                    <AlertCircle size={10} className="shrink-0" />
                                    <span>Selected 4K fallback to best</span>
                                </span>
                            )}

                            <button
                                type="button"
                                disabled={selectedIds.size === 0}
                                onClick={() => {
                                    const resolved = selectedArray
                                        .map((id) => {
                                            const entry = playlistInfo?.entries.find((e) => e.id === id);
                                            return entry ? { entry, preset: getItemPreset(id) } : null;
                                        })
                                        .filter((x): x is { entry: PlaylistEntry; preset: string } => x !== null);
                                    onBatchDownload(resolved);
                                }}
                                className="px-3.5 py-1 rounded-md bg-accent text-white hover:bg-accent-hover text-caption font-semibold disabled:opacity-40 transition-all shadow-sm flex items-center gap-1.5"
                            >
                                <Download size={13} />
                                <span>
                                    {t("download_selected")} ({selectedIds.size}{totalSelectedBytes > 0 ? ` • ~${formatFileSize(totalSelectedBytes)}` : ""})
                                </span>
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2.5 py-1.5">
                        {playlistInfo.entries.map((entry, idx) => {
                            const isSelected = selectedIds.has(entry.id);
                            const isThisPreviewing = previewingId === entry.id;
                            const entryTask = history.find(
                                (h) => h.id.startsWith(entry.id) || h.url.includes(entry.id)
                            );

                            return (
                                <div
                                    key={entry.id}
                                    className={`flex flex-col p-2.5 rounded-md transition-all bg-surface-1 shadow-sm border border-border-subtle ${isSelected ? "ring-1 ring-accent border-accent/60" : ""
                                        }`}
                                >
                                    <div className="flex items-center gap-2.5">
                                        <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={() => toggleItem(entry.id)}
                                            className="w-3.5 h-3.5 rounded text-accent accent-accent cursor-pointer"
                                        />
                                        <span className="text-caption text-tertiary w-5 text-right font-mono text-[11px]">
                                            {idx + 1}
                                        </span>

                                        <div
                                            onClick={() => onPlayVideo(entry)}
                                            className="w-14 aspect-video rounded-sm overflow-hidden bg-surface-0 shrink-0 relative cursor-pointer group/thumb"
                                            title="Click to play this video directly in-app above"
                                        >
                                            <img
                                                src={
                                                    entry.thumbnail ||
                                                    `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
                                                }
                                                alt=""
                                                onError={(e) => {
                                                    e.currentTarget.src = `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
                                                }}
                                                className="w-full h-full object-cover group-hover/thumb:scale-110 transition-transform duration-200"
                                            />
                                            <div className="absolute inset-0 bg-black/25 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity">
                                                <Play size={12} fill="white" className="text-white ml-0.5" />
                                            </div>
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <p
                                                className="text-body-sm font-semibold text-primary truncate cursor-pointer hover:text-accent"
                                                onClick={() => onPlayVideo(entry)}
                                                title={entry.title}
                                            >
                                                {entry.title}
                                            </p>
                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                <span className="text-caption text-tertiary text-[11px] whitespace-nowrap">
                                                    {entry.duration_string}
                                                    {(() => {
                                                        const est = getEstimatedEntryBytes(entry, getItemPreset(entry.id));
                                                        return est > 0 ? ` • ~${formatFileSize(est)}` : "";
                                                    })()}
                                                </span>
                                                {entryTask && entryTask.status !== "error" && (
                                                    <span
                                                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded font-mono inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${entryTask.status === "completed"
                                                            ? "bg-status-success-subtle/30 text-status-success"
                                                            : "bg-accent-subtle text-accent"
                                                            }`}
                                                    >
                                                        {entryTask.status === "downloading" && (
                                                            <Loader2 size={9} className="animate-spin" />
                                                        )}
                                                        {entryTask.status === "downloading"
                                                            ? `${entryTask.percent.toFixed(0)}%`
                                                            : entryTask.status === "completed"
                                                                ? "✓ Downloaded"
                                                                : entryTask.status}
                                                    </span>
                                                )}
                                                {/* W2-9: show downloaded formats as chips */}
                                                {entryTask?.status === "completed" && (() => {
                                                    const allExisting = history.filter(
                                                        (h) =>
                                                            (h.url.includes(entry.id) || h.id.startsWith(entry.id)) &&
                                                            h.status === "completed"
                                                    );
                                                    const seen = new Set<string>();
                                                    const unique: typeof allExisting = [];
                                                    for (const m of allExisting) {
                                                        const k = m.format.toLowerCase().trim();
                                                        if (seen.has(k)) continue;
                                                        seen.add(k);
                                                        unique.push(m);
                                                    }
                                                    if (unique.length === 0) return null;
                                                    return (
                                                        <div className="flex flex-wrap gap-1 mt-1">
                                                            {unique.slice(0, 3).map((rec) => {
                                                                const isAud = rec.format.toLowerCase().match(/mp3|m4a|flac|opus|wav/);
                                                                const shortFmt = rec.format
                                                                    .replace(/\s*\(.*?\)\s*/g, "")
                                                                    .replace(/\[.*?\]/g, "")
                                                                    .trim()
                                                                    .slice(0, 20);
                                                                return (
                                                                    <button
                                                                        key={rec.id}
                                                                        type="button"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            const target = e.currentTarget;
                                                                            const path = rec.file_path;
                                                                            const t = window.setTimeout(() => {
                                                                                (window as any).__onReveal?.(path);
                                                                            }, 250);
                                                                            (target as any).__pendingClickTimer = t;
                                                                        }}
                                                                        onDoubleClick={(e) => {
                                                                            e.stopPropagation();
                                                                            const target = e.currentTarget;
                                                                            const pending = (target as any).__pendingClickTimer;
                                                                            if (pending) {
                                                                                clearTimeout(pending);
                                                                                delete (target as any).__pendingClickTimer;
                                                                            }
                                                                            (window as any).__onOpenFile?.(rec.file_path);
                                                                        }}
                                                                        className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-status-success-subtle/30 hover:bg-status-success-subtle/60 border border-status-success/30 text-[10px] font-mono cursor-pointer transition-colors"
                                                                        title={`${rec.file_path || ""}\n\nClick to reveal · Double-click to open`}
                                                                    >
                                                                        {isAud ? <Music size={9} className="text-accent" /> : <PlayCircle size={9} className="text-accent" />}
                                                                        <span className="text-status-success font-semibold">{shortFmt || rec.format}</span>
                                                                    </button>
                                                                );
                                                            })}
                                                            {unique.length > 3 && (
                                                                <span className="text-[10px] text-tertiary font-mono px-1">
                                                                    +{unique.length - 3}
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        </div>

                                        {/* Per-item format dropdown — full preset list */}
                                        {(() => {
                                            const itemPreset = getItemPreset(entry.id);
                                            const selectedRank = RESOLUTION_RANKS[itemPreset] || 0;
                                            const knownMax = getEntryMaxResolution(entry.id);
                                            const isCapped = knownMax && selectedRank > knownMax.height;
                                            const isHighResSelected = isSelected && (itemPreset === "4k" || itemPreset === "1440p");

                                            return (
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <select
                                                        value={itemPreset}
                                                        onChange={(e) => {
                                                            const p = e.target.value;
                                                            setItemPresetIds((prev) => {
                                                                const next = new Map(prev);
                                                                next.set(entry.id, p);
                                                                return next;
                                                            });
                                                            if (!isSelected) toggleItem(entry.id);
                                                        }}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className={`px-1.5 py-1 rounded-md bg-surface-2 border text-caption font-semibold text-primary outline-none cursor-pointer transition-colors shrink-0 max-w-[110px] ${
                                                            isCapped
                                                                ? "border-amber-500/50 hover:border-amber-500"
                                                                : isHighResSelected
                                                                    ? "border-accent/60"
                                                                    : "border-border-subtle hover:border-accent/40"
                                                        }`}
                                                        title="Choose format for this item"
                                                    >
                                                        <optgroup label="── Video ──">
                                                            {VIDEO_PRESETS.map((o) => (
                                                                <option key={o.id} value={o.id}>
                                                                    {o.label}
                                                                </option>
                                                            ))}
                                                        </optgroup>
                                                        <optgroup label="── Audio ──">
                                                            {AUDIO_PRESETS.map((o) => (
                                                                <option key={o.id} value={o.id}>
                                                                    {o.label}
                                                                </option>
                                                            ))}
                                                        </optgroup>
                                                    </select>
                                                    {isCapped ? (
                                                        <div
                                                            className="w-5 h-5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center justify-center shrink-0 cursor-help"
                                                            title={`Max resolution available is ${knownMax.label} — will download in best available quality (${knownMax.label})`}
                                                        >
                                                            <AlertCircle size={11} className="shrink-0" />
                                                        </div>
                                                    ) : isHighResSelected ? (
                                                        <div
                                                            className="w-5 h-5 rounded-full bg-accent/15 text-accent border border-accent/30 flex items-center justify-center shrink-0 cursor-help"
                                                            title="4K/1440p requested for this video. If unavailable on the platform, Devizee will automatically download its highest available quality (e.g. 1080p)."
                                                        >
                                                            <AlertCircle size={11} className="shrink-0" />
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })()}

                                        <button
                                            type="button"
                                            disabled={
                                                entryTask?.status === "downloading" ||
                                                entryTask?.status === "starting" ||
                                                entryTask?.status === "muxing"
                                            }
                                            onClick={() => {
                                                const effectivePreset = getItemPreset(entry.id);
                                                if (isSelected) toggleItem(entry.id);
                                                onSingleDownload(entry, effectivePreset);
                                            }}
                                            className="w-7 h-7 rounded-md bg-surface-2 hover:bg-surface-3 text-secondary hover:text-accent flex items-center justify-center shrink-0 transition-colors border border-border-subtle shadow-sm disabled:opacity-40"
                                            title="Download this track in its own format"
                                        >
                                            <Download size={12} />
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => onPreviewAudio(entry.url, entry.id)}
                                            className="w-7 h-7 rounded-md bg-surface-2 hover:bg-surface-3 text-accent flex items-center justify-center shrink-0 transition-colors border border-border-subtle shadow-sm"
                                            title="Listen audio preview"
                                        >
                                            {isLoadingAudioId === entry.id ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : isThisPreviewing && isAudioElementPlaying ? (
                                                <Pause size={12} fill="currentColor" />
                                            ) : (
                                                <Play size={12} fill="currentColor" />
                                            )}
                                        </button>
                                    </div>

                                    {entryTask &&
                                        (entryTask.status === "downloading" ||
                                            entryTask.status === "muxing") && (
                                            <div className="h-1 bg-surface-2 rounded-full overflow-hidden mt-2 ml-7 mr-1">
                                                <div
                                                    className="h-full bg-accent transition-all duration-fast"
                                                    style={{ width: `${entryTask.percent}%` }}
                                                />
                                            </div>
                                        )}

                                    {isThisPreviewing && (
                                        <div className="mt-2 pl-8 pr-1 space-y-1.5">
                                            <div className="flex items-center justify-between text-caption text-secondary font-mono text-[10px]">
                                                <span className="flex items-center gap-1.5 text-accent font-semibold">
                                                    <Volume2 size={11} /> Playing Preview
                                                    <WaveformVisualizer
                                                        mediaElement={audioRef.current}
                                                        isPlaying={isAudioElementPlaying}
                                                    />
                                                </span>
                                                <span>
                                                    {formatSeconds(previewTime)} / {formatSeconds(previewDuration || 0)}
                                                </span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0"
                                                max={previewDuration || 100}
                                                step="0.5"
                                                value={previewTime}
                                                onChange={(e) => onSeek(parseFloat(e.target.value))}
                                                className="w-full h-0.5 cursor-pointer rounded-full outline-none appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:-mt-1"
                                                style={{
                                                    background: `linear-gradient(to right, var(--color-status-info) 0%, var(--color-status-info) ${(previewTime / Math.max(1, previewDuration)) * 100
                                                        }%, var(--color-surface-2) ${(previewTime / Math.max(1, previewDuration)) * 100
                                                        }%, var(--color-surface-2) 100%)`,
                                                }}
                                            />
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => onSeekRelative(-5)}
                                                        className="text-[10px] text-secondary hover:text-primary flex items-center gap-0.5"
                                                    >
                                                        <RotateCcw size={9} /> -5s
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => onSeekRelative(5)}
                                                        className="text-[10px] text-secondary hover:text-primary flex items-center gap-0.5"
                                                    >
                                                        +5s <RotateCw size={9} />
                                                    </button>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={onClosePreview}
                                                    className="text-[10px] text-secondary hover:text-status-danger"
                                                >
                                                    Close Preview
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}