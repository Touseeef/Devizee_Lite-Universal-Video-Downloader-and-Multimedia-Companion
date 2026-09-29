import type { TaskStatus, ErrorCode } from "../status";

export type FormatOption = {
    format_id: string;
    label: string;
    ext: string;
    is_audio_only: boolean;
    resolution: string | null;
    filesize_approx: number | null;
};

export type VideoInfo = {
    id: string;
    title: string;
    url: string;
    thumbnail: string;
    duration: number | null;
    duration_string: string;
    uploader: string;
    video_formats: FormatOption[];
    audio_formats: FormatOption[];
    formats: FormatOption[];
    has_subtitles?: boolean;
    subtitle_languages?: string[];
};

export type PlaylistEntry = {
    id: string;
    title: string;
    url: string;
    thumbnail: string;
    duration_string: string;
};

export type PlaylistInfo = {
    id: string;
    title: string;
    uploader: string;
    entries: PlaylistEntry[];
};

export type DownloadRecord = {
    id: string;
    url: string;
    title: string;
    file_path: string | null;
    status: TaskStatus;
    percent: number;
    speed?: string;
    eta?: string;
    format: string;
    format_id?: string;
    date_added: number;
    hidden: boolean;
    file_size?: number | null;
    error_code?: ErrorCode;
    error_message?: string;
};

// Single source of truth for "what is playing, and is it playing or paused".
export type NowPlayingState = "playing" | "paused";

export type NowPlaying =
    | { type: "none"; source?: "dashboard" | "multimedia" }
    | { type: "audio"; id: string; state: NowPlayingState; source?: "dashboard" | "multimedia" }
    | { type: "video"; id: string; state: NowPlayingState; source?: "dashboard" | "multimedia" };

// Playback source context to prevent queue collisions between live playlists and local library
export type PlaySource = "none" | "downloadedLibrary" | "livePlaylist";

// Primary Navigation Tabs for Devizee Lite
export type TabType = "dashboard" | "downloads" | "multimedia" | "settings";