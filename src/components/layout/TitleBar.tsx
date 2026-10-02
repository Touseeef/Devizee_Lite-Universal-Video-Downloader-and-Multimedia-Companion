import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Minus, Square, X } from "lucide-react";
import devizeeLogo from "../../assets/devizee-logo.png";

export function TitleBar({
    minimizeToTray = true,
    onCloseClick,
}: {
    minimizeToTray?: boolean;
    onCloseClick?: () => void;
}) {
    const [isMaximized, setIsMaximized] = useState(false);
    const [appVersion, setAppVersion] = useState("0.6.0");
    const appWindow = getCurrentWindow();

    useEffect(() => {
        import("@tauri-apps/api/app").then(m => m.getVersion()).then(v => {
            if (v) setAppVersion(v);
        }).catch(() => {});
    }, []);

    useEffect(() => {
        let mounted = true;

        const checkMaximized = async () => {
            try {
                const max = await appWindow.isMaximized();
                if (mounted) setIsMaximized(max);
            } catch { }
        };

        checkMaximized();

        // Listen for window resize / maximize changes
        let unlistenResize: (() => void) | null = null;
        appWindow.onResized(() => {
            checkMaximized();
        }).then((f) => {
            unlistenResize = f;
        });

        return () => {
            mounted = false;
            if (unlistenResize) unlistenResize();
        };
    }, []);

    const handleStartDrag = (e: React.MouseEvent) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button")) {
            appWindow.startDragging().catch((err) => {
                console.error("Failed to start dragging:", err);
            });
        }
    };

    const handleMinimize = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await appWindow.minimize();
        } catch (e) {
            console.error("Failed to minimize window:", e);
        }
    };

    const handleToggleMaximize = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await appWindow.toggleMaximize();
            const max = await appWindow.isMaximized();
            setIsMaximized(max);
        } catch (e) {
            console.error("Failed to toggle maximize:", e);
        }
    };

    const handleClose = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onCloseClick) {
            onCloseClick();
            return;
        }
        try {
            if (minimizeToTray) {
                await appWindow.hide();
            } else {
                await invoke("exit_app");
            }
        } catch (e) {
            console.error("Failed to close/hide window:", e);
            try {
                await appWindow.close();
            } catch { }
        }
    };

    return (
        <div
            data-tauri-drag-region
            onMouseDown={handleStartDrag}
            onDoubleClick={handleToggleMaximize}
            className="h-9 w-full bg-surface-1/90 backdrop-blur-md border-b border-border-subtle flex items-center justify-between select-none shrink-0 z-50 text-secondary"
        >
            {/* Left: App Brand & Icon */}
            <div
                data-tauri-drag-region
                className="flex items-center gap-2 pl-3 pointer-events-none"
            >
                <img
                    src={devizeeLogo}
                    alt="Devizee"
                    className="w-4 h-4 object-contain"
                />
                <span className="text-[12px] font-semibold tracking-wide text-primary">
                    Devizee Lite
                </span>
                <span className="text-[10px] font-mono text-tertiary px-1.5 py-0.2 rounded bg-surface-2 border border-border-subtle/40">
                    {appVersion ? `v${appVersion}` : "v0.6.0"}
                </span>
            </div>

            {/* Center: Draggable Spacer */}
            <div
                data-tauri-drag-region
                onMouseDown={handleStartDrag}
                className="flex-1 h-full cursor-default"
            />

            {/* Right: Window Controls (Minimize, Maximize/Restore, Close) */}
            <div
                className="flex items-center h-full"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <button
                    type="button"
                    onClick={handleMinimize}
                    className="h-full px-3.5 flex items-center justify-center text-secondary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                    title="Minimize"
                >
                    <Minus size={13} strokeWidth={2} />
                </button>

                <button
                    type="button"
                    onClick={handleToggleMaximize}
                    className="h-full px-3.5 flex items-center justify-center text-secondary hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                    title={isMaximized ? "Restore Down" : "Maximize"}
                >
                    {isMaximized ? (
                        <Copy size={11} strokeWidth={2} className="rotate-90" />
                    ) : (
                        <Square size={11} strokeWidth={2} />
                    )}
                </button>

                <button
                    type="button"
                    onClick={handleClose}
                    className="h-full px-4 flex items-center justify-center text-secondary hover:text-white hover:bg-[#e81123] transition-colors cursor-pointer"
                    title={minimizeToTray ? "Minimize to Tray" : "Close"}
                >
                    <X size={13} strokeWidth={2} />
                </button>
            </div>
        </div>
    );
}
