// src/components/downloads/HistoryItem.tsx
import React, { useState, useEffect } from "react";
import {
    AlertCircle,
    Check,
    Copy,
    Folder,
    Link as LinkIcon,
    Loader2,
    MoreVertical,
    Music,
    Pause,
    Play,
    PlayCircle,
    RefreshCw,
    RotateCcw,
    Trash2,
    X,
    XCircle,
} from "lucide-react";
import type { DownloadRecord } from "../../types";
import { STATUS_DISPLAY, ERROR_MESSAGES } from "../../status";
import { formatFileSize } from "../../lib/format";
import { formatDisplayBadge, isAudioFormat } from "../../lib/formatClassify";
import { convertFileSrc } from "@tauri-apps/api/core";

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

export const HistoryItem = React.memo(function HistoryItem({
    record,
    isOnline,
    onOpenFolder,
    onOpenFile,
    onRemove,
    onDeleteFile,
    onRetry,
    onPause,
    onResume,
    onCancel,
    onRefreshUrl,
    tOpenFolder,
    tOpenFile,
    tRemoveRow,
    tDeleteFile,
    onPlayMedia,
}: {
    record: DownloadRecord;
    isOnline: boolean;
    onOpenFolder: () => void;
    onOpenFile: () => void;
    onRemove: () => void;
    onDeleteFile: () => void;
    onRetry?: () => void;
    onPause?: () => void;
    onResume?: () => void;
    onCancel?: () => void;
    onRefreshUrl?: () => void;
    tOpenFolder: string;
    tOpenFile: string;
    tRemoveRow: string;
    tDeleteFile: string;
    onPlayMedia?: (record: DownloadRecord) => void;
}) {
    const display = STATUS_DISPLAY[record.status] || STATUS_DISPLAY.error;
    const [menuOpen, setMenuOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

    const ytId = extractYtId(record.url, record.id);
    const thumbUrl = ytId
        ? `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`
        : record.thumbnail
            ? (record.thumbnail.startsWith("http") || record.thumbnail.startsWith("asset") ? record.thumbnail : safeConvertFileSrc(record.thumbnail))
            : null;
    const isAudio = isAudioFormat(record.format);

    const handleCopyUrl = async (e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (record.url) {
            try {
                await navigator.clipboard.writeText(record.url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            } catch { }
        }
    };

    // Right-Click Custom Desktop Context Menu (Replaces WebView default menu)
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Keep within viewport boundaries
        const menuWidth = 190;
        const menuHeight = 220;
        const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
        const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
        setContextMenuPos({ x, y });
    };

    useEffect(() => {
        if (!contextMenuPos) return;
        const closeMenu = () => setContextMenuPos(null);
        window.addEventListener("click", closeMenu);
        window.addEventListener("contextmenu", closeMenu);
        return () => {
            window.removeEventListener("click", closeMenu);
            window.removeEventListener("contextmenu", closeMenu);
        };
    }, [contextMenuPos]);

    return (
        <div
            onContextMenu={handleContextMenu}
            onDoubleClick={() => {
                if (record.status === "completed" && record.file_path) {
                    onOpenFile();
                }
            }}
            className="p-3 flex items-center gap-3 relative group cursor-pointer hover:bg-surface-2/40 transition-colors rounded-xl"
            title={record.status === "completed" ? "Double-click to open file" : undefined}
        >
            {/* Media Thumbnail */}
            <div
                onClick={(e) => {
                    if (record.status === "completed" && onPlayMedia) {
                        e.stopPropagation();
                        onPlayMedia(record);
                    }
                }}
                className={`w-16 aspect-video rounded-md overflow-hidden bg-surface-2 shrink-0 relative flex items-center justify-center border border-border-subtle/60 transition-all ${record.status === "completed" ? "cursor-pointer group/thumb hover:border-accent hover:shadow-xs" : ""}`}
                title={record.status === "completed" ? "Play in Multimedia Player" : undefined}
            >
                {record.status === "error" ? (
                    <div className="w-full h-full flex items-center justify-center bg-status-danger-subtle text-status-danger">
                        <AlertCircle size={18} />
                    </div>
                ) : thumbUrl ? (
                    <>
                        <img
                            src={thumbUrl}
                            alt=""
                            className="w-full h-full object-cover group-hover/thumb:scale-105 transition-transform duration-200"
                            onError={(e) => {
                                e.currentTarget.style.display = "none";
                            }}
                        />
                        {record.status === "completed" && (
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity">
                                <Play size={15} fill="white" className="text-white ml-0.5" />
                            </div>
                        )}
                    </>
                ) : isAudio ? (
                    <div className="w-full h-full flex items-center justify-center bg-accent-subtle/40 text-accent group-hover/thumb:bg-accent group-hover/thumb:text-white transition-colors">
                        {record.status === "completed" ? <Play size={16} fill="currentColor" /> : <Music size={18} />}
                    </div>
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-tertiary group-hover/thumb:text-accent transition-colors">
                        <PlayCircle size={18} />
                    </div>
                )}
            </div>

            {/* Metadata & Progress */}
            <div className="flex-1 min-w-0 flex flex-col justify-center">
                <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="min-w-0 flex-1">
                        <h4
                            className="text-body-sm font-semibold truncate text-primary"
                            title={record.title}
                        >
                            {record.title}
                        </h4>
                        <div className="flex items-center gap-2 mt-0.5">
                            {record.status === "error" ? (
                                <span className="text-caption text-status-danger font-medium text-[11px] flex items-center gap-1">
                                    <span>
                                        {ERROR_MESSAGES[record.error_code || "unknown"] || ERROR_MESSAGES.unknown}
                                    </span>
                                </span>
                            ) : (
                                <>
                                    <span className="text-caption text-tertiary text-[10px] font-mono">
                                        {formatDisplayBadge(record.format)}
                                    </span>
                                    {record.file_size && record.file_size > 0 && (
                                        <span className="text-caption text-tertiary font-mono text-[10px]">
                                            {formatFileSize(record.file_size)}
                                        </span>
                                    )}
                                    {isOnline && record.speed && (record.status === "downloading" || record.status === "muxing") && (
                                        <span className="text-caption text-accent font-mono text-[10px]">
                                            {record.speed}
                                        </span>
                                    )}
                                    {isOnline && record.eta && record.eta !== "--" && record.eta !== "NA" && record.eta.toLowerCase() !== "none" && record.eta.trim() !== "" && record.status === "downloading" && (
                                        <span className="text-caption text-tertiary font-mono text-[10px]">
                                            ETA {record.eta}
                                        </span>
                                    )}
                                    {!isOnline && (record.status === "downloading" || record.status === "muxing") && (
                                        <span className="text-caption text-status-warning font-mono text-[10px]">
                                            Paused · will resume when online
                                        </span>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {/* Image 4 Action Cluster */}
                    <div className="shrink-0 flex items-center gap-2">
                        {/* File Size Badge */}
                        {record.file_size && record.file_size > 0 && record.status === "completed" && (
                            <span className="hidden sm:inline-block font-mono font-semibold text-primary text-[11px] bg-surface-2 px-2.5 py-0.5 rounded border border-border-subtle shadow-2xs">
                                {formatFileSize(record.file_size)}
                            </span>
                        )}

                        {/* Status Badge */}
                        {/* W3-9: Show "Waiting for network" when offline and download is active */}
                        {!isOnline && (record.status === "downloading" || record.status === "muxing") ? (
                            <span className="text-caption font-semibold px-2.5 py-0.5 rounded-full flex items-center gap-1 text-[11px] bg-status-warning-subtle text-status-warning">
                                <Loader2 size={10} className="animate-spin" />
                                Waiting for network
                            </span>
                        ) : (
                            <span
                                className={`text-caption font-semibold px-2.5 py-0.5 rounded-full flex items-center gap-1 text-[11px] ${display.colorToken === "accent"
                                    ? "bg-accent-subtle text-accent"
                                    : display.colorToken === "status-success"
                                        ? "bg-status-success-subtle text-status-success"
                                        : display.colorToken === "status-danger"
                                            ? "bg-status-danger-subtle text-status-danger"
                                            : display.colorToken === "status-warning"
                                                ? "bg-status-warning-subtle text-status-warning"
                                                : "bg-surface-2 text-secondary"
                                    }`}
                            >
                                {display.colorToken === "accent" && (
                                    <Loader2 size={10} className="animate-spin" />
                                )}
                                {display.label}
                                {record.status === "downloading" && ` ${record.percent.toFixed(0)}%`}
                                {record.status === "interrupted" && record.percent > 0 && ` · ${record.percent.toFixed(0)}%`}
                            </span>
                        )}

                        {record.status === "error" && onRetry && (
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRetry();
                                }}
                                className="px-2.5 py-1 rounded-md bg-status-danger hover:bg-status-danger/90 text-white flex items-center gap-1 text-[11px] font-semibold transition-all active:scale-95 shrink-0 cursor-pointer"
                                title="Retry download"
                            >
                                <RotateCcw size={11} />
                                <span>Retry</span>
                            </button>
                        )}

                        {/* F-13: Refresh URL — only for expired tokens / network drops */}
                        {record.status === "error"
                            && onRefreshUrl
                            && (record.error_code === "unavailable" || record.error_code === "network") && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRefreshUrl();
                                    }}
                                    className="px-2.5 py-1 rounded-md bg-status-warning hover:bg-status-warning/90 text-white flex items-center gap-1 text-[11px] font-semibold transition-all active:scale-95 shrink-0 cursor-pointer"
                                    title="Paste a fresh URL to resume from .part file"
                                >
                                    <RefreshCw size={11} />
                                    <span>Refresh URL</span>
                                </button>
                            )}

                        {/* Image 4 Clean Action Icons Row: Folder -> Trash -> Link -> Play (Red Circle) -> 3-dots */}
                        <div className="flex items-center gap-1 ml-1">
                            {/* Pause (if actively running) */}
                            {(record.status === "downloading" || record.status === "starting" || record.status === "fetching_metadata" || record.status === "muxing") && onPause && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onPause();
                                    }}
                                    className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-accent flex items-center justify-center transition-colors cursor-pointer"
                                    title="Pause Download"
                                >
                                    <Pause size={15} />
                                </button>
                            )}

                            {/* Resume (if interrupted/paused) */}
                            {record.status === "interrupted" && onResume && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onResume();
                                    }}
                                    className="p-1.5 rounded-lg hover:bg-surface-2 text-accent flex items-center justify-center transition-colors cursor-pointer"
                                    title="Resume Download"
                                >
                                    <Play size={15} fill="currentColor" />
                                </button>
                            )}

                            {/* Cancel (if active or paused) */}
                            {(record.status === "downloading" || record.status === "starting" || record.status === "fetching_metadata" || record.status === "muxing" || record.status === "interrupted") && onCancel && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onCancel();
                                    }}
                                    className="p-1.5 rounded-lg hover:bg-status-danger-subtle text-secondary hover:text-status-danger flex items-center justify-center transition-colors cursor-pointer"
                                    title="Cancel Download"
                                >
                                    <XCircle size={15} />
                                </button>
                            )}

                            {/* 1. Open Folder */}
                            {record.status === "completed" && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onOpenFolder();
                                    }}
                                    className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                                    title={tOpenFolder}
                                >
                                    <Folder size={15} />
                                </button>
                            )}

                            {/* 2. Delete File */}
                            {record.file_path && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDeleteFile();
                                    }}
                                    className="p-1.5 rounded-lg hover:bg-status-danger-subtle text-secondary hover:text-status-danger flex items-center justify-center transition-colors cursor-pointer"
                                    title={tDeleteFile}
                                >
                                    <Trash2 size={15} />
                                </button>
                            )}

                            {/* 3. Copy URL */}
                            {record.url && (
                                <button
                                    type="button"
                                    onClick={handleCopyUrl}
                                    className="p-1.5 rounded-lg hover:bg-surface-2 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                                    title={copied ? "Copied!" : "Copy URL"}
                                >
                                    {copied ? <Check size={15} className="text-status-success" /> : <LinkIcon size={15} />}
                                </button>
                            )}

                            {/* 4. Play (Solid Red Circle matching Image 4) */}
                            {record.status === "completed" && record.file_path && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onOpenFile();
                                    }}
                                    className="w-6 h-6 rounded-full bg-accent hover:bg-accent-hover text-white flex items-center justify-center transition-transform hover:scale-105 active:scale-95 shadow-xs shrink-0 cursor-pointer ml-0.5"
                                    title={tOpenFile}
                                >
                                    <Play size={10} fill="currentColor" className="ml-0.5" />
                                </button>
                            )}

                            {/* 5. More Options Menu */}
                            <div className="relative">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMenuOpen(!menuOpen);
                                    }}
                                    onBlur={() => setTimeout(() => setMenuOpen(false), 200)}
                                    className="w-7 h-7 flex items-center justify-center text-tertiary hover:text-primary rounded-md hover:bg-surface-3 transition-colors cursor-pointer"
                                    title="More options"
                                >
                                    <MoreVertical size={13} />
                                </button>

                                {menuOpen && (
                                    <div className="absolute right-0 top-full mt-1 w-44 bg-surface-1 rounded-xl shadow-floating p-1 z-30 animate-in zoom-in-95 duration-fast border border-border-subtle">
                                        {record.status === "completed" && (
                                            <button
                                                onClick={onOpenFolder}
                                                className="w-full text-left px-2.5 py-1.5 text-caption font-semibold text-primary hover:bg-surface-2 rounded-lg flex items-center gap-2 cursor-pointer"
                                            >
                                                <Folder size={13} /> {tOpenFolder}
                                            </button>
                                        )}
                                        {record.url && (
                                            <button
                                                onClick={handleCopyUrl}
                                                className="w-full text-left px-2.5 py-1.5 text-caption font-semibold text-primary hover:bg-surface-2 rounded-lg flex items-center gap-2 cursor-pointer"
                                            >
                                                <Copy size={13} /> Copy Link
                                            </button>
                                        )}
                                        <button
                                            onClick={onRemove}
                                            className="w-full text-left px-2.5 py-1.5 text-caption font-semibold text-primary hover:bg-surface-2 rounded-lg flex items-center gap-2 cursor-pointer"
                                        >
                                            <X size={13} /> {tRemoveRow}
                                        </button>
                                        {record.file_path && (
                                            <button
                                                onClick={onDeleteFile}
                                                className="w-full text-left px-2.5 py-1.5 text-caption font-semibold text-status-danger hover:bg-status-danger-subtle rounded-lg flex items-center gap-2 cursor-pointer"
                                            >
                                                <Trash2 size={13} /> {tDeleteFile}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* In-Flight Download Progress Bar */}
                {(record.status === "downloading" || record.status === "muxing") && (
                    <div className="w-full bg-surface-2 rounded-full h-1 overflow-hidden mt-1.5 relative">
                        {!isOnline ? (
                            /* W3-9: offline → amber pulse bar. Communicates "paused,
                               waiting for network" without lying about progress. */
                            <div className="indeterminate-bar h-full w-1/3 bg-status-warning rounded-full" />
                        ) : record.status === "downloading" ? (
                            <div
                                className="bg-accent h-full transition-all duration-300"
                                style={{ width: `${Math.min(100, Math.max(0, record.percent))}%` }}
                            />
                        ) : (
                            <div className="indeterminate-bar h-full w-1/3 bg-accent rounded-full" />
                        )}
                    </div>
                )}
            </div>

            {/* Custom Right-Click Desktop Context Menu (Replaces Image 5 WebView Menu) */}
            {contextMenuPos && (
                <div
                    style={{ top: `${contextMenuPos.y}px`, left: `${contextMenuPos.x}px` }}
                    className="fixed z-50 w-52 bg-surface-1 rounded-xl shadow-floating border border-border-subtle p-1.5 animate-in fade-in zoom-in-95 duration-fast space-y-0.5"
                    onClick={(e) => e.stopPropagation()}
                >
                    {record.status === "completed" && record.file_path && (
                        <button
                            type="button"
                            onClick={() => {
                                onOpenFile();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                        >
                            <Play size={14} className="text-accent" />
                            <span>{tOpenFile}</span>
                        </button>
                    )}

                    {record.status === "completed" && (
                        <button
                            type="button"
                            onClick={() => {
                                onOpenFolder();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                        >
                            <Folder size={14} className="text-secondary" />
                            <span>{tOpenFolder}</span>
                        </button>
                    )}

                    {record.url && (
                        <button
                            type="button"
                            onClick={() => {
                                handleCopyUrl();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                        >
                            <Copy size={14} className="text-secondary" />
                            <span>Copy Source Link</span>
                        </button>
                    )}

                    {(record.status === "downloading" || record.status === "starting" || record.status === "muxing") && onPause && (
                        <button
                            type="button"
                            onClick={() => {
                                onPause();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                        >
                            <Pause size={14} className="text-accent" />
                            <span>Pause Download</span>
                        </button>
                    )}

                    {record.status === "interrupted" && onResume && (
                        <button
                            type="button"
                            onClick={() => {
                                onResume();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                        >
                            <Play size={14} className="text-accent" />
                            <span>Resume Download</span>
                        </button>
                    )}

                    {record.status === "error" && onRetry && (
                        <button
                            type="button"
                            onClick={() => {
                                onRetry();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                        >
                            <RotateCcw size={14} className="text-status-danger" />
                            <span>Retry Download</span>
                        </button>
                    )}

                    <div className="my-1 border-t border-border-subtle/60" />

                    <button
                        type="button"
                        onClick={() => {
                            onRemove();
                            setContextMenuPos(null);
                        }}
                        className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-secondary hover:text-primary hover:bg-surface-2 flex items-center gap-2.5 cursor-pointer"
                    >
                        <X size={14} />
                        <span>{tRemoveRow}</span>
                    </button>

                    {record.file_path && (
                        <button
                            type="button"
                            onClick={() => {
                                onDeleteFile();
                                setContextMenuPos(null);
                            }}
                            className="w-full text-left px-3 py-1.5 rounded-lg text-caption font-semibold text-status-danger hover:bg-status-danger-subtle flex items-center gap-2.5 cursor-pointer"
                        >
                            <Trash2 size={14} />
                            <span>{tDeleteFile}</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
});