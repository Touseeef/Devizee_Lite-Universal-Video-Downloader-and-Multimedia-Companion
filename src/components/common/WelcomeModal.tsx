import {
    HelpCircle,
    Shield,
    X,
} from "lucide-react";

export function WelcomeModal({
    isOpen,
    onClose,
}: {
    isOpen: boolean;
    onClose: () => void;
}) {
    if (!isOpen) return null;

    const handleDismiss = () => {
        try {
            localStorage.setItem("devizee_welcome_seen", "true");
        } catch { }
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-fast">
            <div className="bg-surface-1 border border-border-subtle rounded-2xl max-w-xl w-full shadow-floating overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header Banner */}
                <div className="relative p-6 bg-gradient-to-br from-accent/15 via-surface-1 to-surface-2 border-b border-border-subtle">
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-xl bg-accent text-white flex items-center justify-center font-black text-title shadow-sm">
                                DV
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <h2 className="font-extrabold text-title-sm text-primary tracking-tight">
                                        Welcome to Devizee Lite
                                    </h2>
                                    <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-bold">
                                        v0.5.2
                                    </span>
                                </div>
                                <p className="text-caption text-secondary mt-0.5">
                                    Universal, privacy-first multimedia downloader & engine
                                </p>
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="w-8 h-8 rounded-lg hover:bg-surface-3/80 text-secondary hover:text-primary flex items-center justify-center transition-colors cursor-pointer"
                            title="Close"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>

                {/* Content: 3-Step Walkthrough */}
                <div className="p-6 overflow-y-auto space-y-5 custom-scrollbar">
                    <div className="grid grid-cols-1 gap-3.5">
                        {/* Step 1 */}
                        <div className="flex items-start gap-3.5 p-3.5 rounded-xl bg-surface-2/60 border border-border-subtle/70">
                            <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center font-bold text-caption shrink-0">
                                1
                            </div>
                            <div className="space-y-0.5">
                                <h4 className="text-body-sm font-bold text-primary flex items-center gap-2">
                                    Paste Any Media URL
                                </h4>
                                <p className="text-[12px] text-secondary leading-relaxed">
                                    Paste a link from YouTube, TikTok, Instagram, Twitter/X, Reddit, Facebook, Vimeo, SoundCloud, or direct video streams.
                                </p>
                            </div>
                        </div>

                        {/* Step 2 */}
                        <div className="flex items-start gap-3.5 p-3.5 rounded-xl bg-surface-2/60 border border-border-subtle/70">
                            <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center font-bold text-caption shrink-0">
                                2
                            </div>
                            <div className="space-y-0.5">
                                <h4 className="text-body-sm font-bold text-primary flex items-center gap-2">
                                    Inspect & Preview In-App
                                </h4>
                                <p className="text-[12px] text-secondary leading-relaxed">
                                    Listen to lightweight audio previews to save data, choose resolution from 4K down to 360p or MP3/FLAC, and toggle subtitles.
                                </p>
                            </div>
                        </div>

                        {/* Step 3 */}
                        <div className="flex items-start gap-3.5 p-3.5 rounded-xl bg-surface-2/60 border border-border-subtle/70">
                            <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center font-bold text-caption shrink-0">
                                3
                            </div>
                            <div className="space-y-0.5">
                                <h4 className="text-body-sm font-bold text-primary flex items-center gap-2">
                                    1-Click High-Speed Download
                                </h4>
                                <p className="text-[12px] text-secondary leading-relaxed">
                                    Files are downloaded via multi-threaded fragments and muxed natively onto your disk with zero ads and zero telemetry.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Supported Platforms Pill Row */}
                    <div className="space-y-2 pt-1">
                        <span className="text-[10px] uppercase font-bold text-tertiary tracking-wider">
                            Vast Platform Compatibility
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-secondary">
                            {["YouTube", "TikTok", "Instagram Reels", "Twitter / X", "Reddit", "Facebook", "Vimeo", "SoundCloud", "Pinterest", "1000+ Sites"].map((p) => (
                                <span
                                    key={p}
                                    className="px-2.5 py-1 rounded-lg bg-surface-2 border border-border-subtle font-medium text-primary select-none"
                                >
                                    {p}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Privacy & Engine Note */}
                    <div className="p-3 rounded-xl bg-status-success-subtle/15 border border-status-success/30 flex items-start gap-2.5 text-[11px] text-secondary">
                        <Shield size={15} className="text-status-success shrink-0 mt-0.5" />
                        <div>
                            <span className="font-bold text-primary">100% Private & Engine Updatable: </span>
                            Devizee has no user tracking or analytics. If YouTube or TikTok ever changes their format, update the engine directly from <span className="font-semibold text-primary">Settings → Advanced</span>.
                        </div>
                    </div>
                </div>

                {/* Footer Action */}
                <div className="p-4 bg-surface-2 border-t border-border-subtle flex items-center justify-between gap-3">
                    <span className="text-[11px] text-tertiary">
                        You can reopen this guide anytime from the <HelpCircle size={12} className="inline mx-0.5 text-accent" /> button.
                    </span>
                    <button
                        type="button"
                        onClick={handleDismiss}
                        className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white font-bold text-caption transition-all shadow-sm cursor-pointer"
                    >
                        Get Started
                    </button>
                </div>
            </div>
        </div>
    );
}
