use serde::{Deserialize, Serialize};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::engine::get_yt_dlp_path;
use crate::run_command_with_timeout;

/// Structure representing a clean, selectable format option for the user
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatOption {
    pub format_id: String,
    pub label: String,
    pub ext: String,
    pub is_audio_only: bool,
    pub resolution: Option<String>,
    pub filesize_approx: Option<u64>,
}

/// Chapter marker extracted from video metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chapter {
    pub start_time: f64,
    pub end_time: f64,
    pub title: String,
}

/// Normalized video metadata returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: String,
    pub duration: Option<u64>,
    pub duration_string: String,
    pub uploader: String,
    pub video_formats: Vec<FormatOption>,
    pub audio_formats: Vec<FormatOption>,
    pub formats: Vec<FormatOption>,
    #[serde(default)]
    pub has_subtitles: Option<bool>,
    #[serde(default)]
    pub subtitle_languages: Option<Vec<String>>,
    #[serde(default)]
    pub chapters: Option<Vec<Chapter>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PlaylistEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: String,
    pub duration_string: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PlaylistInfo {
    pub id: String,
    pub title: String,
    pub uploader: String,
    pub entries: Vec<PlaylistEntry>,
}

/// Returns extra yt-dlp args to load cookies from a browser's cookie store.
/// Returns empty when disabled. Browser value matches yt-dlp's
/// --cookies-from-browser spec: "chrome", "edge", "firefox", "brave", etc.
pub fn cookies_args(cookies_from_browser: Option<String>) -> Vec<String> {
    match cookies_from_browser.as_deref() {
        Some(b) if !b.is_empty() && b != "none" => {
            vec!["--cookies-from-browser".to_string(), b.to_string()]
        }
        _ => Vec::new(),
    }
}

/// Checks if a URL belongs to known DRM-restricted subscription services
pub fn is_known_drm_service(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("netflix.com")
        || lower.contains("disneyplus.com")
        || lower.contains("primevideo.com")
        || lower.contains("hulu.com")
        || lower.contains("hbomax.com")
        || lower.contains("max.com")
        || lower.contains("peacocktv.com")
        || lower.contains("paramountplus.com")
        || (lower.contains("apple.com") && lower.contains("/tv"))
        || lower.contains("spotify.com")
}

/// Normalizes YouTube Mix links (list=RD...) and tracking query parameters so yt-dlp metadata extraction never fails
pub fn sanitize_media_url_for_metadata(url: &str) -> String {
    let trimmed = url.trim();
    if (trimmed.contains("youtube.com") || trimmed.contains("youtu.be")) && trimmed.contains("list=RD") {
        if let Some(pos) = trimmed.find("v=") {
            let rest = &trimmed[pos + 2..];
            let vid = rest.split('&').next().unwrap_or(rest);
            if vid.len() == 11 {
                return format!("https://www.youtube.com/watch?v={}", vid);
            }
        } else if let Some(pos) = trimmed.find("youtu.be/") {
            let rest = &trimmed[pos + 9..];
            let vid = rest.split('?').next().unwrap_or(rest).split('&').next().unwrap_or(rest);
            if vid.len() == 11 {
                return format!("https://www.youtube.com/watch?v={}", vid);
            }
        }
    }
    trimmed.to_string()
}

/// Tauri command to inspect any URL and extract metadata & format tiers
#[tauri::command]
pub async fn fetch_video_info(
    url: String,
    cookies_from_browser: Option<String>,
    allow_insecure_ssl: Option<bool>,
    app: tauri::AppHandle,
) -> Result<VideoInfo, String> {
    if is_known_drm_service(&url) {
        return Err("DRM_PROTECTED: This platform uses hardware-level DRM encryption (Widevine/PlayReady) and cannot be downloaded.".to_string());
    }

    let target_url = sanitize_media_url_for_metadata(&url);
    let yt_dlp_path = get_yt_dlp_path(&app)?;

    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--force-ipv4",
        "--geo-bypass",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--compat-options",
        "no-youtube-unavailable-videos",
        "--extractor-args",
        "youtube:player_client=android,web;skip=dash,translated_subs,comments",
    ]);

    if allow_insecure_ssl == Some(true) {
        cmd.arg("--no-check-certificates");
    }

    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    cmd.arg(&target_url);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    // F-20: 30s timeout so a hung YouTube response can't freeze the UI
    let output = run_command_with_timeout(cmd, 30, "yt-dlp metadata fetch")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let cleaned_error = stderr
            .lines()
            .find(|line| line.starts_with("ERROR:"))
            .unwrap_or(&stderr)
            .to_string();

        let err_lower = cleaned_error.to_lowercase();
        if err_lower.contains("drm protected") {
            return Err("DRM_PROTECTED: This media is protected by Digital Rights Management (DRM) and cannot be downloaded.".to_string());
        } else if err_lower.contains("sign in to confirm")
            || err_lower.contains("login required")
            || err_lower.contains("requires login")
            || err_lower.contains("private video")
            || err_lower.contains("this video is private")
            || err_lower.contains("only available to registered users")
            || err_lower.contains("age verification")
            || err_lower.contains("cookies are needed")
            || err_lower.contains("401 unauthorized")
            || (err_lower.contains("403 forbidden") && (url.contains("instagram.com") || url.contains("tiktok.com") || url.contains("twitter.com") || url.contains("x.com")))
        {
            return Err(format!("AUTH_REQUIRED: {}", cleaned_error));
        }

        return Err(cleaned_error);
    }

    let json_val: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse metadata JSON: {}", e))?;

    let id = json_val["id"].as_str().unwrap_or("unknown").to_string();
    let title = json_val["title"]
        .as_str()
        .unwrap_or("Untitled Video")
        .to_string();
    let thumbnail = json_val["thumbnail"].as_str().unwrap_or("").to_string();
    let duration = json_val["duration"].as_u64();
    let uploader = json_val["uploader"]
        .as_str()
        .or_else(|| json_val["channel"].as_str())
        .unwrap_or("Unknown Uploader")
        .to_string();

    let duration_string = match duration {
        Some(secs) => {
            let h = secs / 3600;
            let m = (secs % 3600) / 60;
            let s = secs % 60;
            if h > 0 {
                format!("{:02}:{:02}:{:02}", h, m, s)
            } else {
                format!("{:02}:{:02}", m, s)
            }
        }
        None => "--:--".to_string(),
    };

    let mut video_formats: Vec<FormatOption> = Vec::new();
    let mut audio_formats: Vec<FormatOption> = Vec::new();

    // -- VIDEO FORMATS (Primary + Dropdown) --
    // Universal selector: handles both landscape (height<=X) and vertical (width<=X, e.g. TikTok/Reels)
    // with /best failsafe so format resolution never errors out on any site.
    video_formats.push(FormatOption {
        format_id: "bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo[width<=1080]+bestaudio/best[width<=1080]/best".to_string(),
        label: "1080p (Full HD)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("1080p".to_string()),
        filesize_approx: None,
    });

    video_formats.push(FormatOption {
        format_id: "bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo[width<=720]+bestaudio/best[width<=720]/best".to_string(),
        label: "720p (HD)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("720p".to_string()),
        filesize_approx: None,
    });

    video_formats.push(FormatOption {
        format_id: "bestvideo+bestaudio/best".to_string(),
        label: "Best Quality (Auto-Mux)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("Max".to_string()),
        filesize_approx: None,
    });

    video_formats.push(FormatOption {
        format_id: "bestvideo[height<=2160]+bestaudio/best[height<=2160]/bestvideo[width<=2160]+bestaudio/best[width<=2160]/best".to_string(),
        label: "4K (2160p Ultra HD)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("2160p".to_string()),
        filesize_approx: None,
    });

    video_formats.push(FormatOption {
        format_id: "bestvideo[height<=1440]+bestaudio/best[height<=1440]/bestvideo[width<=1440]+bestaudio/best[width<=1440]/best".to_string(),
        label: "2K (1440p QHD)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("1440p".to_string()),
        filesize_approx: None,
    });

    video_formats.push(FormatOption {
        format_id: "bestvideo[height<=480]+bestaudio/best[height<=480]/bestvideo[width<=480]+bestaudio/best[width<=480]/best".to_string(),
        label: "480p (Standard)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("480p".to_string()),
        filesize_approx: None,
    });

    video_formats.push(FormatOption {
        format_id: "bestvideo[height<=360]+bestaudio/best[height<=360]/bestvideo[width<=360]+bestaudio/best[width<=360]/best".to_string(),
        label: "360p (Data Saver)".to_string(),
        ext: "mp4".to_string(),
        is_audio_only: false,
        resolution: Some("360p".to_string()),
        filesize_approx: None,
    });

    // -- AUDIO FORMATS (Primary + Dropdown) --
    audio_formats.push(FormatOption {
        format_id: "bestaudio/best".to_string(),
        label: "MP3 (320 kbps)".to_string(),
        ext: "mp3".to_string(),
        is_audio_only: true,
        resolution: None,
        filesize_approx: None,
    });

    audio_formats.push(FormatOption {
        format_id: "bestaudio/best".to_string(),
        label: "M4A (256 kbps AAC)".to_string(),
        ext: "m4a".to_string(),
        is_audio_only: true,
        resolution: None,
        filesize_approx: None,
    });

    audio_formats.push(FormatOption {
        format_id: "bestaudio/best".to_string(),
        label: "FLAC (Lossless)".to_string(),
        ext: "flac".to_string(),
        is_audio_only: true,
        resolution: None,
        filesize_approx: None,
    });

    audio_formats.push(FormatOption {
        format_id: "bestaudio/best".to_string(),
        label: "WAV (Uncompressed)".to_string(),
        ext: "wav".to_string(),
        is_audio_only: true,
        resolution: None,
        filesize_approx: None,
    });

    audio_formats.push(FormatOption {
        format_id: "bestaudio/best".to_string(),
        label: "Opus (160 kbps)".to_string(),
        ext: "opus".to_string(),
        is_audio_only: true,
        resolution: None,
        filesize_approx: None,
    });

    let mut formats = video_formats.clone();
    formats.extend(audio_formats.clone());

    let mut sub_langs: Vec<String> = Vec::new();
    if let Some(subs) = json_val.get("subtitles").and_then(|s| s.as_object()) {
        for k in subs.keys() {
            if !sub_langs.contains(k) {
                sub_langs.push(k.clone());
            }
        }
    }
    if let Some(autos) = json_val.get("automatic_captions").and_then(|s| s.as_object()) {
        for k in autos.keys() {
            if !sub_langs.contains(k) {
                sub_langs.push(k.clone());
            }
        }
    }
    let has_subtitles = !sub_langs.is_empty();

    let chapters = json_val["chapters"].as_array().map(|arr| {
        arr.iter()
            .filter_map(|ch| {
                let start = ch["start_time"].as_f64()?;
                let end = ch["end_time"].as_f64().unwrap_or(start);
                let title = ch["title"].as_str().unwrap_or("Chapter").to_string();
                Some(Chapter {
                    start_time: start,
                    end_time: end,
                    title,
                })
            })
            .collect::<Vec<_>>()
    });

    Ok(VideoInfo {
        id,
        title,
        url,
        thumbnail,
        duration,
        duration_string,
        uploader,
        video_formats,
        audio_formats,
        formats,
        has_subtitles: Some(has_subtitles),
        subtitle_languages: Some(sub_langs),
        chapters,
    })
}

#[tauri::command]
pub async fn get_audio_stream_url(
    url: String,
    cookies_from_browser: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "-f",
        "bestaudio/best",
        "-g",
        "--no-playlist",
        "--force-ipv4",
        "--geo-bypass",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--no-warnings",
        "--extractor-args",
        "youtube:player_client=android,web;skip=dash,translated_subs,comments",
    ]);
    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    cmd.arg(&url);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    // Bug 8: 30s timeout — hung DNS / dead socket would freeze the UI.
    let output = run_command_with_timeout(cmd, 30, "yt-dlp audio stream url")?;
    if output.status.success() {
        let stream_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stream_url.is_empty() {
            return Ok(stream_url);
        }
    }
    Err("Could not retrieve audio stream URL".to_string())
}

#[tauri::command]
pub async fn get_video_stream_url(
    url: String,
    cookies_from_browser: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "-f",
        "best[vcodec!=none][acodec!=none][ext=mp4]/best[vcodec!=none][acodec!=none]/best[ext=mp4]/best",
        "-g",
        "--no-playlist",
        "--force-ipv4",
        "--geo-bypass",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--no-warnings",
        "--extractor-args",
        "youtube:skip=dash,translated_subs,comments",
    ]);
    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    let target_url = sanitize_media_url_for_metadata(&url);
    cmd.arg(&target_url);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    // Bug 8: 30s timeout.
    let output = run_command_with_timeout(cmd, 30, "yt-dlp video stream url")?;
    if output.status.success() {
        let stream_url = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !stream_url.is_empty() {
            return Ok(stream_url);
        }
    }
    Err("Could not retrieve video stream URL".to_string())
}

#[tauri::command]
pub async fn fetch_playlist_info(
    url: String,
    cookies_from_browser: Option<String>,
    app: tauri::AppHandle,
) -> Result<PlaylistInfo, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;

    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "--dump-single-json",
        "--flat-playlist",
        "--yes-playlist",
        "--playlist-end",
        "100",
        "--no-warnings",
        "--force-ipv4",
        "--geo-bypass",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--compat-options",
        "no-youtube-unavailable-videos",
        "--extractor-args",
        "youtube:player_client=android,web;skip=dash,translated_subs,comments",
    ]);
    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    cmd.arg(&url);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    // F-20: 60s timeout — playlists can have 100+ entries to enumerate
    let output = run_command_with_timeout(cmd, 60, "yt-dlp playlist fetch")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.to_string());
    }

    let json_val: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    let id = json_val["id"].as_str().unwrap_or("unknown").to_string();
    let title = json_val["title"]
        .as_str()
        .unwrap_or("Untitled Playlist")
        .to_string();
    let uploader = json_val["uploader"]
        .as_str()
        .or_else(|| json_val["channel"].as_str())
        .unwrap_or("Unknown")
        .to_string();

    let mut entries = Vec::new();
    if let Some(entries_arr) = json_val["entries"].as_array() {
        for entry in entries_arr {
            let entry_id = entry["id"].as_str().unwrap_or("").to_string();
            let entry_title = entry["title"]
                .as_str()
                .unwrap_or("Unknown Title")
                .to_string();
            let entry_url = entry["url"].as_str().unwrap_or("").to_string();

            let final_url = if entry_url.is_empty() && !entry_id.is_empty() {
                format!("https://www.youtube.com/watch?v={}", entry_id)
            } else {
                entry_url
            };

            let thumbnail = entry["thumbnail"]
                .as_str()
                .or_else(|| {
                    entry["thumbnails"]
                        .as_array()
                        .and_then(|arr| arr.last())
                        .and_then(|t| t["url"].as_str())
                })
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    if !entry_id.is_empty() {
                        format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", entry_id)
                    } else {
                        "".to_string()
                    }
                });

            let duration_secs = entry["duration"].as_u64();
            let duration_string = match duration_secs {
                Some(secs) => {
                    let m = secs / 60;
                    let s = secs % 60;
                    format!("{}:{:02}", m, s)
                }
                None => "--:--".to_string(),
            };

            if !entry_id.is_empty() {
                entries.push(PlaylistEntry {
                    id: entry_id,
                    title: entry_title,
                    url: final_url,
                    thumbnail,
                    duration_string,
                });
            }
        }
    }

    Ok(PlaylistInfo {
        id,
        title,
        uploader,
        entries,
    })
}

#[tauri::command]
pub async fn search_youtube(
    query: String,
    cookies_from_browser: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<PlaylistEntry>, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let clean_query = query.trim();
    if clean_query.is_empty() {
        return Ok(Vec::new());
    }
    let search_term = format!("ytsearch5:{}", clean_query);

    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "--dump-single-json",
        "--flat-playlist",
        "--skip-download",
        "--no-warnings",
        "--compat-options",
        "no-youtube-unavailable-videos",
    ]);
    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    cmd.arg(&search_term);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    // F-20: 30s timeout
    let output = run_command_with_timeout(cmd, 30, "YouTube search")?;
    if !output.status.success() {
        return Err("YouTube search failed".to_string());
    }

    let json_val: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse search results: {}", e))?;

    let mut entries = Vec::new();
    if let Some(arr) = json_val["entries"].as_array() {
        for entry in arr {
            let entry_id = entry["id"].as_str().unwrap_or("").to_string();
            let entry_title = entry["title"]
                .as_str()
                .unwrap_or("Untitled Video")
                .to_string();
            let final_url = entry["url"]
                .as_str()
                .map(|u| {
                    if u.starts_with("http") {
                        u.to_string()
                    } else {
                        format!("https://www.youtube.com/watch?v={}", u)
                    }
                })
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", entry_id));

            let thumbnail = entry["thumbnail"]
                .as_str()
                .map(|t| t.to_string())
                .unwrap_or_else(|| {
                    if !entry_id.is_empty() {
                        format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", entry_id)
                    } else {
                        "".to_string()
                    }
                });

            let duration_secs = entry["duration"].as_u64();
            let duration_string = match duration_secs {
                Some(secs) => {
                    let m = secs / 60;
                    let s = secs % 60;
                    format!("{}:{:02}", m, s)
                }
                None => "--:--".to_string(),
            };

            if !entry_id.is_empty() {
                entries.push(PlaylistEntry {
                    id: entry_id,
                    title: entry_title,
                    url: final_url,
                    thumbnail,
                    duration_string,
                });
            }
        }
    }

    Ok(entries)
}
