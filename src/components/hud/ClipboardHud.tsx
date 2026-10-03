import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Download, Loader2 } from "lucide-react";

type HudPayload = {
    info: {
        id: string;
        title: string;
        thumbnail: string;
    };
    url: string;
};

export function ClipboardHud({ settings }: { settings: any }) {
    const [hudData, setHudData] = useState<HudPayload | null>(null);

    useEffect(() => {
        const unlisten = listen<HudPayload>("hud-data", (e) => {
            setHudData(e.payload);
        });
        return () => {
            unlisten.then((f) => f());
        };
    }, []);

    return (
        <div className="w-full h-full bg-surface-1 rounded-md p-3 shadow-floating flex flex-col justify-center overflow-hidden border border-border-subtle">
            {hudData?.info ? (
                <>
                    <div className="flex gap-2.5 items-center">
                        <img
                            src={hudData.info.thumbnail}
                            className="w-14 aspect-video object-cover rounded-sm shrink-0 shadow-sm"
                            alt=""
                        />
                        <div className="flex-1 min-w-0">
                            <h4 className="text-body-sm font-semibold truncate text-primary">
                                {hudData.info.title}
                            </h4>
                            <p className="text-caption text-secondary truncate">Detected in clipboard</p>
                        </div>
                    </div>
                    <div className="flex gap-2 mt-2">
                        <button
                            onClick={async () => {
                                await invoke("start_download", {
                                    taskId: `${hudData.info.id}-${Date.now()}`,
                                    url: hudData.url,
                                    title: hudData.info.title,
                                    formatId: "bestvideo+bestaudio/best",
                                    formatLabel: "Best Video",
                                    ext: "mp4",
                                    isAudioOnly: false,
                                    baseDir: settings.saveFolder,
                                    videoDir: settings.videoFolder,
                                    audioDir: settings.audioFolder,
                                    docsDir: settings.generalFolder,
                                    compDir: settings.compressedFolder,
                                    progDir: settings.programsFolder,
                                    tempDir: settings.tempFolder ? settings.tempFolder : null,
                                    speedLimit: null,
                                    proxy: null,
                                    customFlags: null,
                                    scanAntivirus: true,
                                    downloadSections: null,
                                });
                                const win = getCurrentWebviewWindow();
                                await win.hide();
                            }}
                            className="flex-1 bg-accent text-white py-1 rounded-sm text-caption font-semibold hover:bg-accent-hover transition-colors flex items-center justify-center gap-1"
                        >
                            <Download size={12} />
                            <span>Download Best</span>
                        </button>
                        <button
                            onClick={async () => {
                                const win = getCurrentWebviewWindow();
                                await win.hide();
                            }}
                            className="px-3 bg-surface-2 text-primary py-1 rounded-sm text-caption font-semibold hover:bg-surface-0 transition-colors"
                        >
                            Dismiss
                        </button>
                    </div>
                </>
            ) : (
                <div className="w-full h-full flex items-center justify-center text-secondary gap-2 font-medium text-body-sm">
                    <Loader2 className="animate-spin text-accent" size={16} /> Inspecting clipboard...
                </div>
            )}
        </div>
    );
}