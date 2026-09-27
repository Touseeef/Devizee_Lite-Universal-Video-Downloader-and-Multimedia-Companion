// src/components/layout/AppShell.tsx
import { useCallback, useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { TitleBar } from "./TitleBar";

export function AppShell({
    sidebar,
    mainRef,
    minimizeToTray = true,
    onCloseClick,
    children,
}: {
    sidebar: (collapsed: boolean, onToggleCollapse: () => void) => ReactNode;
    mainRef?: RefObject<HTMLElement | null>;
    minimizeToTray?: boolean;
    onCloseClick?: () => void;
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
        <div className="flex flex-col h-screen bg-surface-0 text-primary font-sans antialiased overflow-hidden select-none">
            <TitleBar minimizeToTray={minimizeToTray} onCloseClick={onCloseClick} />
            <div className="flex flex-1 overflow-hidden">
                {sidebar(collapsed, onToggleCollapse)}
                <main
                    ref={mainRef}
                    className="relative flex-1 overflow-y-auto p-4 md:p-6 space-y-6"
                >
                    {children}
                </main>
            </div>
        </div>
    );
}