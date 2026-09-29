import { useState } from "react";
import { X, ExternalLink, ShieldAlert, CheckCircle2, Globe, Music, GraduationCap, Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

const TOP_SITES = [
    { name: "YouTube & Shorts", cat: "video", note: "Up to 4K / 8K, 60fps" },
    { name: "TikTok", cat: "video", note: "HD videos & audio tracks" },
    { name: "Instagram", cat: "video", note: "Reels, Stories & Posts" },
    { name: "Twitter / X", cat: "video", note: "Multi-bitrate MP4s" },
    { name: "Facebook & Watch", cat: "video", note: "Public & Group videos" },
    { name: "Twitch", cat: "video", note: "Clips & Full VODs" },
    { name: "Reddit", cat: "video", note: "Native v.redd.it with audio mux" },
    { name: "Vimeo", cat: "video", note: "Full HD & original streams" },
    { name: "Pinterest", cat: "video", note: "Video pins & clips" },
    { name: "SoundCloud", cat: "audio", note: "MP3 / AAC master audio" },
    { name: "Bandcamp", cat: "audio", note: "Full tracks & album stream" },
    { name: "Dailymotion", cat: "video", note: "Up to 1080p60" },
    { name: "Bilibili", cat: "video", note: "Global & anime streams" },
    { name: "Threads", cat: "video", note: "Direct video posts" },
    { name: "Bluesky", cat: "video", note: "Native video posts" },
    { name: "Rumble", cat: "video", note: "Live & VOD content" },
    { name: "Kick", cat: "video", note: "Livestreams & recordings" },
    { name: "LinkedIn", cat: "video", note: "Professional video clips" },
    { name: "Mixcloud", cat: "audio", note: "DJ mixes & podcasts" },
    { name: "Audiomack", cat: "audio", note: "Hip-hop & indie music" },
    { name: "Streamable", cat: "video", note: "Short clips & sports" },
    { name: "Loom", cat: "video", note: "Shared workspace recordings" },
    { name: "TED Talks", cat: "education", note: "Official TED videos with subs" },
    { name: "Khan Academy", cat: "education", note: "Free instructional videos" },
    { name: "Coursera", cat: "education", note: "Public lecture streams" },
    { name: "MIT OpenCourseWare", cat: "education", note: "Full course lectures" },
    { name: "archive.org", cat: "education", note: "Internet Archive public media" },
    { name: "BBC iPlayer", cat: "education", note: "UK broadcast media" },
    { name: "PBS", cat: "education", note: "Public documentaries" },
    { name: "Flickr", cat: "video", note: "HD video uploads" },
    { name: "Tumblr", cat: "video", note: "Embedded & uploaded video" },
    { name: "VK", cat: "video", note: "European social video" },
    { name: "Likee", cat: "video", note: "Short-form clips" },
    { name: "Douyin", cat: "video", note: "Chinese video network" },
    { name: "Weibo", cat: "video", note: "Microblogging media" },
    { name: "BitChute", cat: "video", note: "P2P video network" },
    { name: "Odysee", cat: "video", note: "LBRY network media" },
    { name: "Coub", cat: "video", note: "Looped short clips" },
    { name: "Free Music Archive", cat: "audio", note: "CC-licensed audio" },
    { name: "Jamendo", cat: "audio", note: "Independent music" },
    { name: "Podbean", cat: "audio", note: "Public podcast episodes" },
    { name: "Apple Podcasts RSS", cat: "audio", note: "Public podcast feeds" },
    { name: "Anchor.fm", cat: "audio", note: "Spotify for Podcasters" },
    { name: "Beatport Previews", cat: "audio", note: "Electronic music clips" },
    { name: "Hearthis.at", cat: "audio", note: "DJ sets & mixes" },
];

const UNSUPPORTED_DRM = [
    "Netflix",
    "Spotify Premium",
    "Disney+",
    "Hulu",
    "Amazon Prime Video",
    "Apple TV+",
    "HBO Max",
    "Paramount+",
];

export function SupportedSitesModal({
    isOpen,
    onClose,
}: {
    isOpen: boolean;
    onClose: () => void;
}) {
    const [search, setSearch] = useState("");
    const [activeCat, setActiveCat] = useState<"all" | "video" | "audio" | "education">("all");

    if (!isOpen) return null;

    const filtered = TOP_SITES.filter((s) => {
        const matchesCat = activeCat === "all" || s.cat === activeCat;
        const matchesSearch = s.name.toLowerCase().includes(search.toLowerCase()) || s.note.toLowerCase().includes(search.toLowerCase());
        return matchesCat && matchesSearch;
    });

    const handleOpenEngineDocs = async () => {
        try {
            await openUrl("https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md");
        } catch {
            window.open("https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md", "_blank");
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
            <div
                className="bg-surface-1 border border-border-subtle rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-5 border-b border-border-subtle flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-accent-subtle text-accent flex items-center justify-center shrink-0">
                            <Globe size={20} />
                        </div>
                        <div>
                            <h2 className="text-body-lg font-bold text-primary flex items-center gap-2">
                                Supported Platforms & Sites
                                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/25">
                                    1,800+ Sites
                                </span>
                            </h2>
                            <p className="text-caption text-secondary mt-0.5">
                                Powered by the open-source <span className="font-semibold text-primary">yt-dlp</span> extraction engine.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-surface-2 text-tertiary hover:text-primary transition-colors cursor-pointer"
                        title="Close modal"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Search & Category Filter */}
                <div className="p-4 border-b border-border-subtle bg-surface-2/30 flex flex-wrap items-center justify-between gap-3">
                    <input
                        type="text"
                        placeholder="Search top sites (e.g. YouTube, TikTok, SoundCloud)..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="px-3 py-1.5 rounded-lg bg-surface-1 border border-border-subtle text-caption text-primary placeholder:text-tertiary focus:outline-none focus:border-accent w-full sm:w-64"
                    />
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold flex-wrap">
                        <button
                            type="button"
                            onClick={() => setActiveCat("all")}
                            className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${activeCat === "all" ? "bg-accent text-white" : "bg-surface-2 hover:bg-surface-3 text-secondary"}`}
                        >
                            All ({TOP_SITES.length})
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveCat("video")}
                            className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1 cursor-pointer ${activeCat === "video" ? "bg-accent text-white" : "bg-surface-2 hover:bg-surface-3 text-secondary"}`}
                        >
                            <Video size={12} />
                            Video
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveCat("audio")}
                            className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1 cursor-pointer ${activeCat === "audio" ? "bg-accent text-white" : "bg-surface-2 hover:bg-surface-3 text-secondary"}`}
                        >
                            <Music size={12} />
                            Audio
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveCat("education")}
                            className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1 cursor-pointer ${activeCat === "education" ? "bg-accent text-white" : "bg-surface-2 hover:bg-surface-3 text-secondary"}`}
                        >
                            <GraduationCap size={12} />
                            Education
                        </button>
                    </div>
                </div>

                {/* Content List */}
                <div className="p-5 overflow-y-auto space-y-4 flex-1">
                    {/* Top Sites Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                        {filtered.map((s) => (
                            <div
                                key={s.name}
                                className="p-2.5 rounded-xl bg-surface-2/40 border border-border-subtle/70 hover:border-accent/40 transition-colors flex items-center justify-between gap-2"
                            >
                                <div className="min-w-0">
                                    <div className="text-caption font-semibold text-primary truncate flex items-center gap-1.5">
                                        <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                                        <span>{s.name}</span>
                                    </div>
                                    <span className="text-[10px] text-tertiary block truncate pl-5">
                                        {s.note}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* DRM Notice Section */}
                    <div className="p-4 rounded-xl bg-status-danger-subtle/30 border border-status-danger/30 space-y-2">
                        <div className="flex items-center gap-2 text-status-danger text-body-sm font-bold">
                            <ShieldAlert size={16} />
                            <span>DRM-Restricted Services (Not Supported)</span>
                        </div>
                        <p className="text-[11px] text-secondary leading-relaxed">
                            Subscription streaming services utilize hardware-level DRM encryption (Widevine L1/L3, PlayReady, and FairPlay) which cannot be bypassed. Devizee Lite strictly respects copyright protection protocols and does not download from:
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                            {UNSUPPORTED_DRM.map((d) => (
                                <span
                                    key={d}
                                    className="px-2 py-0.5 rounded-md bg-status-danger/10 text-status-danger text-[10px] font-mono border border-status-danger/20"
                                >
                                    ✕ {d}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Footer with External Link */}
                <div className="p-4 border-t border-border-subtle bg-surface-2/40 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <span className="text-[11px] text-tertiary text-center sm:text-left">
                        Looking for a specific website? Most video hosters are supported automatically.
                    </span>
                    <button
                        type="button"
                        onClick={handleOpenEngineDocs}
                        className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-caption font-bold flex items-center gap-2 transition-colors cursor-pointer shadow-sm shrink-0"
                        title="Open official yt-dlp supported sites documentation in external browser"
                    >
                        <span>View All 1,800+ Supported Sites</span>
                        <ExternalLink size={14} className="stroke-[2.5]" />
                    </button>
                </div>
            </div>
        </div>
    );
}
