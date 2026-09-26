import { Download, Search, X } from "lucide-react";
import type { DownloadRecord } from "../../types";
import type { TranslationKey } from "../../lib/i18n";
import { HistoryItem } from "./HistoryItem";

import React from "react";

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

export const ActivityList = React.memo(function ActivityList({
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
    onOpenFolder,
    onOpenFile,
    onRemove,
    onDeleteFile,
    onRetry,
    onPause,
    onResume,
    onCancel,
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
    onOpenFolder: (path?: string | null) => void;
    onOpenFile: (path?: string | null) => void;
    onRemove: (id: string) => void;
    onDeleteFile: (id: string, path: string | null) => void;
    onRetry: (record: DownloadRecord) => void;
    onPause?: (id: string) => void;
    onResume?: (record: DownloadRecord) => void;
    onCancel?: (id: string) => void;
    onRefreshUrl?: (record: DownloadRecord) => void;
}) {
    const allSelected =
        sortedHistory.length > 0 &&
        selectedHistoryItems.size === sortedHistory.length;

    const toggleAll = () => {
        if (allSelected) setSelectedHistoryItems(new Set());
        else setSelectedHistoryItems(new Set(sortedHistory.map((h) => h.id)));
    };

    return (
        <div className="space-y-3">
            {/* Header row */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[44px]">
                <h3 className="text-body font-semibold text-primary">
                    {t("activity_title")}{" "}
                    <span className="text-caption text-tertiary font-normal ml-1">
                        ({sortedHistory.length})
                    </span>
                </h3>

                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex items-center">
                        <Search
                            className="absolute left-2.5 text-tertiary pointer-events-none"
                            size={13}
                        />
                        <input
                            type="text"
                            placeholder="Search..."
                            value={activitySearchQuery}
                            onChange={(e) => setActivitySearchQuery(e.target.value)}
                            className="bg-surface-1 border border-border-subtle rounded-md pl-8 pr-7 h-8 text-caption font-medium text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent w-36 sm:w-44"
                        />
                        {activitySearchQuery && (
                            <button
                                type="button"
                                onClick={() => setActivitySearchQuery("")}
                                className="absolute right-2 text-tertiary hover:text-primary"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>

                    <select
                        value={queueFilter}
                        onChange={(e) => setQueueFilter(e.target.value as QueueFilter)}
                        className="bg-surface-1 border border-border-subtle rounded-md px-2.5 h-8 text-caption font-medium text-primary hover:bg-surface-2 outline-none cursor-pointer"
                    >
                        <option value="all">{t("filter_all")}</option>
                        <option value="active">{t("filter_active")}</option>
                        <option value="queued">Queued</option>
                        <option value="completed">{t("tile_completed")}</option>
                        <option value="attention">{t("tile_attention")}</option>
                        <option value="video">{t("filter_video")}</option>
                        <option value="audio">{t("filter_audio")}</option>
                    </select>

                    <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as SortBy)}
                        className="bg-surface-1 border border-border-subtle rounded-md px-2.5 h-8 text-caption font-medium text-primary hover:bg-surface-2 outline-none cursor-pointer"
                    >
                        <option value="date_desc">Newest First</option>
                        <option value="date_asc">Oldest First</option>
                        <option value="size_desc">Largest Size</option>
                        <option value="size_asc">Smallest Size</option>
                        <option value="title">Title A-Z</option>
                        <option value="progress">Progress</option>
                    </select>
                </div>
            </div>

            {sortedHistory.length === 0 ? (
                <div className="py-16 text-center bg-surface-1 rounded-xl border border-border-subtle animate-in fade-in duration-fast">
                    <Download size={20} className="mx-auto mb-3 text-tertiary" />
                    <p className="text-body-sm text-secondary font-medium">
                        {t("no_tasks")}
                    </p>
                </div>
            ) : (
                <div className="bg-surface-1 rounded-xl border border-border-subtle overflow-hidden">
                    {/* Toolbar */}
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-surface-2/40">
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                className="w-3.5 h-3.5 rounded text-accent accent-accent cursor-pointer"
                                checked={allSelected}
                                onChange={toggleAll}
                            />
                            <span className="text-caption font-medium text-secondary">
                                Select All
                            </span>
                        </label>
                        {selectedHistoryItems.size > 0 && (
                            <span className="text-caption text-accent font-semibold">
                                {selectedHistoryItems.size} selected
                            </span>
                        )}
                    </div>

                    {/* Rows */}
                    <div>
                        {sortedHistory.map((record) => (
                            <div
                                key={record.id}
                                className="flex items-stretch border-b border-border-subtle last:border-b-0 transition-colors hover:bg-surface-2/40"
                            >
                                <div className="flex items-center pl-3 shrink-0">
                                    <input
                                        type="checkbox"
                                        className="w-3.5 h-3.5 rounded text-accent accent-accent cursor-pointer"
                                        checked={selectedHistoryItems.has(record.id)}
                                        onChange={(e) => {
                                            const next = new Set(selectedHistoryItems);
                                            if (e.target.checked) next.add(record.id);
                                            else next.delete(record.id);
                                            setSelectedHistoryItems(next);
                                        }}
                                    />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <HistoryItem
                                        record={record}
                                        isOnline={isOnline}
                                        onOpenFolder={() => onOpenFolder(record.file_path)}
                                        onOpenFile={() => onOpenFile(record.file_path)}
                                        onRemove={() => onRemove(record.id)}
                                        onDeleteFile={() => onDeleteFile(record.id, record.file_path)}
                                        onRetry={() => onRetry(record)}
                                        onPause={onPause ? () => onPause(record.id) : undefined}
                                        onResume={onResume ? () => onResume(record) : undefined}
                                        onCancel={onCancel ? () => onCancel(record.id) : undefined}
                                        onRefreshUrl={onRefreshUrl ? () => onRefreshUrl(record) : undefined}
                                        tOpenFolder={t("open_folder")}
                                        tOpenFile={t("open_file")}
                                        tRemoveRow={t("remove_row")}
                                        tDeleteFile={t("delete_file")}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
});