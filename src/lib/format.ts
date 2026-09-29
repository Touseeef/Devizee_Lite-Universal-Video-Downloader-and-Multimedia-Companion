// src/lib/format.ts

export const formatFileSize = (bytes?: number | null): string => {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let val = bytes;
    let idx = 0;
    while (val >= 1024 && idx < units.length - 1) {
        val /= 1024;
        idx++;
    }
    return `${val.toFixed(1)} ${units[idx]}`;
};

export const parseTimeToSeconds = (str: string): number => {
    if (!str) return 0;
    const parts = str.trim().split(":").map(Number);
    if (parts.length === 3)
        return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
    return Number(str) || 0;
};

export const formatSecondsToTime = (
    secs: number,
    forceHours: boolean = false
): string => {
    const s = Math.max(0, Math.floor(secs));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (forceHours || h > 0) {
        return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}:${sec < 10 ? "0" : ""}${sec}`;
    }
    return `${m < 10 ? "0" : ""}${m}:${sec < 10 ? "0" : ""}${sec}`;
};

export const estimateFormatBytes = (
    format?: {
        filesize_approx?: number | null;
        resolution?: string | null;
        is_audio_only?: boolean | null;
        label?: string | null;
        ext?: string | null;
    } | null,
    durationSeconds?: number | null
): number | null => {
    if (!format) return null;
    if (format.filesize_approx && format.filesize_approx > 0) {
        return format.filesize_approx;
    }
    const dur = durationSeconds || 0;
    if (dur <= 0) return null;

    const labelLower = (format.label || "").toLowerCase();
    const isAudio =
        !!format.is_audio_only ||
        labelLower.includes("mp3") ||
        labelLower.includes("m4a") ||
        labelLower.includes("flac") ||
        labelLower.includes("wav") ||
        labelLower.includes("opus") ||
        labelLower.includes("audio");

    if (isAudio) {
        if (
            labelLower.includes("lossless") ||
            labelLower.includes("flac") ||
            labelLower.includes("wav")
        ) {
            // ~1000 kbps (125 KB/s)
            return Math.round(dur * 125 * 1024);
        }
        if (labelLower.includes("320")) {
            // 320 kbps (40 KB/s)
            return Math.round(dur * 40 * 1024);
        }
        if (labelLower.includes("256")) {
            // 256 kbps (32 KB/s)
            return Math.round(dur * 32 * 1024);
        }
        if (labelLower.includes("128")) {
            // 128 kbps (16 KB/s)
            return Math.round(dur * 16 * 1024);
        }
        // default audio: ~160 kbps (20 KB/s)
        return Math.round(dur * 20 * 1024);
    }

    // Video bitrates (video + audio combined estimate)
    const res = (format.resolution || format.label || "").toLowerCase();
    if (res.includes("4320") || res.includes("8k")) {
        // ~35 Mbps = ~4.3 MB/s
        return Math.round(dur * 4.3 * 1024 * 1024);
    }
    if (res.includes("2160") || res.includes("4k")) {
        // ~15 Mbps = ~1.85 MB/s
        return Math.round(dur * 1.85 * 1024 * 1024);
    }
    if (res.includes("1440") || res.includes("2k")) {
        // ~8 Mbps = ~1.0 MB/s
        return Math.round(dur * 1.0 * 1024 * 1024);
    }
    if (res.includes("1080")) {
        // ~4.5 Mbps = ~560 KB/s
        return Math.round(dur * 560 * 1024);
    }
    if (res.includes("720")) {
        // ~2.2 Mbps = ~275 KB/s
        return Math.round(dur * 275 * 1024);
    }
    if (res.includes("480")) {
        // ~1.0 Mbps = ~125 KB/s
        return Math.round(dur * 125 * 1024);
    }
    if (res.includes("360")) {
        // ~500 kbps = ~62 KB/s
        return Math.round(dur * 62 * 1024);
    }
    // Default video estimate ~2.5 Mbps (~300 KB/s)
    return Math.round(dur * 300 * 1024);
};

export const formatEstimatedSize = (
    format?: {
        filesize_approx?: number | null;
        resolution?: string | null;
        is_audio_only?: boolean | null;
        label?: string | null;
        ext?: string | null;
    } | null,
    durationSeconds?: number | null
): string => {
    const bytes = estimateFormatBytes(format, durationSeconds);
    if (!bytes || bytes <= 0) return "";
    return `~${formatFileSize(bytes)}`;
};