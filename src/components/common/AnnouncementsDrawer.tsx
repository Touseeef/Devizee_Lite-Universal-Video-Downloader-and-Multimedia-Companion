// src/components/common/AnnouncementsDrawer.tsx
import { useEffect, useState } from "react";
import {
    Bell,
    CheckCheck,
    ExternalLink,
    RefreshCw,
    Shield,
    Sparkles,
    X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnnouncementItem } from "../../lib/announcements";
import { getReadAnnouncementIds } from "../../lib/announcements";

interface AnnouncementsDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    announcements: AnnouncementItem[];
    unreadCount: number;
    onRefresh: () => Promise<void>;
    onMarkAllRead: () => void;
    onMarkRead: (id: string) => void;
}

export function AnnouncementsDrawer({
    isOpen,
    onClose,
    announcements,
    unreadCount,
    onRefresh,
    onMarkAllRead,
    onMarkRead,
}: AnnouncementsDrawerProps) {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [readIds, setReadIds] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setReadIds(getReadAnnouncementIds());
        }
    }, [isOpen, announcements]);

    // Handle ESC key to close
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            await onRefresh();
            setReadIds(getReadAnnouncementIds());
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleCardClick = (id: string) => {
        if (!readIds.includes(id)) {
            onMarkRead(id);
            setReadIds((prev) => [...prev, id]);
        }
    };

    const handleActionClick = async (e: React.MouseEvent, url: string, id: string) => {
        e.stopPropagation();
        handleCardClick(id);
        try {
            await openUrl(url);
        } catch (err) {
            console.error("Failed to open announcement URL:", err);
        }
    };

    const getTagColorClass = (color?: string) => {
        switch (color) {
            case "emerald":
                return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
            case "amber":
                return "bg-amber-500/15 text-amber-400 border-amber-500/30";
            case "sky":
                return "bg-sky-500/15 text-sky-400 border-sky-500/30";
            case "rose":
                return "bg-rose-500/15 text-rose-400 border-rose-500/30";
            case "indigo":
            default:
                return "bg-indigo-500/15 text-indigo-400 border-indigo-500/30";
        }
    };

    // Helper to format simple markdown-like content safely
    const renderContent = (content: string) => {
        const lines = content.split("\n");
        return lines.map((line, idx) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return <div key={idx} className="h-1.5" />;
            }
            if (trimmed.startsWith("### ")) {
                return (
                    <h5 key={idx} className="font-bold text-primary text-body-sm mt-2 mb-1">
                        {trimmed.replace("### ", "")}
                    </h5>
                );
            }
            if (trimmed.startsWith("- ")) {
                const bulletText = trimmed.replace("- ", "");
                const parts = bulletText.split(/(\*\*.*?\*\*)/g);
                return (
                    <div key={idx} className="flex items-start gap-2 text-[12px] text-secondary leading-relaxed pl-1 py-0.5">
                        <span className="text-accent select-none">•</span>
                        <span>
                            {parts.map((p, pIdx) => {
                                if (p.startsWith("**") && p.endsWith("**")) {
                                    return (
                                        <strong key={pIdx} className="font-semibold text-primary">
                                            {p.slice(2, -2)}
                                        </strong>
                                    );
                                }
                                return p;
                            })}
                        </span>
                    </div>
                );
            }
            return (
                <p key={idx} className="text-[12px] text-secondary leading-relaxed py-0.5">
                    {line}
                </p>
            );
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex justify-end animate-in fade-in duration-200">
            {/* Backdrop overlay */}
            <div
                onClick={onClose}
                className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
            />

            {/* Slide-out Drawer Panel */}
            <div className="relative w-full max-w-[460px] h-full bg-surface-1 border-l border-border-subtle shadow-floating flex flex-col z-10 animate-in slide-in-from-right duration-300">
                {/* Drawer Header */}
                <div className="p-4 border-b border-border-subtle bg-surface-1/95 backdrop-blur-md flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-accent/15 text-accent flex items-center justify-center shrink-0">
                            <Bell size={16} />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h3 className="font-bold text-body text-primary tracking-tight">
                                    Announcements
                                </h3>
                                {unreadCount > 0 && (
                                    <span className="px-1.5 py-0.2 rounded-full bg-accent text-white text-[10px] font-bold">
                                        {unreadCount} new
                                    </span>
                                )}
                            </div>
                            <p className="text-[11px] text-tertiary truncate">
                                Updates, developer notes & tips
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            type="button"
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            className={`p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer ${
                                isRefreshing ? "animate-spin text-accent" : ""
                            }`}
                            title="Check for updates"
                        >
                            <RefreshCw size={14} />
                        </button>

                        {unreadCount > 0 && (
                            <button
                                type="button"
                                onClick={() => {
                                    onMarkAllRead();
                                    setReadIds(announcements.map((a) => a.id));
                                }}
                                className="px-2 py-1 rounded-lg text-[11px] font-semibold text-secondary hover:text-accent hover:bg-surface-2 flex items-center gap-1 transition-colors cursor-pointer"
                                title="Mark all as read"
                            >
                                <CheckCheck size={13} />
                                <span>Mark read</span>
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={onClose}
                            className="p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer ml-1"
                            title="Close (Esc)"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* Drawer Content — Scrollable Announcement Cards */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3.5 custom-scrollbar">
                    {announcements.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                            <div className="w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center text-tertiary">
                                <Sparkles size={22} />
                            </div>
                            <div>
                                <h4 className="font-semibold text-primary text-body-sm">
                                    You're all caught up!
                                </h4>
                                <p className="text-[12px] text-tertiary mt-1 max-w-xs">
                                    No new announcements at this time. Check back later for updates and developer notes.
                                </p>
                            </div>
                        </div>
                    ) : (
                        announcements.map((item) => {
                            const isRead = readIds.includes(item.id);
                            return (
                                <div
                                    key={item.id}
                                    onClick={() => handleCardClick(item.id)}
                                    className={`rounded-xl border p-4 transition-all cursor-pointer ${
                                        isRead
                                            ? "bg-surface-2/40 border-border-subtle/60 hover:bg-surface-2/70"
                                            : "bg-surface-2/80 border-accent/30 shadow-xs hover:border-accent/60"
                                    }`}
                                >
                                    {/* Card Header Info */}
                                    <div className="flex items-center justify-between gap-2 mb-2">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            {item.tag && (
                                                <span
                                                    className={`px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase tracking-wider ${getTagColorClass(
                                                        item.tagColor
                                                    )}`}
                                                >
                                                    {item.tag}
                                                </span>
                                            )}
                                            {item.version && (
                                                <span className="px-1.5 py-0.5 rounded bg-surface-3 text-[10px] font-mono font-medium text-secondary">
                                                    {item.version}
                                                </span>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-1.5 text-[11px] text-tertiary">
                                            <span>{item.date}</span>
                                            {!isRead && (
                                                <span
                                                    className="w-2 h-2 rounded-full bg-accent ring-2 ring-surface-1 shrink-0"
                                                    title="Unread"
                                                />
                                            )}
                                        </div>
                                    </div>

                                    {/* Card Title */}
                                    <h4 className="font-bold text-body-sm text-primary leading-snug mb-1">
                                        {item.title}
                                    </h4>

                                    {/* Summary preview */}
                                    {item.summary && (
                                        <p className="text-[12px] text-secondary leading-relaxed mb-2">
                                            {item.summary}
                                        </p>
                                    )}

                                    {/* Expandable / Formatted Content */}
                                    {item.content && (
                                        <div className="pt-2 border-t border-border-subtle/50 space-y-0.5">
                                            {renderContent(item.content)}
                                        </div>
                                    )}

                                    {/* Action CTA Button */}
                                    {item.action && (
                                        <div className="mt-3 pt-2.5 border-t border-border-subtle/50 flex items-center justify-end">
                                            <button
                                                type="button"
                                                onClick={(e) => handleActionClick(e, item.action!.url, item.id)}
                                                className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent/90 text-white text-[11px] font-bold flex items-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
                                            >
                                                <span>{item.action.label}</span>
                                                <ExternalLink size={12} />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Privacy-First Footer */}
                <div className="p-3 border-t border-border-subtle bg-surface-2/40 flex items-center gap-2 text-[11px] text-tertiary">
                    <Shield size={14} className="text-accent shrink-0" />
                    <span className="leading-tight">
                        Privacy-First: Public feed checked anonymously. No telemetry or user data is ever collected.
                    </span>
                </div>
            </div>
        </div>
    );
}
