import { useState } from "react";
import {
    Clipboard,
    Download,
    Layers,
    Loader2,
    Search,
    X,
} from "lucide-react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { BatchUrlModal } from "./BatchUrlModal";

export function UrlInput({
    url,
    setUrl,
    isFetching,
    isSearchingYoutube,
    onAnalyze,
    onClear,
    onImportTxtLines,
    placeholder,
    labelAnalyze,
    labelAnalyzing,
    hasActiveResult = false,
}: {
    url: string;
    setUrl: (v: string) => void;
    isFetching: boolean;
    isSearchingYoutube: boolean;
    onAnalyze: (e?: React.FormEvent, directUrl?: string) => void;
    onClear: () => void;
    onImportTxtLines: (lines: string[]) => void;
    placeholder: string;
    labelAnalyze: string;
    labelAnalyzing: string;
    hasActiveResult?: boolean;
}) {
    const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);

    const handlePasteClipboard = async () => {
        let text = "";
        try {
            const clipText = await readText();
            if (clipText && clipText.trim()) text = clipText.trim();
        } catch { }
        if (!text) {
            try {
                const clipText = await navigator.clipboard.readText();
                if (clipText && clipText.trim()) text = clipText.trim();
            } catch (e) {
                console.error("Clipboard access failed:", e);
            }
        }
        if (text) {
            setUrl(text);
            if (/^https?:\/\//i.test(text)) {
                onAnalyze(undefined, text);
            }
        }
    };

    return (
        <div className={`w-full transition-all duration-300 ${hasActiveResult ? "pt-1 pb-2" : "py-8 max-w-3xl mx-auto text-center"}`}>
            {/* Hero Header (Visible when no media is actively inspected) */}
            {!hasActiveResult && (
                <div className="mb-6 space-y-2">
                    <h1 className="text-display font-extrabold text-primary tracking-tight">
                        Download Any Video or Audio
                    </h1>
                    <p className="text-secondary text-body max-w-lg mx-auto">
                        Paste links from YouTube, TikTok, Instagram, SoundCloud, Vimeo, and 1,000+ supported sites.
                    </p>
                </div>
            )}

            {/* Input Form with Outside Batch TXT and Analyze Buttons */}
            <form onSubmit={onAnalyze} className="flex items-center gap-2.5 w-full">
                {/* Search Bar Input Container */}
                <div className="relative flex-1 shadow-raised rounded-xl bg-surface-1 border border-border-subtle focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 transition-all flex items-center h-14">
                    <div className="pl-4 pr-3 flex items-center pointer-events-none text-accent shrink-0">
                        <Search size={20} strokeWidth={2.5} />
                    </div>

                    <input
                        type="text"
                        placeholder={placeholder}
                        className="w-full bg-transparent h-full text-body font-medium transition-colors outline-none text-primary placeholder:text-tertiary truncate pr-2"
                        value={url}
                        onChange={(e) => {
                            setUrl(e.target.value);
                            if (!e.target.value.trim()) onClear();
                        }}
                    />

                    <div className="flex items-center gap-1.5 pr-2.5 shrink-0">
                        {url && (
                            <button
                                type="button"
                                onClick={onClear}
                                className="w-8 h-8 flex items-center justify-center rounded-lg text-tertiary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                                title="Clear URL"
                            >
                                <X size={15} />
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={handlePasteClipboard}
                            className="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 hover:bg-surface-3 text-secondary hover:text-primary border border-border-subtle transition-colors cursor-pointer"
                            title="Paste from clipboard"
                        >
                            <Clipboard size={16} />
                        </button>
                    </div>
                </div>

                {/* Batch Links Button (Outside Field) */}
                <button
                    type="button"
                    onClick={() => setIsBatchModalOpen(true)}
                    className="h-14 px-4 rounded-xl bg-surface-1 hover:bg-surface-2 text-secondary hover:text-primary border border-border-subtle font-semibold text-caption sm:text-body-sm transition-all flex items-center gap-2 shrink-0 shadow-raised cursor-pointer active:scale-[0.98]"
                    title="Import or paste multiple URLs for batch downloading"
                >
                    <Layers size={16} className="text-accent" />
                    <span className="hidden sm:inline">Batch Links</span>
                </button>

                {/* Primary Analyze Action Button */}
                <button
                    type="submit"
                    disabled={isFetching || !url.trim()}
                    className="h-14 px-5 sm:px-6 rounded-xl bg-accent hover:bg-accent-hover text-white font-bold text-body-sm transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 shadow-raised shrink-0 cursor-pointer"
                >
                    {isFetching ? (
                        <Loader2 size={18} className="animate-spin" />
                    ) : isSearchingYoutube ? (
                        <Search size={18} />
                    ) : (
                        <Download size={18} strokeWidth={2.5} />
                    )}
                    <span>
                        {isFetching ? (isSearchingYoutube ? "Searching..." : labelAnalyzing) : labelAnalyze}
                    </span>
                </button>
            </form>

            {/* Batch URL Importer Dialog Modal */}
            <BatchUrlModal
                isOpen={isBatchModalOpen}
                onClose={() => setIsBatchModalOpen(false)}
                onImportUrls={(urls) => onImportTxtLines(urls)}
            />
        </div>
    );
}