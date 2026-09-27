import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

export function CloseAppConfirmDialog({
    isOpen,
    activeCount,
    onContinueDownloading,
    onCloseApp,
}: {
    isOpen: boolean;
    activeCount: number;
    onContinueDownloading: () => void;
    onCloseApp: (dontWarnAgain: boolean) => void;
}) {
    const [dontWarnAgain, setDontWarnAgain] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onContinueDownloading();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isOpen, onContinueDownloading]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100] animate-in fade-in select-none">
            <div className="bg-surface-1 rounded-xl border border-border-strong shadow-2xl p-5 max-w-md w-full space-y-4 animate-in zoom-in-95 mx-4">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-status-danger/15 text-status-danger flex items-center justify-center shrink-0">
                        <AlertTriangle size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-body font-bold text-primary">
                            Active Downloads in Progress
                        </h3>
                        <p className="text-caption text-secondary mt-1.5 leading-relaxed">
                            {activeCount === 1
                                ? "A download is currently active. Closing Devizee now will cancel this downloading task."
                                : `${activeCount} downloads are currently active. Closing Devizee now will cancel these downloading tasks.`}
                        </p>
                    </div>
                </div>

                <div className="p-3 rounded-lg bg-surface-2/60 border border-border-subtle flex items-center gap-2.5">
                    <input
                        type="checkbox"
                        id="dont-warn-close-app"
                        checked={dontWarnAgain}
                        onChange={(e) => setDontWarnAgain(e.target.checked)}
                        className="rounded border-border-subtle text-accent focus:ring-accent cursor-pointer"
                    />
                    <label
                        htmlFor="dont-warn-close-app"
                        className="text-caption text-secondary cursor-pointer select-none font-medium"
                    >
                        Don't warn me again (can be reset in Settings)
                    </label>
                </div>

                <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-border-subtle">
                    <button
                        type="button"
                        onClick={onContinueDownloading}
                        className="px-4 py-2 bg-surface-2 hover:bg-surface-3 text-primary rounded-lg text-caption font-semibold transition-colors border border-border-subtle cursor-pointer"
                    >
                        Continue Downloading
                    </button>
                    <button
                        type="button"
                        onClick={() => onCloseApp(dontWarnAgain)}
                        className="px-4 py-2 bg-status-danger hover:bg-status-danger/90 text-white rounded-lg text-caption font-semibold transition-colors shadow-sm cursor-pointer"
                    >
                        Close App
                    </button>
                </div>
            </div>
        </div>
    );
}
