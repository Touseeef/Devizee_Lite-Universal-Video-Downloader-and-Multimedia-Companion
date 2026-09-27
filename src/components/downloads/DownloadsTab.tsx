import { useState } from "react";
import {
    AlertTriangle,
    ArrowDownToLine,
    Ban,
    Pause,
    Play,
    X,
    XCircle,
} from "lucide-react";
import type { DownloadRecord } from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import { StatCard } from "./StatCard";
import { ActivityList } from "./ActivityList";

type QueueFilter =
    | "all"
    | "video"
    | "audio"
    | "active"
    | "queued"
    | "completed"
    | "attention";

type SortBy =
    | "date_desc"
    | "date_asc"
    | "size_desc"
    | "size_asc"
    | "title"
    | "progress";

export function DownloadsTab({
    t,
    isOnline,
    sortedHistory,
    activitySearchQuery,
    setActivitySearchQuery,
    queueFilter,
    setQueueFilter,
    sortBy,
    setSortBy,
    selectedHistoryItems,
    setSelectedHistoryItems,
    activeCount,
    queuedCount,
    attentionCount,
    completedCount,
    cardItems,
    openFolder,
    openFile,
    handleRemoveHistory,
    handleDeleteFile,
    handleRetryDownload,
    onPauseAll,
    onResumeAll,
    onCancelAll,
    onCancelSelected,
    onPauseDownload,
    onResumeDownload,
    onCancelDownload,
    onPauseSelected,
    onResumeSelected,
    onRefreshUrl,
}: {
    t: (key: TranslationKey) => string;
    isOnline: boolean;
    sortedHistory: DownloadRecord[];
    activitySearchQuery: string;
    setActivitySearchQuery: (v: string) => void;
    queueFilter: QueueFilter;
    setQueueFilter: (v: QueueFilter) => void;
    sortBy: SortBy;
    setSortBy: (v: SortBy) => void;
    selectedHistoryItems: Set<string>;
    setSelectedHistoryItems: (v: Set<string>) => void;
    activeCount: number;
    queuedCount: number;
    attentionCount: number;
    completedCount: number;
    cardItems: {
        active: DownloadRecord[];
        queued: DownloadRecord[];
        attention: DownloadRecord[];
        completed: DownloadRecord[];
    };
    openFolder: (path?: string | null) => void;
    openFile: (path?: string | null) => void;
    handleRemoveHistory: (id: string) => void;
    handleDeleteFile: (id: string, path: string | null) => void;
    handleRetryDownload: (record: DownloadRecord) => void;
    onPauseAll?: () => void;
    onResumeAll?: () => void;
    onCancelAll?: () => void;
    onCancelSelected?: () => void;
    onPauseDownload?: (id: string) => void;
    onResumeDownload?: (record: DownloadRecord) => void;
    onCancelDownload?: (id: string) => void;
    onPauseSelected?: () => void;
    onResumeSelected?: () => void;
    onRefreshUrl?: (record: DownloadRecord) => void;
}) {
    // F-36: Dismissible interrupted-downloads recovery banner.
    const [bannerDismissed, setBannerDismissed] = useState(false);
    const interruptedCount = sortedHistory.filter((h) => h.status === "interrupted").length;

    return (
        <div className="max-w-5xl xl:max-w-6xl mx-auto space-y-6">
            {interruptedCount > 0 && !bannerDismissed && (
                <div className="bg-status-warning-subtle/40 border border-status-warning/40 rounded-xl p-3.5 flex items-center justify-between gap-3 animate-in fade-in duration-fast">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-status-warning-subtle text-status-warning flex items-center justify-center shrink-0">
                            <AlertTriangle size={15} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-body-sm font-bold text-primary">
                                {interruptedCount} paused {interruptedCount === 1 ? "download" : "downloads"}
                            </p>
                            <p className="text-caption text-secondary truncate">
                                These can be resumed at any time. No progress was lost.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {onResumeAll && (
                            <button
                                type="button"
                                onClick={onResumeAll}
                                className="px-3 py-1.5 rounded-lg bg-status-warning hover:bg-status-warning/90 text-white text-caption font-bold flex items-center gap-1.5 shadow-xs transition-colors cursor-pointer"
                                title="Resume all paused downloads"
                            >
                                <Play size={12} fill="currentColor" />
                                <span>Resume All</span>
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setBannerDismissed(true)}
                            className="w-7 h-7 rounded-lg hover:bg-surface-2 text-tertiary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                            title="Dismiss banner"
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            )}

            {/* Header Banner */}
            <div className="bg-surface-1 rounded-xl p-5 border border-border-subtle shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                    <div className="w-10 h-10 rounded-xl bg-accent-subtle text-accent flex items-center justify-center shrink-0 shadow-xs">
                        <ArrowDownToLine size={20} strokeWidth={2.2} />
                    </div>
                    <div>
                        <h2 className="font-bold text-body-lg text-primary leading-tight">
                            Downloads Manager
                        </h2>
                        <p className="text-caption text-secondary mt-0.5">
                            Real-time download tasks, queues, and task history
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-semibold px-2.5 py-1.5 rounded-lg bg-surface-2 text-primary border border-border-subtle shadow-2xs">
                        {activeCount} active • {queuedCount} queued • {completedCount} finished
                    </span>
                </div>
            </div>

            {/* Global Queue Action Toolbar */}
            <div className="bg-surface-1 rounded-xl p-3 border border-border-subtle flex flex-wrap items-center justify-between gap-3 shadow-2xs">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onPauseAll}
                        className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold text-secondary hover:text-primary flex items-center gap-1.5 border border-border-subtle transition-colors cursor-pointer"
                        title="Pause all running downloads"
                    >
                        <Pause size={13} />
                        <span>Pause All</span>
                    </button>

                    <button
                        type="button"
                        onClick={onResumeAll}
                        className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold text-secondary hover:text-primary flex items-center gap-1.5 border border-border-subtle transition-colors cursor-pointer"
                        title="Resume all queued and paused downloads"
                    >
                        <Play size={13} fill="currentColor" />
                        <span>Resume All</span>
                    </button>

                    <button
                        type="button"
                        onClick={onCancelAll}
                        className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-status-danger-subtle text-caption font-semibold text-secondary hover:text-status-danger flex items-center gap-1.5 border border-border-subtle transition-colors cursor-pointer"
                        title="Cancel all active tasks"
                    >
                        <XCircle size={13} />
                        <span>Cancel All</span>
                    </button>
                </div>

                {/* Selected Tasks Actions */}
                {selectedHistoryItems.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 animate-in fade-in duration-fast">
                        <span className="text-caption font-semibold text-accent pr-1">
                            {selectedHistoryItems.size} selected
                        </span>

                        {onPauseSelected && (
                            <button
                                type="button"
                                onClick={onPauseSelected}
                                className="px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-caption font-semibold text-secondary hover:text-primary flex items-center gap-1.5 shadow-xs cursor-pointer transition-colors"
                                title="Pause selected downloads"
                            >
                                <Pause size={13} />
                                <span>Pause Selected</span>
                            </button>
                        )}

                        {onResumeSelected && (
                            <button
                                type="button"
                                onClick={onResumeSelected}
                                className="px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-caption font-semibold text-secondary hover:text-primary flex items-center gap-1.5 shadow-xs cursor-pointer transition-colors"
                                title="Resume selected downloads"
                            >
                                <Play size={13} fill="currentColor" />
                                <span>Resume Selected</span>
                            </button>
                        )}

                        {onCancelSelected && (
                            <button
                                type="button"
                                onClick={onCancelSelected}
                                className="px-2.5 py-1.5 rounded-lg bg-status-danger text-white text-caption font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer hover:bg-status-danger/90 transition-colors"
                                title="Cancel selected downloads"
                            >
                                <Ban size={13} />
                                <span>Cancel Selected</span>
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* StatCards — 4 state tiles (click to filter) */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                    variant="active"
                    count={activeCount}
                    items={cardItems.active}
                    active={queueFilter === "active"}
                    onClick={() =>
                        setQueueFilter(queueFilter === "active" ? "all" : "active")
                    }
                />
                <StatCard
                    variant="queued"
                    count={queuedCount}
                    items={cardItems.queued}
                    active={queueFilter === "queued"}
                    onClick={() =>
                        setQueueFilter(queueFilter === "queued" ? "all" : "queued")
                    }
                />
                <StatCard
                    variant="attention"
                    count={attentionCount}
                    items={cardItems.attention}
                    active={queueFilter === "attention"}
                    onClick={() =>
                        setQueueFilter(queueFilter === "attention" ? "all" : "attention")
                    }
                />
                <StatCard
                    variant="completed"
                    count={completedCount}
                    items={cardItems.completed}
                    active={queueFilter === "completed"}
                    onClick={() =>
                        setQueueFilter(queueFilter === "completed" ? "all" : "completed")
                    }
                />
            </div>

            {/* Comprehensive Activity List */}
            <ActivityList
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
                onOpenFolder={openFolder}
                onOpenFile={openFile}
                onRemove={handleRemoveHistory}
                onDeleteFile={handleDeleteFile}
                onRetry={handleRetryDownload}
                onPause={onPauseDownload}
                onResume={onResumeDownload}
                onCancel={onCancelDownload}
                onRefreshUrl={onRefreshUrl}
            />
        </div>
    );
}
