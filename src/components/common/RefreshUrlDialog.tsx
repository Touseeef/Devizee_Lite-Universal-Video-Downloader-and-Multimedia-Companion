import { useState, useEffect } from "react";
import { RefreshCw, X, AlertTriangle, Check, Loader2 } from "lucide-react";
import type { DownloadRecord } from "../../types";

export type RefreshUrlDialogState = {
    isOpen: boolean;
    record: DownloadRecord | null;
    oldUrl: string;
    errorCode?: string;
};

// Extract the video ID from a URL — YouTube-specific but tolerant
function extractVideoId(url: string): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        const v = u.searchParams.get("v");
        if (v) return v;
        // youtu.be/ID
        if (u.hostname === "youtu.be") {
            const id = u.pathname.slice(1);
            return id || null;
        }
        // youtube.com/shorts/ID, /embed/ID
        const m = u.pathname.match(/\/(?:shorts|embed|v)\/([\w-]{11})/);
        if (m) return m[1];
    } catch {
        // Non-URL input — try regex as fallback
    }
    const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{11})/);
    return m ? m[1] : null;
}

export function RefreshUrlDialog({
    state,
    onResume,
    onCancel,
}: {
    state: RefreshUrlDialogState;
    onResume: (record: DownloadRecord, newUrl: string) => void;
    onCancel: () => void;
}) {
    const [newUrl, setNewUrl] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (state.isOpen) {
            setNewUrl("");
            setIsSubmitting(false);
        }
    }, [state.isOpen]);

    useEffect(() => {
        if (!state.isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [state.isOpen, onCancel]);

    if (!state.isOpen || !state.record) return null;

    const oldId = extractVideoId(state.oldUrl);
    const newId = extractVideoId(newUrl.trim());
    const idMismatch = oldId && newId && oldId !== newId;
    const canSubmit = newUrl.trim().length > 8 && !idMismatch;

    const handleSubmit = async () => {
        if (!canSubmit || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await onResume(state.record!, newUrl.trim());
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in p-4">
            <div className="bg-surface-1 rounded-2xl border border-border-strong shadow-floating max-w-xl w-full space-y-5 animate-in zoom-in-95 p-6">
                {/* Header */}
                <div className="flex items-start gap-3 pb-4 border-b border-border-subtle">
                    <div className="w-9 h-9 rounded-xl bg-status-warning/15 text-status-warning flex items-center justify-center shrink-0">
                        <RefreshCw size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                            <h3 className="text-body font-bold text-primary">
                                Refresh Download Address
                            </h3>
                            <button
                                type="button"
                                onClick={onCancel}
                                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-2 text-tertiary hover:text-primary transition-colors cursor-pointer"
                                title="Close"
                            >
                                <X size={15} />
                            </button>
                        </div>
                        <p className="text-caption text-secondary mt-1">
                            The original download link expired. Paste a fresh link from your browser and Devizee will resume from where it stopped.
                        </p>
                    </div>
                </div>

                {/* Old URL info */}
                <div className="p-3 rounded-xl bg-surface-2/60 border border-border-subtle space-y-1.5">
                    <div className="text-[10px] uppercase font-bold tracking-wider text-tertiary">
                        Current download
                    </div>
                    <p
                        className="text-caption font-semibold text-primary truncate"
                        title={state.record.title}
                    >
                        {state.record.title}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-tertiary">
                        <span>{state.record.format}</span>
                        {oldId && (
                            <>
                                <span>·</span>
                                <span className="text-accent">ID: {oldId}</span>
                            </>
                        )}
                    </div>
                </div>

                {/* New URL input */}
                <div className="space-y-2">
                    <label className="text-caption font-bold text-primary block">
                        New download URL
                    </label>
                    <input
                        type="text"
                        value={newUrl}
                        onChange={(e) => setNewUrl(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && canSubmit) handleSubmit();
                        }}
                        placeholder="https://www.youtube.com/watch?v=..."
                        className="w-full px-3 py-2.5 rounded-xl bg-surface-2 border border-border-subtle text-body-sm font-mono text-primary placeholder:text-tertiary outline-none focus:border-accent transition-colors"
                        autoFocus
                    />

                    {/* Validation feedback */}
                    {idMismatch && (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-status-danger-subtle/30 border border-status-danger/30 text-caption">
                            <AlertTriangle size={13} className="text-status-danger shrink-0 mt-0.5" />
                            <div>
                                <p className="font-bold text-status-danger">
                                    Different video detected
                                </p>
                                <p className="text-secondary">
                                    Old ID: <span className="font-mono">{oldId}</span> · New ID:{" "}
                                    <span className="font-mono">{newId}</span>
                                </p>
                                <p className="text-secondary mt-1">
                                    Resuming from a different video would produce a corrupted file. Cancel this and start a fresh download instead.
                                </p>
                            </div>
                        </div>
                    )}

                    {!idMismatch && newId && oldId && newId === oldId && (
                        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-status-success-subtle/30 border border-status-success/30 text-caption">
                            <Check size={13} className="text-status-success shrink-0" />
                            <span className="text-secondary">
                                Video ID matches. Resume will continue from the existing <span className="font-mono">.part</span> file.
                            </span>
                        </div>
                    )}

                    {!idMismatch && newUrl.trim().length > 0 && !newId && (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-surface-2 border border-border-subtle text-caption">
                            <AlertTriangle size={13} className="text-tertiary shrink-0 mt-0.5" />
                            <span className="text-secondary">
                                Non-YouTube URL. Devizee will attempt to resume but cannot verify the file identity.
                            </span>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2.5 pt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 rounded-xl bg-surface-2 hover:bg-surface-3 text-secondary text-caption font-bold transition-colors cursor-pointer"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!canSubmit || isSubmitting}
                        onClick={handleSubmit}
                        className="px-5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-caption font-bold shadow-sm transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 size={13} className="animate-spin" />
                                <span>Resuming...</span>
                            </>
                        ) : (
                            <>
                                <RefreshCw size={13} />
                                <span>Resume Download</span>
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}