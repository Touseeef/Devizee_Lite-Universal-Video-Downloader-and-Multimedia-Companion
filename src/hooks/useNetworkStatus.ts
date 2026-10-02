import { useState, useEffect } from "react";
import { sendNotification } from "@tauri-apps/plugin-notification";

interface UseNetworkStatusOptions {
    isHud?: boolean;
    showNotifications?: boolean;
}

export function useNetworkStatus({ isHud = false, showNotifications = true }: UseNetworkStatusOptions = {}) {
    const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

    useEffect(() => {
        if (isHud) return;

        let wentOffline = false;

        const goOnline = () => {
            setIsOnline(true);
            if (wentOffline && showNotifications) {
                sendNotification({
                    title: "Devizee - Connection Restored",
                    body: "Downloads are resuming automatically.",
                });
            }
            wentOffline = false;
        };

        const goOffline = () => {
            setIsOnline(false);
            wentOffline = true;
            if (showNotifications) {
                sendNotification({
                    title: "Devizee - No Internet Connection",
                    body: "Active downloads are paused. They will resume automatically when the connection returns.",
                });
            }
        };

        window.addEventListener("online", goOnline);
        window.addEventListener("offline", goOffline);
        return () => {
            window.removeEventListener("online", goOnline);
            window.removeEventListener("offline", goOffline);
        };
    }, [isHud, showNotifications]);

    return { isOnline, setIsOnline };
}
