// src/components/layout/AppShell.tsx
import { useCallback, useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { TitleBar } from "./TitleBar";

export function AppShell({
    sidebar,
    mainRef,
    minimizeToTray = true,
    onCloseClick,
    isTheaterMode = false,
    children,
}: {
    sidebar: (collapsed: boolean, onToggleCollapse: () => void) => ReactNode;
    mainRef?: RefObject<HTMLElement | null>;
    minimizeToTray?: boolean;
    onCloseClick?: () => void;
    isTheaterMode?: boolean;
    children: ReactNode;
}) {
    const [autoCollapsed, setAutoCollapsed] = useState(false);
    const [manualOverride, setManualOverride] = useState<boolean | null>(null);

    useEffect(() => {
        const check = () => setAutoCollapsed(window.innerWidth < 1100);
        check();
        window.addEventListener("resize", check);
        return () => window.removeEventListener("resize", check);
    }, []);

    const collapsed = manualOverride !== null ? manualOverride : autoCollapsed;

    const onToggleCollapse = useCallback(() => {
        setManualOverride((prev) => {
            const current = prev !== null ? prev : autoCollapsed;
            return !current;
        });
    }, [autoCollapsed]);

    return (
        <div className={`flex flex-col h-screen text-primary font-sans antialiased overflow-hidden select-none transition-colors duration-300 ${isTheaterMode ? "bg-[#06080d]" : "bg-surface-0"}`}>
            <div className={`transition-opacity duration-300 shrink-0 ${isTheaterMode ? "opacity-20 hover:opacity-100 focus-within:opacity-100" : ""}`}>
                <TitleBar minimizeToTray={minimizeToTray} onCloseClick={onCloseClick} />
            </div>
            <div className="flex flex-1 overflow-hidden">
                <div className={`transition-opacity duration-300 h-full flex shrink-0 ${isTheaterMode ? "opacity-20 hover:opacity-100 focus-within:opacity-100" : ""}`}>
                    {sidebar(collapsed, onToggleCollapse)}
                </div>
                <main
                    ref={mainRef}
                    className={`relative flex-1 overflow-y-auto p-4 md:p-6 space-y-6 transition-colors duration-300 ${isTheaterMode ? "bg-[#06080d]" : ""}`}
                >
                    {children}
                </main>
            </div>
        </div>
    );
}