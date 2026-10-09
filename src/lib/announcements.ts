// src/lib/announcements.ts

export type AnnouncementType = "update" | "feature" | "announcement" | "tip";

export interface AnnouncementItem {
    id: string;
    title: string;
    date: string;
    type?: AnnouncementType;
    tag?: string;
    tagColor?: "indigo" | "emerald" | "amber" | "sky" | "rose";
    version?: string;
    summary: string;
    content: string;
    action?: {
        label: string;
        url: string;
    };
}

const GITHUB_ANNOUNCEMENTS_URL =
    "https://raw.githubusercontent.com/Touseeef/Devizee_Lite-Universal-Video-Downloader-and-Multimedia-Companion/main/announcements.json";

const STORAGE_CACHE_KEY = "devizee_announcements_cache";
const STORAGE_LAST_CHECK_KEY = "devizee_announcements_last_checked";
const STORAGE_READ_IDS_KEY = "devizee_read_announcements";

// Built-in fallback announcements shown offline or on first boot
export const DEFAULT_ANNOUNCEMENTS: AnnouncementItem[] = [
    {
        id: "ann-v052-launch",
        title: "Devizee Lite v0.5.2 is Live! 🚀",
        date: "2026-10-04",
        type: "update",
        tag: "New Release",
        tagColor: "indigo",
        version: "v0.5.2",
        summary: "Batch Link Collector radar, real-time 8-band Equalizer, and zero-lag dragging.",
        content: `### Welcome to Devizee Lite v0.5.2!

Here is what's new in this release:
- **Batch Link Collector (Radar)**: Click multiple videos or links on any webpage to queue them in batch without interrupting playback.
- **Real-Time Audio Equalizer**: 8-band parametric EQ with pre-built audio presets (Bass Boost, Vocal Booster, Flat, and more).
- **Zero-Lag Draggable UI**: Butter-smooth dragging for the floating grabber pill and batch radar banner.
- **Smart Thumbnail Detection**: Clicking video thumbnails on YouTube accurately grabs the full video title instead of duration badges.
- **Privacy-First**: No tracking, no telemetry, all state preserved locally.`,
        action: {
            label: "View Release Notes",
            url: "https://github.com/Touseeef/Devizee_Lite-Universal-Video-Downloader-and-Multimedia-Companion/releases",
        },
    },
    {
        id: "ann-tip-theatre",
        title: "Pro Tip: Distraction-Free Theatre Mode 🎬",
        date: "2026-10-03",
        type: "tip",
        tag: "Pro Tip",
        tagColor: "emerald",
        summary: "Darken the interface for an immersive listening and viewing experience.",
        content: `Did you know? In the **Multimedia Hub**, clicking the **Theatre Mode** button dims all surrounding interface elements.

Combine Theatre Mode with your favorite Audio Equalizer preset for high-fidelity, distraction-free listening!`,
    },
];

/**
 * Get read announcement IDs from localStorage
 */
export function getReadAnnouncementIds(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_READ_IDS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch { }
    return [];
}

/**
 * Mark a single announcement ID as read
 */
export function markAnnouncementAsRead(id: string): string[] {
    try {
        const current = getReadAnnouncementIds();
        if (!current.includes(id)) {
            const updated = [...current, id];
            localStorage.setItem(STORAGE_READ_IDS_KEY, JSON.stringify(updated));
            return updated;
        }
        return current;
    } catch {
        return [];
    }
}

/**
 * Mark all given announcements as read
 */
export function markAllAnnouncementsAsRead(items: AnnouncementItem[]): string[] {
    try {
        const current = new Set(getReadAnnouncementIds());
        items.forEach((item) => current.add(item.id));
        const updated = Array.from(current);
        localStorage.setItem(STORAGE_READ_IDS_KEY, JSON.stringify(updated));
        return updated;
    } catch {
        return [];
    }
}

/**
 * Calculate the count of unread announcements
 */
export function getUnreadAnnouncementsCount(items: AnnouncementItem[], readIds?: string[]): number {
    const read = new Set(readIds || getReadAnnouncementIds());
    return items.filter((item) => !read.has(item.id)).length;
}

/**
 * Anonymously fetch announcements from public GitHub feed.
 * Respects cache (4 hours) unless force=true.
 * Fails safely to cached or default announcements without telemetry.
 */
export async function fetchAnnouncements(force = false): Promise<AnnouncementItem[]> {
    const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

    // 1. Check local cache if not forced
    if (!force) {
        try {
            const lastChecked = parseInt(localStorage.getItem(STORAGE_LAST_CHECK_KEY) || "0", 10);
            const cachedRaw = localStorage.getItem(STORAGE_CACHE_KEY);
            if (cachedRaw && Date.now() - lastChecked < CACHE_TTL_MS) {
                const parsed = JSON.parse(cachedRaw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            }
        } catch { }
    }

    // 2. Fetch anonymously from static GitHub JSON feed
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4500);

        const response = await fetch(GITHUB_ANNOUNCEMENTS_URL, {
            signal: controller.signal,
            cache: "no-store",
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                // Cache successfully fetched announcements
                try {
                    localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(data));
                    localStorage.setItem(STORAGE_LAST_CHECK_KEY, String(Date.now()));
                } catch { }
                return data;
            }
        }
    } catch {
        // Network offline or failed — fallback silently to cache or defaults
    }

    // 3. Fallback to cached or default announcements
    try {
        const cachedRaw = localStorage.getItem(STORAGE_CACHE_KEY);
        if (cachedRaw) {
            const parsed = JSON.parse(cachedRaw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        }
    } catch { }

    return DEFAULT_ANNOUNCEMENTS;
}
