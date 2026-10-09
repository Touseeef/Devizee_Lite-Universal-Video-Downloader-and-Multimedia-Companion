// src/components/layout/Sidebar.tsx
import type { RefObject } from "react";
import {
    Bell,
    Download,
    Film,
    Gauge,
    HelpCircle,
    LayoutDashboard,
    PanelLeftClose,
    PanelLeftOpen,
    Settings as SettingsIcon,
    Sliders,
    Volume2,
} from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { ActiveStatusWidget } from "./ActiveStatusWidget";
import { ThemeDropdown } from "../common/ThemeDropdown";
import { AudioOutputDropdown } from "../common/AudioOutputDropdown";
import { EqualizerDropdown } from "../common/EqualizerDropdown";
import { WaveformVisualizer } from "../common/WaveformVisualizer";
import logo from "../../assets/devizee-logo.png";
import type { DownloadRecord, NowPlaying, TabType, PlaySource } from "../../types";
import type { TranslationKey } from "../../lib/i18n";

export function Sidebar({
    collapsed = false,
    onToggleCollapse,
    onOpenWelcome,
    activeTab,
    setActiveTab,
    onScrollToTop,
    activeCount,
    queuedCount,
    activeDownload,
    nowPlaying,
    audioRef,
    videoElementRef,
    theme,
    handleThemeChange,
    audioDevices = [],
    selectedAudioDevice = "default",
    onSelectAudioDevice,
    selectedEqPreset = "flat",
    onSelectEqPreset,
    playSource = "none",
    previewingId = null,
    t,
    unreadAnnouncementsCount = 0,
    onOpenAnnouncements,
}: {
    collapsed?: boolean;
    onToggleCollapse?: () => void;
    activeTab: TabType;
    setActiveTab: (tab: TabType) => void;
    onScrollToTop?: () => void;
    activeCount: number;
    queuedCount: number;
    activeDownload?: DownloadRecord | null;
    nowPlaying: NowPlaying;
    audioRef: RefObject<HTMLAudioElement | null>;
    videoElementRef: RefObject<HTMLVideoElement | null>;
    theme: string;
    handleThemeChange: (theme: string) => void;
    audioDevices?: MediaDeviceInfo[];
    selectedAudioDevice?: string;
    onSelectAudioDevice?: (deviceId: string) => void;
    selectedEqPreset?: string;
    onSelectEqPreset?: (presetId: string) => void;
    playSource?: PlaySource;
    previewingId?: string | null;
    t?: (key: TranslationKey) => string;
    onOpenWelcome?: () => void;
    unreadAnnouncementsCount?: number;
    onOpenAnnouncements?: () => void;
}) {
    const pillVisible = nowPlaying.type !== "none";
    const pillPlaying = pillVisible && nowPlaying.state === "playing";

    const handleTabClick = (tab: TabType) => {
        if (activeTab === tab) {
            onScrollToTop?.();
        } else {
            setActiveTab(tab);
        }
    };

    return (
        <aside
            className={`${collapsed ? "w-[64px]" : "w-60"
                } bg-surface-1 border-r border-border-subtle flex flex-col shrink-0 transition-[width] duration-200`}
        >
            {/* Branding — drag region */}
            <div
                data-tauri-drag-region
                className={`border-b border-border-subtle flex items-center ${collapsed ? "justify-center py-3 flex-col gap-2" : "px-4 py-4 gap-2"
                    }`}
            >
                <button
                    type="button"
                    onClick={() => handleTabClick("dashboard")}
                    className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer group hover:opacity-85 transition-opacity"
                    title="Go to Dashboard"
                >
                    <img
                        src={logo}
                        alt="Devizee"
                        className="w-8 h-8 shrink-0 pointer-events-none group-hover:scale-105 transition-transform"
                        draggable={false}
                    />
                    {!collapsed && (
                        <div className="min-w-0 flex-1">
                            <div className="font-bold text-body-sm tracking-tight text-primary leading-tight group-hover:text-accent transition-colors">
                                Devizee Lite
                            </div>
                            <div className="text-[10px] text-tertiary leading-tight truncate" title="Universal Video Downloader & Multimedia Companion">
                                Universal Video Downloader & Multimedia Companion
                            </div>
                        </div>
                    )}
                </button>

                <div className="flex items-center gap-1 shrink-0">
                    {onOpenAnnouncements && (
                        <button
                            type="button"
                            onClick={onOpenAnnouncements}
                            className="relative p-1 rounded-md text-tertiary hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
                            title={unreadAnnouncementsCount > 0 ? `Announcements & Updates (${unreadAnnouncementsCount} new)` : "Announcements & Updates"}
                        >
                            <Bell size={15} />
                            {unreadAnnouncementsCount > 0 && (
                                <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent ring-2 ring-surface-1 animate-pulse" />
                            )}
                        </button>
                    )}

                    {onOpenWelcome && (
                        <button
                            type="button"
                            onClick={onOpenWelcome}
                            className="p-1 rounded-md text-tertiary hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
                            title="Quick Start Guide & Compatibility"
                        >
                            <HelpCircle size={15} />
                        </button>
                    )}

                    {onToggleCollapse && (
                        <button
                            type="button"
                            onClick={onToggleCollapse}
                            className="p-1 rounded-md text-tertiary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                            title={collapsed ? "Expand Sidebar" : "Collapse to Icons Only"}
                        >
                            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
                        </button>
                    )}
                </div>
            </div>

            {/* Navigation (4 Curated Tabs for Devizee Lite) */}
            <nav className={`flex-1 overflow-y-auto ${collapsed ? "p-2 space-y-1" : "p-3 space-y-1"}`}>
                <SidebarNavItem
                    active={activeTab === "dashboard"}
                    onClick={() => handleTabClick("dashboard")}
                    icon={<LayoutDashboard size={16} />}
                    label={t ? t("nav_dashboard") : "Dashboard"}
                    collapsed={collapsed}
                />
                <SidebarNavItem
                    active={activeTab === "downloads"}
                    onClick={() => handleTabClick("downloads")}
                    icon={<Download size={16} />}
                    label={t ? t("nav_downloads") : "Downloads"}
                    badge={activeCount > 0 ? activeCount : undefined}
                    collapsed={collapsed}
                />
                <SidebarNavItem
                    active={activeTab === "multimedia"}
                    onClick={() => handleTabClick("multimedia")}
                    icon={<Film size={16} />}
                    label={t ? t("nav_multimedia") : "Multimedia"}
                    collapsed={collapsed}
                />
                <SidebarNavItem
                    active={activeTab === "settings"}
                    onClick={() => handleTabClick("settings")}
                    icon={<SettingsIcon size={16} />}
                    label={t ? t("nav_settings") : "Settings"}
                    collapsed={collapsed}
                />
            </nav>

            {/* Now-playing pill — clicking navigates directly to active media tab */}
            {pillVisible && (
                <div
                    onClick={() => {
                        // Strict routing: check explicit nowPlaying.source first
                        if (nowPlaying.source === "multimedia") {
                            setActiveTab("multimedia");
                        } else if (nowPlaying.source === "dashboard") {
                            setActiveTab("dashboard");
                        } else if (previewingId || playSource === "livePlaylist") {
                            setActiveTab("dashboard");
                        } else {
                            setActiveTab("multimedia");
                        }
                    }}
                    className={`rounded-md bg-accent-subtle hover:bg-accent-subtle/80 border border-accent/30 flex items-center cursor-pointer transition-all ${collapsed
                        ? "mx-2 mb-2 p-2 justify-center"
                        : "mx-3 mb-3 px-3 py-2 gap-2"
                        }`}
                    title={collapsed ? `${pillPlaying ? "Playing" : "Paused"} ${nowPlaying.type} — Click to view` : "Click to view playing media in tab"}
                >
                    {collapsed ? (
                        <div className="flex items-center justify-center text-accent" title={`${pillPlaying ? "Playing" : "Paused"} ${nowPlaying.type} — Click to view`}>
                            <Volume2 size={16} className={pillPlaying ? "text-accent animate-pulse" : "text-tertiary"} />
                        </div>
                    ) : (
                        <>
                            <Volume2
                                size={12}
                                className={`shrink-0 ${pillPlaying ? "text-accent animate-pulse" : "text-tertiary"}`}
                            />
                            <span
                                className={`text-caption font-semibold truncate flex-1 ${pillPlaying ? "text-accent" : "text-secondary"}`}
                            >
                                {pillPlaying ? `Playing ${nowPlaying.type}` : `${nowPlaying.type} paused`}
                            </span>
                            <WaveformVisualizer
                                mediaElement={
                                    nowPlaying.source === "dashboard"
                                        ? (nowPlaying.type === "audio" ? audioRef.current : videoElementRef.current)
                                        : null
                                }
                                isPlaying={pillPlaying}
                            />
                        </>
                    )}
                </div>
            )}

            {/* Active Download Speedometer Card — ONLY visible when navigated away from Downloads tab */}
            {activeTab !== "downloads" && activeDownload && (
                <div
                    onClick={() => setActiveTab("downloads")}
                    className={`cursor-pointer transition-all rounded-xl border border-accent/40 bg-accent-subtle/30 hover:bg-accent-subtle/50 ${collapsed ? "mx-2 mb-2 p-2 flex flex-col items-center" : "mx-3 mb-3 p-3 space-y-2"
                        }`}
                    title="Active download in progress — click to view in Downloads"
                >
                    <div className="flex items-center justify-between text-caption">
                        <div className="flex items-center gap-1.5 font-bold text-accent truncate">
                            <Gauge size={14} className="shrink-0 animate-pulse text-accent" />
                            {!collapsed && <span className="truncate">{activeDownload.title}</span>}
                        </div>
                        {!collapsed && (
                            <span className="font-mono text-[11px] font-bold text-accent shrink-0">
                                {activeDownload.percent}%
                            </span>
                        )}
                    </div>

                    {!collapsed && (
                        <>
                            <div className="w-full bg-surface-2 rounded-full h-1.5 overflow-hidden">
                                <div
                                    className="bg-accent h-full transition-all duration-300"
                                    style={{ width: `${Math.min(100, Math.max(0, activeDownload.percent))}%` }}
                                />
                            </div>

                            <div className="flex items-center justify-between text-[10px] font-mono text-secondary">
                                <span className="font-semibold text-primary">{activeDownload.speed || "Downloading..."}</span>
                                <span>{activeDownload.eta || ""}</span>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Active Status widget */}
            <ActiveStatusWidget
                activeCount={activeCount}
                queuedCount={queuedCount}
                collapsed={collapsed}
            />

            {/* Audio Output & Equalizer */}
            <div className={`border-t border-border-subtle ${collapsed ? "p-2 space-y-2" : "px-3 pt-3 pb-2 space-y-2.5"}`}>
                <div>
                    {!collapsed && (
                        <div className="text-[10px] uppercase text-tertiary font-semibold tracking-wider px-1 mb-1.5">
                            Audio Output
                        </div>
                    )}
                    <AudioOutputDropdown
                        audioDevices={audioDevices}
                        selectedDevice={selectedAudioDevice}
                        onSelectDevice={onSelectAudioDevice || (() => { })}
                        placement={collapsed ? "right" : "up"}
                        compact={collapsed}
                    />
                </div>

                <div>
                    {!collapsed && (
                        <div className="text-[10px] uppercase text-tertiary font-semibold tracking-wider px-1 mb-1.5 flex items-center justify-between">
                            <span>Equalizer</span>
                        </div>
                    )}
                    {collapsed ? (
                        <EqualizerDropdown
                            selectedPreset={selectedEqPreset}
                            onSelectPreset={onSelectEqPreset || (() => { })}
                            placement="right"
                            compact={true}
                        />
                    ) : (
                        <div className="flex items-center gap-1.5">
                            <div className="flex-1 min-w-0">
                                <EqualizerDropdown
                                    selectedPreset={selectedEqPreset}
                                    onSelectPreset={onSelectEqPreset || (() => { })}
                                    placement="up"
                                    compact={false}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setActiveTab("settings");
                                    try { localStorage.setItem("devizee_settings_section", "audio"); } catch { }
                                    window.dispatchEvent(new CustomEvent("devizee-navigate-settings", { detail: { section: "audio" } }));
                                }}
                                className="h-8.5 w-8.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-secondary hover:text-accent flex items-center justify-center transition-colors cursor-pointer shrink-0"
                                title="Equalizer Tuning in Settings"
                            >
                                <Sliders size={14} />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Theme switcher — bottom */}
            <div className={`border-t border-border-subtle/50 ${collapsed ? "p-2" : "px-3 pb-3 pt-2"}`}>
                {!collapsed && (
                    <div className="text-[10px] uppercase text-tertiary font-semibold tracking-wider px-1 mb-1.5">
                        Theme
                    </div>
                )}
                <ThemeDropdown
                    currentTheme={theme}
                    onSelectTheme={handleThemeChange}
                    placement={collapsed ? "right" : "up"}
                    fullWidth
                    compact={collapsed}
                />
            </div>
        </aside>
    );
}