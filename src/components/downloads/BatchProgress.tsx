import { useEffect } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import type { DownloadRecord } from "../../types";

export function BatchProgress({
    title,
    taskIds,
    formatLabel,
    history,
    onClear,
}: {
    title: string;
    taskIds: string[];
    formatLabel: string;
    history: DownloadRecord[];
    onClear: () => void;
}) {
    const batchItems = history.filter((h) =>
        taskIds.some((id) => h.id.startsWith(id) || h.id === id)
    );
    const finished = batchItems.filter((h) => h.status === "completed").length;
    const total = taskIds.length;
    const isComplete = total > 0 && finished === total;
    const avgPercent =
        batchItems.length > 0
            ? Math.round(batchItems.reduce((acc, h) => acc + h.percent, 0) / total)
            : 0;

    // Auto-dismiss completed batch notification from the dashboard after 5 seconds
    useEffect(() => {
        if (!isComplete) return;
        const timer = setTimeout(() => {
            onClear();
        }, 5000);
        return () => clearTimeout(timer);
    }, [isComplete, onClear]);

    return (
        <div className={`bg-surface-1 rounded-xl p-4 border transition-all animate-in fade-in slide-in-from-bottom-2 duration-fast ${isComplete ? "border-status-success/40 bg-status-success-subtle/10" : "border-accent/30 shadow-sm"
            } space-y-2.5`}>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                    {isComplete ? (
                        <CheckCircle2 size={18} className="text-status-success shrink-0" />
                    ) : (
                        <Loader2 size={16} className="animate-spin text-accent shrink-0" />
                    )}
                    <div>
                        <h4 className="font-semibold text-body-sm text-primary">
                            {isComplete ? `Batch Completed: ${title}` : `Batch Downloading: ${title}`}
                        </h4>
                        <p className="text-caption text-secondary">
                            Format:{" "}
                            <span className="font-mono font-semibold text-accent">{formatLabel}</span>{" "}
                            • {isComplete ? `All ${total} items finished` : `${total} items in batch`}
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onClear}
                    className="p-1 rounded-lg text-tertiary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                    title="Dismiss"
                >
                    <X size={15} />
                </button>
            </div>

            <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-caption text-secondary">
                    <span>
                        {finished} of {total} completed
                    </span>
                    <span className="font-mono font-semibold text-primary">{avgPercent}%</span>
                </div>
                <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                    <div
                        className={`h-full transition-all duration-300 ${isComplete ? "bg-status-success" : "bg-accent"
                            }`}
                        style={{ width: `${avgPercent}%` }}
                    />
                </div>
            </div>
        </div>
    );
}