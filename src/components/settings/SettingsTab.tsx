import { useState, useEffect } from "react";
import {
    Check,
    Clock,
    Copy,
    Cpu,
    Download,
    ExternalLink,
    FastForward,
    Globe,
    Loader2,
    RefreshCw,
    Shield,
    Sliders,
    Sparkles,
    Volume1,
    Volume2,
    VolumeX,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { SettingsSection } from "../common/SettingsSection";
import { SettingRow, SettingToggle } from "../common/SettingRow";
import { ThemeDropdown } from "../common/ThemeDropdown";
import type { TranslationKey } from "../../lib/i18n";
import { VerticalEqSlider } from "../common/VerticalEqSlider";

import { currentEqGains, setGlobalEqualizerGains } from "../../lib/audioContext";

type SettingsTabId =
    | "general"
    | "downloads"
    | "connection"
    | "equalizer"
    | "advanced"
    | "about";

const EQ_FREQUENCIES = ["60Hz", "150Hz", "400Hz", "1kHz", "2.4kHz", "6kHz", "12kHz", "16kHz"];
const EQ_PRESETS: Record<string, number[]> = {
    "Flat": [0, 0, 0, 0, 0, 0, 0, 0],
    "Bass Boost": [6, 5, 3, 0, -1, -1, 0, 1],
    "Vocal": [-2, -1, 1, 4, 4, 3, 1, 0],
    "EDM": [6, 4, 0, -2, 2, 4, 5, 4],
    "Rock": [5, 3, -1, -2, 1, 3, 5, 5],
    "Movie": [4, 3, 0, 1, 2, 4, 3, 2],
    "Acoustic": [3, 2, 0, 1, 2, 3, 3, 2],
    "Classical": [4, 3, 2, 0, 0, 1, 3, 4],
};

export function SettingsTab({
    t,
    settings,
    updateSetting,
    theme,
    handleThemeChange,
    audioDevices,
    selectedAudioDevice,
    handleDeviceChange,
    volume,
    isMuted,
    handleVolumeChange,
    toggleMute,
    handleToggleAutostart,
    handleBrowseFolder,
    openFolder,
    onOpenSupportedSites,
}: {
    t: (key: TranslationKey) => string;
    settings: any;
    updateSetting: (key: string, val: any) => void;
    theme: string;
    handleThemeChange: (theme: string) => void;
    audioDevices: MediaDeviceInfo[];
    selectedAudioDevice: string;
    handleDeviceChange: (deviceId: string) => void;
    volume: number;
    isMuted: boolean;
    handleVolumeChange: (v: number) => void;
    toggleMute: () => void;
    handleToggleAutostart: (enable: boolean) => void;
    handleBrowseFolder: (
        key:
            | "saveFolder"
            | "videoFolder"
            | "audioFolder"
            | "documentsFolder"
            | "generalFolder"
            | "compressedFolder"
            | "programsFolder"
            | "tempFolder"
    ) => void;
    openFolder: (path?: string | null) => void;
    onOpenSupportedSites?: () => void;
}) {
    const [activeSection, setActiveSection] = useState<SettingsTabId>("general");
    const [eqBands, setEqBands] = useState<number[]>([...currentEqGains]);
    const [activePreset, setActivePreset] = useState<string>("Flat");
    const [diagCopied, setDiagCopied] = useState(false);

    // Engine Core (yt-dlp) update state
    const [engineInfo, setEngineInfo] = useState<{ current_version: string; binary_path: string; is_custom_updated: boolean } | null>(null);
    const [engineUpdateCheck, setEngineUpdateCheck] = useState<{ current_version: string; latest_version: string; update_available: boolean } | null>(null);
    const [isCheckingEngine, setIsCheckingEngine] = useState(false);
    const [isUpdatingEngine, setIsUpdatingEngine] = useState(false);
    const [engineStatusMessage, setEngineStatusMessage] = useState<string | null>(null);

    const handleFetchEngineInfo = async () => {
        try {
            const info = await invoke<{ current_version: string; binary_path: string; is_custom_updated: boolean }>("get_engine_info");
            setEngineInfo(info);
        } catch (e: any) {
            console.error("Failed to get engine info:", e);
        }
    };

    const handleCheckEngineUpdate = async () => {
        setIsCheckingEngine(true);
        setEngineStatusMessage(null);
        try {
            const check = await invoke<{ current_version: string; latest_version: string; update_available: boolean }>("check_engine_update");
            setEngineUpdateCheck(check);
            if (!check.update_available) {
                setEngineStatusMessage(`Engine is up to date (v${check.current_version})`);
            }
        } catch (e: any) {
            setEngineStatusMessage(`Update check failed: ${e}`);
        } finally {
            setIsCheckingEngine(false);
        }
    };

    const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState(false);
    const [appUpdateAvailable, setAppUpdateAvailable] = useState<any>(null);
    const [appUpdateMessage, setAppUpdateMessage] = useState<string>("");
    const [isInstallingAppUpdate, setIsInstallingAppUpdate] = useState(false);
    const [appDownloadProgress, setAppDownloadProgress] = useState<number | null>(null);

    const handleCheckAppUpdate = async () => {
        setIsCheckingAppUpdate(true);
        setAppUpdateMessage("");
        try {
            const update = await check();
            if (update?.available) {
                setAppUpdateAvailable(update);
                setAppUpdateMessage(`Devizee Desktop v${update.version} is available!`);
            } else {
                setAppUpdateMessage("Devizee is up to date (running latest release).");
                setAppUpdateAvailable(null);
            }
        } catch (err: any) {
            setAppUpdateMessage(`Update check failed: ${err}`);
        } finally {
            setIsCheckingAppUpdate(false);
        }
    };

    const handleInstallAppUpdate = async () => {
        if (!appUpdateAvailable) return;
        setIsInstallingAppUpdate(true);
        let downloaded = 0;
        let contentLength = 0;

        try {
            await appUpdateAvailable.downloadAndInstall((event: any) => {
                switch (event.event) {
                    case "Started":
                        contentLength = event.data.contentLength || 0;
                        break;
                    case "Progress":
                        downloaded += event.data.chunkLength;
                        if (contentLength > 0) {
                            setAppDownloadProgress(Math.round((downloaded / contentLength) * 100));
                        }
                        break;
                    case "Finished":
                        setAppDownloadProgress(100);
                        break;
                }
            });
            await relaunch();
        } catch (err: any) {
            setAppUpdateMessage(`Installation failed: ${err}`);
            setIsInstallingAppUpdate(false);
        }
    };

    const handleUpdateEngine = async () => {
        setIsUpdatingEngine(true);
        setEngineStatusMessage("Downloading latest yt-dlp binary from GitHub...");
        try {
            const res = await invoke<{ success: boolean; new_version: string; new_hash?: string; message: string }>("update_engine");
            setEngineStatusMessage(res.message);
            // Regression 3 fix: update baseline hash in localStorage immediately so SC-3 does not alert
            if (res.new_hash) {
                try {
                    const raw = localStorage.getItem("devizee_sidecar_hashes_v1");
                    const parsed = raw ? JSON.parse(raw) : {};
                    parsed.yt_dlp = res.new_hash;
                    localStorage.setItem("devizee_sidecar_hashes_v1", JSON.stringify(parsed));
                } catch (e) {
                    console.error("Failed to update sidecar baseline hash:", e);
                }
            }
            setEngineUpdateCheck(null);
            await handleFetchEngineInfo();
        } catch (e: any) {
            setEngineStatusMessage(`Upgrade failed: ${e}`);
        } finally {
            setIsUpdatingEngine(false);
        }
    };

    useEffect(() => {
        if (activeSection === "advanced") {
            handleFetchEngineInfo();
        }
    }, [activeSection]);

    const tabs: { id: SettingsTabId; label: string; icon: any }[] = [
        { id: "general", label: "General", icon: Sliders },
        { id: "downloads", label: "Downloads & Folders", icon: Download },
        { id: "connection", label: "Connection & Limits", icon: FastForward },
        { id: "equalizer", label: "Sound & Equalizer", icon: Volume2 },
        { id: "advanced", label: "Advanced & Engine", icon: Cpu },
        { id: "about", label: "About & Roadmap", icon: Shield },
    ];

    const applyEqPreset = (name: string) => {
        const preset = EQ_PRESETS[name];
        if (preset) {
            setEqBands([...preset]);
            setActivePreset(name);
            setGlobalEqualizerGains(preset);
        }
    };

    const handleBandChange = (index: number, val: number) => {
        const next = [...eqBands];
        next[index] = val;
        setEqBands(next);
        setActivePreset("Custom");
        setGlobalEqualizerGains(next);
    };

    return (
        <div className="w-full max-w-5xl xl:max-w-6xl mx-auto space-y-6 pb-12 animate-in fade-in duration-150">
            {/* Top Navigation Tabs (Single-Row Horizontal Scrollable Bar) */}
            <div className="flex items-center gap-1.5 p-1.5 bg-surface-1 rounded-2xl border border-border-subtle shadow-2xs overflow-x-auto no-scrollbar">
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeSection === tab.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setActiveSection(tab.id)}
                            className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-caption font-bold transition-all cursor-pointer whitespace-nowrap shrink-0 ${isActive
                                ? "bg-accent text-white shadow-xs"
                                : "text-secondary hover:text-primary hover:bg-surface-2"
                                }`}
                            title={`Switch to ${tab.label}`}
                        >
                            <Icon size={15} />
                            <span>{tab.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* TAB 1: GENERAL */}
            {activeSection === "general" && (
                <SettingsSection title={t("settings_general")} icon={<Sliders size={16} />}>
                    <SettingRow title={t("settings_theme")} desc="Choose from 4 curated visual themes (Signature, Light, Frost, OLED)">
                        <ThemeDropdown currentTheme={theme} onSelectTheme={handleThemeChange} />
                    </SettingRow>

                    <SettingRow title={t("settings_lang")} desc="Application interface display language">
                        <select
                            value={settings.language}
                            onChange={(e) => updateSetting("language", e.target.value)}
                            className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                        >
                            <option value="en">English (US)</option>
                            <option value="es">Español</option>
                            <option value="de">Deutsch</option>
                            <option value="fr">Français</option>
                            <option value="zh">中文 (简体)</option>
                            <option value="ja">日本語</option>
                            <option value="ru">Русский</option>
                            <option value="pt">Português</option>
                            <option value="it">Italiano</option>
                            <option value="tr">Türkçe</option>
                            <option value="ar">العربية</option>
                            <option value="hi">हिन्दी</option>
                            <option value="ur">اردو</option>
                            <option value="ko">한국어</option>
                        </select>
                    </SettingRow>

                    <SettingToggle
                        title={t("settings_autostart")}
                        desc={t("settings_autostart_desc")}
                        checked={settings.launchOnBoot}
                        onChange={handleToggleAutostart}
                    />

                    <SettingToggle
                        title={t("settings_tray")}
                        desc={t("settings_tray_desc")}
                        checked={settings.minimizeToTray}
                        onChange={(v) => updateSetting("minimizeToTray", v)}
                    />

                    <SettingToggle
                        title="Warn Before Closing Active Downloads"
                        desc="Show confirmation when closing app with active downloading tasks"
                        checked={settings.warnOnCloseActiveDownloads !== false}
                        onChange={(v) => updateSetting("warnOnCloseActiveDownloads", v)}
                    />

                    <SettingRow title="Devizee Application Updates" desc="Check for new signed desktop releases directly from GitHub">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            <button
                                type="button"
                                disabled={isCheckingAppUpdate || isInstallingAppUpdate}
                                onClick={handleCheckAppUpdate}
                                className="px-3.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold flex items-center gap-1.5 text-accent border border-border-subtle cursor-pointer disabled:opacity-50 transition-colors shrink-0"
                            >
                                <RefreshCw size={13} className={isCheckingAppUpdate ? "animate-spin" : ""} />
                                <span>{isCheckingAppUpdate ? "Checking..." : "Check for App Update"}</span>
                            </button>

                            {appUpdateAvailable && (
                                <button
                                    type="button"
                                    disabled={isInstallingAppUpdate}
                                    onClick={handleInstallAppUpdate}
                                    className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-caption font-bold flex items-center gap-1.5 cursor-pointer shadow-sm disabled:opacity-50 transition-all"
                                >
                                    {isInstallingAppUpdate ? (
                                        <Loader2 size={13} className="animate-spin" />
                                    ) : (
                                        <Download size={13} />
                                    )}
                                    <span>
                                        {isInstallingAppUpdate
                                            ? appDownloadProgress !== null ? `Installing (${appDownloadProgress}%)` : "Installing..."
                                            : `Install v${appUpdateAvailable.version} & Restart`}
                                    </span>
                                </button>
                            )}
                        </div>
                    </SettingRow>

                    {appUpdateMessage && (
                        <div className="p-3 rounded-xl bg-surface-2 border border-border-subtle text-caption flex items-center gap-2 text-secondary animate-in fade-in">
                            <Sparkles size={14} className="text-accent shrink-0" />
                            <span>{appUpdateMessage}</span>
                        </div>
                    )}
                </SettingsSection>
            )}

            {/* TAB 2: DOWNLOADS & FOLDERS */}
            {activeSection === "downloads" && (
                <SettingsSection title="Downloads & Folders" icon={<Download size={16} />}>
                    <SettingRow title={t("settings_save_loc")} desc="Base root directory where downloads are stored">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                readOnly
                                value={settings.saveFolder}
                                className="settings-input w-44 truncate"
                                title={settings.saveFolder}
                            />
                            <button
                                type="button"
                                onClick={() => handleBrowseFolder("saveFolder")}
                                className="px-3 py-1 rounded-md bg-accent text-white hover:bg-accent-hover text-caption font-semibold transition-colors shadow-sm cursor-pointer"
                            >
                                Browse...
                            </button>
                            <button
                                type="button"
                                onClick={() => openFolder(null)}
                                className="px-3 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-caption font-semibold border border-border-subtle cursor-pointer"
                            >
                                Open
                            </button>
                        </div>
                    </SettingRow>

                    <SettingRow title="Video Downloads Location" desc="Custom directory for video files (.mp4, .mkv, .webm)">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                readOnly
                                placeholder={`${settings.saveFolder || "Downloads/Devizee"}/Videos`}
                                value={settings.videoFolder || ""}
                                className="bg-surface-2 border border-border-subtle rounded-md px-2.5 py-1.5 text-caption text-primary outline-none w-44 truncate placeholder:text-secondary"
                                title={settings.videoFolder || `${settings.saveFolder || "Downloads/Devizee"}/Videos`}
                            />
                            <button
                                type="button"
                                onClick={() => handleBrowseFolder("videoFolder")}
                                className="px-3 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-caption font-semibold border border-border-subtle cursor-pointer"
                            >
                                Browse...
                            </button>
                            {settings.videoFolder && (
                                <button
                                    type="button"
                                    onClick={() => updateSetting("videoFolder", "")}
                                    className="px-2 py-1 rounded-md text-caption text-tertiary hover:text-status-danger cursor-pointer"
                                    title="Reset to default subfolder"
                                >
                                    Reset
                                </button>
                            )}
                        </div>
                    </SettingRow>

                    <SettingRow title="Audio Downloads Location" desc="Custom directory for audio files (.mp3, .m4a, .flac, .opus)">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                readOnly
                                placeholder={`${settings.saveFolder || "Downloads/Devizee"}/Audio`}
                                value={settings.audioFolder || ""}
                                className="settings-input"
                                title={settings.audioFolder || `${settings.saveFolder || "Downloads/Devizee"}/Audio`}
                            />
                            <button
                                type="button"
                                onClick={() => handleBrowseFolder("audioFolder")}
                                className="px-3 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-caption font-semibold border border-border-subtle cursor-pointer"
                            >
                                Browse...
                            </button>
                            {settings.audioFolder && (
                                <button
                                    type="button"
                                    onClick={() => updateSetting("audioFolder", "")}
                                    className="px-2 py-1 rounded-md text-caption text-tertiary hover:text-status-danger cursor-pointer"
                                    title="Reset to default subfolder"
                                >
                                    Reset
                                </button>
                            )}
                        </div>
                    </SettingRow>


                    <SettingRow
                        title="Temporary / In-Progress Files Location"
                        desc="Scratch directory for active download segments before final muxing"
                    >
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                readOnly
                                placeholder="System Temp (Default)"
                                value={settings.tempFolder || ""}
                                className="settings-input"
                                title={settings.tempFolder || "System Temp (Default)"}
                            />
                            <button
                                type="button"
                                onClick={() => handleBrowseFolder("tempFolder")}
                                className="px-3 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-caption font-semibold border border-border-subtle cursor-pointer"
                            >
                                Browse...
                            </button>
                            {settings.tempFolder && (
                                <button
                                    type="button"
                                    onClick={() => updateSetting("tempFolder", "")}
                                    className="px-2 py-1 rounded-md text-caption text-tertiary hover:text-status-danger cursor-pointer"
                                    title="Reset to default scratch location"
                                >
                                    Reset
                                </button>
                            )}
                        </div>
                    </SettingRow>

                    <SettingToggle
                        title={t("settings_auto_org")}
                        desc={t("settings_auto_org_desc")}
                        checked={settings.autoOrganize}
                        onChange={(v) => updateSetting("autoOrganize", v)}
                    />

                    <SettingRow title={t("settings_filename")} desc="Template used when naming downloaded files">
                        <input
                            type="text"
                            placeholder="%(title)s.%(ext)s"
                            value={settings.filenameTemplate}
                            onChange={(e) => updateSetting("filenameTemplate", e.target.value)}
                            className="settings-input font-mono w-56"
                        />
                    </SettingRow>

                    <SettingRow title={t("settings_duplicate")} desc="Action when file already exists on disk">
                        <select
                            value={settings.duplicateAction}
                            onChange={(e) => updateSetting("duplicateAction", e.target.value)}
                            className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                        >
                            <option value="rename">Rename (Add Number)</option>
                            <option value="overwrite">Overwrite Existing</option>
                            <option value="skip">Skip Download</option>
                            <option value="ask">Always Ask</option>
                        </select>
                    </SettingRow>

                    <SettingToggle
                        title="Download Subtitles & Captions"
                        desc="Automatically download and embed subtitles and platform auto-captions into video files"
                        checked={settings.downloadSubtitles ?? true}
                        onChange={(v) => updateSetting("downloadSubtitles", v)}
                    />

                    {settings.downloadSubtitles !== false && (
                        <>
                            <SettingRow title="Subtitle Languages" desc="Target languages to fetch and embed">
                                <select
                                    value={settings.subtitleLanguages || "en.*,en"}
                                    onChange={(e) => updateSetting("subtitleLanguages", e.target.value)}
                                    className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                                >
                                    <option value="en.*,en">English (Default)</option>
                                    <option value="all">All Available Subtitles</option>
                                    <option value="es.*,es">Spanish (Español)</option>
                                    <option value="fr.*,fr">French (Français)</option>
                                    <option value="de.*,de">German (Deutsch)</option>
                                    <option value="zh.*,zh">Chinese (中文)</option>
                                    <option value="ja.*,ja">Japanese (日本語)</option>
                                    <option value="ar.*,ar">Arabic (العربية)</option>
                                    <option value="ru.*,ru">Russian (Русский)</option>
                                    <option value="hi.*,hi">Hindi (हिन्दी)</option>
                                    <option value="pt.*,pt">Portuguese (Português)</option>
                                </select>
                            </SettingRow>

                            <SettingToggle
                                title="Organize Subtitles into Subfolder"
                                desc="Place downloaded subtitle files (.vtt / .srt) in a 'subtitles' subfolder instead of root folder"
                                checked={settings.subtitlesInSubfolder ?? true}
                                onChange={(v) => updateSetting("subtitlesInSubfolder", v)}
                            />
                        </>
                    )}
                </SettingsSection>
            )}

            {/* TAB 3: CONNECTION & LIMITS */}
            {activeSection === "connection" && (
                <div className="space-y-6">
                    <SettingsSection title={t("settings_speed")} icon={<FastForward size={16} />}>
                        <SettingRow title="Maximum Concurrent Downloads" desc="Number of downloads allowed to execute concurrently">
                            <select
                                value={settings.maxParallel || 3}
                                onChange={(e) => updateSetting("maxParallel", parseInt(e.target.value, 10))}
                                className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                            >
                                <option value={1}>1 download at a time</option>
                                <option value={2}>2 concurrent</option>
                                <option value={3}>3 concurrent (Default)</option>
                                <option value={5}>5 concurrent</option>
                                <option value={10}>10 concurrent (High Bandwidth)</option>
                            </select>
                        </SettingRow>

                        <SettingRow title={t("settings_speed_limit")} desc="Throttle bandwidth to prevent network saturation">
                            <div className="flex items-center gap-2">
                                <select
                                    value={settings.speedLimit}
                                    onChange={(e) => updateSetting("speedLimit", e.target.value)}
                                    className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                                >
                                    <option value="unlimited">{t("settings_speed_unlimited")}</option>
                                    <option value="10M">10.0 MB/s (High Speed)</option>
                                    <option value="5M">5.0 MB/s (Gaming & Work Mode)</option>
                                    <option value="3M">3.0 MB/s (Balanced)</option>
                                    <option value="2M">2.0 MB/s (Eco & Streaming Mode)</option>
                                    <option value="1M">1.0 MB/s (Night / Low Bandwidth)</option>
                                    <option value="500K">500 KB/s (Ultra Background Saver)</option>
                                    <option value="custom">{t("settings_speed_custom")}</option>
                                </select>
                                {settings.speedLimit === "custom" && (
                                    <input
                                        type="text"
                                        placeholder="e.g. 500K, 2.5M"
                                        value={settings.customSpeedLimit}
                                        onChange={(e) => updateSetting("customSpeedLimit", e.target.value)}
                                        className="w-24 bg-surface-2 border border-border-subtle rounded-md px-2 py-1 text-caption text-primary outline-none font-mono"
                                    />
                                )}
                            </div>
                        </SettingRow>

                        <SettingToggle
                            title={t("settings_proxy")}
                            desc={t("settings_proxy_desc")}
                            checked={settings.proxyEnabled}
                            onChange={(v) => updateSetting("proxyEnabled", v)}
                        />

                        {settings.proxyEnabled && (
                            <div className="p-3 bg-surface-2/60 rounded-md space-y-2 border border-border-subtle animate-in fade-in duration-fast">
                                <div className="grid grid-cols-3 gap-2">
                                    <div>
                                        <label className="text-[10px] font-semibold text-secondary uppercase">Protocol</label>
                                        <select
                                            value={settings.proxyProtocol}
                                            onChange={(e) => updateSetting("proxyProtocol", e.target.value)}
                                            className="w-full bg-surface-2 border border-border-subtle rounded-md px-2 py-1 text-caption text-primary outline-none cursor-pointer"
                                        >
                                            <option value="socks5">SOCKS5</option>
                                            <option value="http">HTTP</option>
                                            <option value="https">HTTPS</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-semibold text-secondary uppercase">Host / IP</label>
                                        <input
                                            type="text"
                                            placeholder="127.0.0.1"
                                            value={settings.proxyHost}
                                            onChange={(e) => updateSetting("proxyHost", e.target.value)}
                                            className="w-full bg-surface-1 border border-border-subtle rounded-md px-2 py-1 text-caption text-primary outline-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-semibold text-secondary uppercase">Port</label>
                                        <input
                                            type="text"
                                            placeholder="1080"
                                            value={settings.proxyPort}
                                            onChange={(e) => updateSetting("proxyPort", e.target.value)}
                                            className="w-full bg-surface-1 border border-border-subtle rounded-md px-2 py-1 text-caption text-primary outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </SettingsSection>

                    {/* Scheduler & Night Mode */}
                    <SettingsSection title={t("settings_scheduler")} icon={<Clock size={16} />}>
                        <SettingToggle
                            title="Enable Scheduled Queue"
                            desc="Automatically execute queued downloads at the specified time"
                            checked={settings.enableScheduler}
                            onChange={(v) => updateSetting("enableScheduler", v)}
                        />

                        {settings.enableScheduler && (
                            <div className="space-y-4 pt-2 border-t border-border-subtle/50">
                                <SettingRow title="Start Download Queue At" desc="Execute scheduled queue during off-peak hours">
                                    <input
                                        type="time"
                                        value={settings.scheduledTime}
                                        onChange={(e) => updateSetting("scheduledTime", e.target.value)}
                                        className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-mono text-primary outline-none"
                                    />
                                </SettingRow>

                                <SettingRow title="Quiet Hours Window" desc="Automatically throttle and silent download activity during this interval">
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="time"
                                            value={settings.quietHoursStart}
                                            onChange={(e) => updateSetting("quietHoursStart", e.target.value)}
                                            className="bg-surface-2 border border-border-subtle rounded-md px-2 py-1 text-caption font-mono text-primary outline-none"
                                        />
                                        <span className="text-caption text-secondary">to</span>
                                        <input
                                            type="time"
                                            value={settings.quietHoursEnd}
                                            onChange={(e) => updateSetting("quietHoursEnd", e.target.value)}
                                            className="bg-surface-2 border border-border-subtle rounded-md px-2 py-1 text-caption font-mono text-primary outline-none"
                                        />
                                    </div>
                                </SettingRow>

                                <SettingRow title="Action When Finished" desc="What to do once all scheduled tasks conclude">
                                    <select
                                        value={settings.postDownloadAction}
                                        onChange={(e) => updateSetting("postDownloadAction", e.target.value)}
                                        className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                                    >
                                        <option value="nothing">Do Nothing</option>
                                        <option value="sleep">Put System to Sleep</option>
                                        <option value="shutdown">Shutdown System</option>
                                        <option value="quit">Close Devizee</option>
                                    </select>
                                </SettingRow>
                            </div>
                        )}
                    </SettingsSection>
                </div>
            )}

            {/* TAB 4: SOUND & EQUALIZER */}
            {activeSection === "equalizer" && (
                <div className="space-y-6">
                    <SettingsSection title="Audio Output & Alerts" icon={<Volume2 size={16} />}>
                        <SettingRow title="Audio Output Device" desc="Output destination for preview audio and completion sounds">
                            <select
                                value={selectedAudioDevice}
                                onChange={(e) => handleDeviceChange(e.target.value)}
                                className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary max-w-xs cursor-pointer"
                            >
                                {audioDevices.length === 0 ? (
                                    <option value="default">Default Audio Device</option>
                                ) : (
                                    audioDevices.map((d) => (
                                        <option key={d.deviceId} value={d.deviceId}>
                                            {d.label || `Device ${d.deviceId.slice(0, 8)}...`}
                                        </option>
                                    ))
                                )}
                            </select>
                        </SettingRow>

                        <SettingRow title="Master Volume" desc="Controls preview streams and alert loudness">
                            <div className="flex items-center gap-2.5">
                                <button
                                    type="button"
                                    onClick={toggleMute}
                                    className="text-secondary hover:text-primary transition-colors cursor-pointer"
                                    title={isMuted ? "Unmute" : "Mute"}
                                >
                                    {isMuted || volume === 0 ? (
                                        <VolumeX size={15} className="text-status-danger" />
                                    ) : volume < 0.5 ? (
                                        <Volume1 size={15} />
                                    ) : (
                                        <Volume2 size={15} />
                                    )}
                                </button>
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.05"
                                    value={isMuted ? 0 : volume}
                                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                                    className="w-32 h-1.5 bg-surface-2 accent-accent cursor-pointer rounded-full"
                                />
                                <span className="text-caption font-mono w-10 text-right text-secondary">
                                    {Math.round((isMuted ? 0 : volume) * 100)}%
                                </span>
                            </div>
                        </SettingRow>

                        <SettingToggle
                            title="Audible Completion Chime"
                            desc="Play a pleasant harmonic chord upon task completion"
                            checked={settings.playSound}
                            onChange={(v) => updateSetting("playSound", v)}
                        />

                        <SettingToggle
                            title="Desktop Notifications"
                            desc="Display native system notifications when downloads conclude"
                            checked={settings.showNotifications}
                            onChange={(v) => updateSetting("showNotifications", v)}
                        />
                    </SettingsSection>

                    {/* Graphic Equalizer Section */}
                    <div className="p-6 bg-surface-1 rounded-2xl border border-border-subtle shadow-sm space-y-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
                                    <Sliders size={16} />
                                </div>
                                <div>
                                    <h3 className="font-bold text-body text-primary">8-Band Hardware Equalizer</h3>
                                    <p className="text-caption text-secondary">Tune the frequency response for audio extractions and in-app previews</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => applyEqPreset("Flat")}
                                    className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 border border-border-subtle text-caption font-semibold text-secondary hover:text-primary transition-colors cursor-pointer"
                                >
                                    Reset to Flat
                                </button>
                            </div>
                        </div>

                        {/* Presets Bar */}
                        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                            <span className="text-[11px] font-bold text-tertiary uppercase tracking-wider mr-1 shrink-0">Presets:</span>
                            {Object.keys(EQ_PRESETS).map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    onClick={() => applyEqPreset(name)}
                                    className={`px-3 py-1 rounded-lg text-caption font-semibold transition-all shrink-0 cursor-pointer ${activePreset === name
                                        ? "bg-accent text-white shadow-2xs font-bold"
                                        : "bg-surface-2 text-secondary hover:text-primary hover:bg-surface-3 border border-border-subtle/50"
                                        }`}
                                >
                                    {name}
                                </button>
                            ))}
                        </div>

                        {/* Sliders Grid — Custom Pointer-Based Sliders */}
                        <div className="p-5 bg-surface-2/60 rounded-xl border border-border-subtle/70">
                            <div className="grid grid-cols-8 gap-3 sm:gap-5 justify-items-center">
                                {eqBands.map((gain, i) => (
                                    <div key={EQ_FREQUENCIES[i]} className="flex flex-col items-center">
                                        <span
                                            className={`text-[11px] font-mono font-bold mb-2 w-10 text-center ${gain > 0
                                                ? "text-accent"
                                                : gain < 0
                                                    ? "text-status-warning"
                                                    : "text-tertiary"
                                                }`}
                                        >
                                            {gain > 0 ? `+${gain}` : gain}
                                        </span>

                                        <VerticalEqSlider
                                            value={gain}
                                            min={-12}
                                            max={12}
                                            onChange={(v) => handleBandChange(i, v)}
                                        />

                                        <span className="text-[11px] font-bold text-secondary text-center mt-2">
                                            {EQ_FREQUENCIES[i]}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 5: ADVANCED & ENGINE */}
            {activeSection === "advanced" && (
                <div className="space-y-6">
                    {/* Security & Antivirus */}
                    <SettingsSection title={t("settings_security")} icon={<Shield size={16} />}>
                        <SettingToggle
                            title={t("settings_defender")}
                            desc={t("settings_defender_desc")}
                            checked={settings.scanAntivirus}
                            onChange={(v) => updateSetting("scanAntivirus", v)}
                        />
                    </SettingsSection>

                    {/* Advanced & Engine */}
                    <SettingsSection title={t("settings_advanced")} icon={<Cpu size={16} />}>
                        <SettingRow
                            title="Cookie Authentication (via browser session)"
                            desc="Reads session cookies from your selected local browser on-demand to access age-restricted or private videos across YouTube, Instagram, TikTok, Twitter/X, and Reddit. Advisory: Platforms may flag personal accounts for automated activity if downloading frequently; consider using a secondary browser or dedicated account."
                        >
                            <select
                                value={settings.cookiesFromBrowser || "none"}
                                onChange={(e) => updateSetting("cookiesFromBrowser", e.target.value)}
                                className="bg-surface-2 border border-border-subtle rounded-md px-3 py-1.5 text-caption font-semibold outline-none text-primary cursor-pointer"
                            >
                                <option value="none">Disabled (default)</option>
                                <option value="chrome">Chrome</option>
                                <option value="edge">Edge</option>
                                <option value="firefox">Firefox</option>
                                <option value="brave">Brave</option>
                                <option value="opera">Opera</option>
                                <option value="vivaldi">Vivaldi</option>
                            </select>
                        </SettingRow>

                        <SettingToggle
                            title="Allow Insecure SSL (Corporate/School Proxies)"
                            desc="Bypasses TLS certificate validation. Only enable if you are behind an enterprise, university, or antivirus proxy that inspects SSL traffic. Disabled by default for security."
                            checked={!!settings.allowInsecureSSL}
                            onChange={(v) => updateSetting("allowInsecureSSL", v)}
                        />

                        <SettingRow title={t("settings_custom_flags")} desc={t("settings_custom_flags_desc")}>
                            <input
                                type="text"
                                placeholder="--throttled-rate 100K ..."
                                value={settings.customFlags}
                                onChange={(e) => updateSetting("customFlags", e.target.value)}
                                className="settings-input font-mono w-56"
                            />
                        </SettingRow>

                        <SettingRow
                            title="yt-dlp Engine Status"
                            desc="Active core extraction & muxing binary. YouTube changes their player frequently — keep this updated to maintain 100% download reliability."
                        >
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                                <span className="text-caption font-mono bg-surface-2 px-2.5 py-1 rounded-md text-primary font-bold border border-border-subtle shrink-0">
                                    {engineInfo?.current_version ? `v${engineInfo.current_version}` : "yt-dlp Core"}
                                    {engineInfo?.is_custom_updated && (
                                        <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-accent/20 text-accent uppercase font-sans">
                                            User Updated
                                        </span>
                                    )}
                                </span>

                                <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                        type="button"
                                        disabled={isCheckingEngine || isUpdatingEngine}
                                        onClick={handleCheckEngineUpdate}
                                        className="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-caption font-semibold flex items-center gap-1.5 text-accent border border-border-subtle cursor-pointer disabled:opacity-50 transition-colors"
                                    >
                                        <RefreshCw size={13} className={isCheckingEngine ? "animate-spin" : ""} />
                                        <span>{isCheckingEngine ? "Checking GitHub..." : "Check Engine Update"}</span>
                                    </button>

                                    {engineUpdateCheck?.update_available && (
                                        <button
                                            type="button"
                                            disabled={isUpdatingEngine}
                                            onClick={handleUpdateEngine}
                                            className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-caption font-bold flex items-center gap-1.5 cursor-pointer shadow-sm disabled:opacity-50 transition-all animate-pulse"
                                        >
                                            {isUpdatingEngine ? (
                                                <Loader2 size={13} className="animate-spin" />
                                            ) : (
                                                <Download size={13} />
                                            )}
                                            <span>
                                                {isUpdatingEngine
                                                    ? "Updating..."
                                                    : `Upgrade to v${engineUpdateCheck.latest_version}`}
                                            </span>
                                        </button>
                                    )}
                                </div>
                            </div>
                        </SettingRow>

                        {engineStatusMessage && (
                            <div className="p-3 rounded-xl bg-surface-2 border border-border-subtle text-caption flex items-center gap-2 text-secondary animate-in fade-in">
                                <Sparkles size={14} className="text-accent shrink-0" />
                                <span>{engineStatusMessage}</span>
                            </div>
                        )}
                    </SettingsSection>
                </div>
            )}

            {/* TAB 6: ABOUT & ROADMAP */}
            {activeSection === "about" && (
                <div className="space-y-6 animate-in fade-in duration-150">
                    {/* Hero Header */}
                    <div className="p-6 bg-surface-1 rounded-2xl border border-border-subtle shadow-sm space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-3.5">
                                <div className="w-14 h-14 rounded-2xl bg-accent-subtle text-accent flex items-center justify-center font-black text-title shadow-xs">
                                    DV
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h3 className="font-extrabold text-title-sm text-primary tracking-tight">Devizee Lite - Universal Video Downloader</h3>
                                        <span className="px-2 py-0.5 rounded-full bg-accent/15 text-accent text-[11px] font-bold">
                                            v0.5.2
                                        </span>
                                    </div>
                                    <p className="text-caption text-secondary">Universal High-Performance Media Downloader • Tauri v2 & Rust Native</p>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <a
                                    href="https://github.com/Touseeef/devizee-lite-universal-video-downloader"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="px-3 py-2 rounded-xl bg-surface-2 hover:bg-surface-3 border border-border-subtle text-caption font-semibold text-primary transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs hover:scale-[1.02]"
                                >
                                    <span>GitHub Repo</span>
                                    <ExternalLink size={13} />
                                </a>
                                {onOpenSupportedSites && (
                                    <button
                                        type="button"
                                        onClick={onOpenSupportedSites}
                                        className="px-3 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-caption font-semibold transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs hover:scale-[1.02]"
                                    >
                                        <Globe size={13} />
                                        <span>Supported Sites & DRM</span>
                                    </button>
                                )}
                                <a
                                    href="https://github.com/Touseeef/devizee-lite-universal-video-downloader/issues/new?template=bug.md"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="px-3 py-2 rounded-xl bg-status-danger/10 hover:bg-status-danger/20 border border-status-danger/30 text-caption font-semibold text-status-danger transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs hover:scale-[1.02]"
                                >
                                    <span>Report a Bug</span>
                                    <ExternalLink size={13} />
                                </a>
                                <a
                                    href="https://github.com/Touseeef/devizee-lite-universal-video-downloader/issues/new?template=feature.md"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="px-3 py-2 rounded-xl bg-accent/10 hover:bg-accent/20 border border-accent/30 text-caption font-semibold text-accent transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs hover:scale-[1.02]"
                                >
                                    <span>Request a Feature</span>
                                    <ExternalLink size={13} />
                                </a>
                            </div>
                        </div>

                        <p className="text-body-sm text-secondary leading-relaxed">
                            Engineered from the ground up to replace bloated, ad-ridden web downloaders and prior-art GUIs.
                            Devizee runs sidecar binaries with Windows Job Objects isolation, zero network proxies, and zero tracking.
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                            <div className="p-3 rounded-xl bg-surface-2 border border-border-subtle/60 space-y-1">
                                <span className="text-[12px] font-bold text-primary flex items-center gap-1.5">
                                    <Shield size={13} className="text-accent" /> Zero Telemetry (NFR-6)
                                </span>
                                <p className="text-[11px] text-tertiary">Zero background pingbacks, zero analytics, pure local execution.</p>
                            </div>
                            <div className="p-3 rounded-xl bg-surface-2 border border-border-subtle/60 space-y-1">
                                <span className="text-[12px] font-bold text-primary flex items-center gap-1.5">
                                    <Cpu size={13} className="text-accent" /> Process Sandboxing (NFR-4)
                                </span>
                                <p className="text-[11px] text-tertiary">Windows Job Objects guarantees child ffmpeg & yt-dlp clean termination.</p>
                            </div>
                            <div className="p-3 rounded-xl bg-surface-2 border border-border-subtle/60 space-y-1">
                                <span className="text-[12px] font-bold text-primary flex items-center gap-1.5">
                                    <Sparkles size={13} className="text-accent" /> Creator & Architect
                                </span>
                                <p className="text-[11px] text-tertiary">Crafted by Touseef • Dedicated to clean desktop engineering.</p>
                            </div>
                        </div>
                    </div>

                    {/* F3: System Info + Copy Diagnostics */}
                    <div className="p-6 bg-surface-1 rounded-2xl border border-border-subtle shadow-sm space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
                                    <Cpu size={16} />
                                </div>
                                <div>
                                    <h3 className="font-bold text-body text-primary">System Information</h3>
                                    <p className="text-caption text-secondary">Useful for bug reports and support</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={async () => {
                                    const match = navigator.userAgent.match(/Edg\/([\d.]+)/);
                                    const webview = match ? match[1] : "unknown";
                                    const info = [
                                        "Devizee Lite v0.5.2",
                                        `Platform: ${navigator.platform}`,
                                        `User agent: ${navigator.userAgent}`,
                                        `WebView2: ${webview}`,
                                        `Language: ${navigator.language}`,
                                        `Screen: ${window.screen.width}x${window.screen.height}`,
                                        `Device pixel ratio: ${window.devicePixelRatio}`,
                                        `Timestamp: ${new Date().toISOString()}`,
                                    ].join("\n");
                                    try {
                                        await navigator.clipboard.writeText(info);
                                        setDiagCopied(true);
                                        setTimeout(() => setDiagCopied(false), 2000);
                                    } catch (e) {
                                        console.error("Clipboard failed:", e);
                                    }
                                }}
                                className={`px-3 py-2 rounded-xl text-caption font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-2xs ${diagCopied
                                    ? "bg-status-success text-white"
                                    : "bg-surface-2 hover:bg-surface-3 border border-border-subtle text-primary"
                                    }`}
                                title="Copy diagnostic info to clipboard"
                            >
                                {diagCopied ? (
                                    <>
                                        <Check size={13} />
                                        <span>Copied!</span>
                                    </>
                                ) : (
                                    <>
                                        <Copy size={13} />
                                        <span>Copy Diagnostics</span>
                                    </>
                                )}
                            </button>
                        </div>
                        <pre className="p-3 rounded-xl bg-surface-2/60 border border-border-subtle text-[11px] font-mono text-secondary leading-relaxed whitespace-pre-wrap overflow-x-auto">
                            {`Devizee Lite v0.5.2 · Tauri v2 · Rust + React
Repository: github.com/Touseeef/devizee-lite-universal-video-downloader
Privacy: Zero telemetry. All processing local.`}
                        </pre>
                    </div>

                    {/* Devizee Lite vs All-In-One (AIO) Roadmap Matrix */}
                    <div className="p-6 bg-surface-1 rounded-2xl border border-border-subtle shadow-sm space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-bold text-body text-primary">Product Roadmap: Devizee Lite vs Devizee All-In-One (AIO)</h3>
                                <p className="text-caption text-secondary">Phased roadmap ensuring rock-solid stability before full suite launch</p>
                            </div>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-border-subtle/80">
                            <table className="w-full text-left border-collapse text-caption">
                                <thead>
                                    <tr className="bg-surface-2/80 border-b border-border-subtle text-secondary font-bold">
                                        <th className="p-3">Capability / Feature</th>
                                        <th className="p-3">Devizee Lite (Current)</th>
                                        <th className="p-3 text-accent">Devizee AIO (Phase 2 Master)</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border-subtle/60 text-secondary">
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Core Purpose</td>
                                        <td className="p-3">Universal Video & Audio Downloader</td>
                                        <td className="p-3 font-semibold text-accent">All-In-One Multi-Protocol Download Manager</td>
                                    </tr>
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Media Sources</td>
                                        <td className="p-3">YouTube, TikTok, Instagram, X, FB, Twitch (yt-dlp)</td>
                                        <td className="p-3 font-semibold text-accent">Streaming Sites + Direct Files (ZIP, ISO, EXE, PDF)</td>
                                    </tr>
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Multi-Segment Acceleration</td>
                                        <td className="p-3 text-tertiary">Direct Stream (Single Pipe)</td>
                                        <td className="p-3 font-semibold text-accent">16–32 Simultaneous HTTP Range Chunks (IDM-class)</td>
                                    </tr>
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Browser Companion Extension</td>
                                        <td className="p-3 text-tertiary">Batch URL Paste & TXT Import Modal</td>
                                        <td className="p-3 font-semibold text-accent">Manifest V3 Native Relay & Webpage Link Grabber</td>
                                    </tr>
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Auto-Sorting ("Exclude Multimedia")</td>
                                        <td className="p-3 text-tertiary">Dedicated Videos & Audio Folders</td>
                                        <td className="p-3 font-semibold text-accent">Smart Content-Type Router & "Exclude Multimedia" filter</td>
                                    </tr>
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Sound & Equalizer Engine</td>
                                        <td className="p-3 font-semibold text-status-success">8-Band Hardware EQ & Audio Previews</td>
                                        <td className="p-3 font-semibold text-accent">Full AcoustID Metadata Tagger & Library Hub</td>
                                    </tr>
                                    <tr className="hover:bg-surface-2/40 transition-colors">
                                        <td className="p-3 font-semibold text-primary">Privacy & Sandboxing</td>
                                        <td className="p-3 font-semibold text-status-success">100% Local, Job Objects, Zero Tracking</td>
                                        <td className="p-3 font-semibold text-status-success">100% Local, Job Objects, Zero Tracking</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}