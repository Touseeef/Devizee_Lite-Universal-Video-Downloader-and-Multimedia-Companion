import { useState, useEffect } from "react";

export function useThemeManager(
    initialTheme?: string,
    updateSetting?: (key: string, val: any) => void
) {
    const [theme, setTheme] = useState<string>(() => {
        return initialTheme || localStorage.getItem("devizee_theme") || "dark";
    });

    const handleThemeChange = (newTheme: string) => {
        setTheme(newTheme);
        updateSetting?.("theme", newTheme);
    };

    // Immediate theme application (supports all 5 themes and sets data-theme attribute)
    useEffect(() => {
        localStorage.setItem("devizee_theme", theme);
        document.documentElement.setAttribute("data-theme", theme);
        // Light mode is the only non-dark theme; OLED, Sunset, and Frost are dark-variant themes
        document.documentElement.classList.toggle("dark", theme !== "light");
    }, [theme]);

    return { theme, setTheme, handleThemeChange };
}
