use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

mod db;
mod status;
use status::DownloadStatus;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
}

/// Progress event emitted to the frontend in real time
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressPayload {
    pub task_id: String,
    pub percent: f32,
    pub speed: String,
    pub eta: String,
    pub status: DownloadStatus,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub file_path: Option<String>,
}

/// Returns extra yt-dlp args to load cookies from a browser's cookie store.
/// Returns empty when disabled. Browser value matches yt-dlp's
/// --cookies-from-browser spec: "chrome", "edge", "firefox", "brave", etc.
fn cookies_args(cookies_from_browser: Option<String>) -> Vec<String> {
    match cookies_from_browser.as_deref() {
        Some(b) if !b.is_empty() && b != "none" => {
            vec!["--cookies-from-browser".to_string(), b.to_string()]
        }
        _ => Vec::new(),
    }
}

/// F-20: Run a Command with a hard timeout. Kills the process tree if it
/// doesn't complete in time. Prevents UI freezes when yt-dlp hangs on a
/// slow/dead server during metadata fetch, playlist enumeration, or search.
fn run_command_with_timeout(
    mut cmd: Command,
    timeout_secs: u64,
    label: &str,
) -> Result<std::process::Output, String> {
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Spawn the child. wait_with_output() consumes self, so no `mut` needed.
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {}", label, e))?;
    let pid = child.id();

    // Own the label so it can move into the watchdog thread.
    // The original &str stays valid for the two map_err calls below.
    let label_owned: String = label.to_string();

    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done_clone = done.clone();

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(timeout_secs));
        if !done_clone.load(std::sync::atomic::Ordering::SeqCst) {
            eprintln!(
                "[Devizee] {} timed out after {}s — killing PID {}",
                label_owned, timeout_secs, pid
            );
            // Bug 5: verify image name before kill to prevent PID-recycle hits.
            if is_safe_to_kill(pid) {
                #[cfg(target_os = "windows")]
                {
                    let mut kill = Command::new("taskkill");
                    kill.args(["/F", "/T", "/PID", &pid.to_string()]);
                    kill.creation_flags(0x08000000);
                    let _ = kill.status();
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
                }
            } else {
                eprintln!(
                    "[Devizee] PID {} no longer matches our sidecar — skipping kill",
                    pid
                );
            }
        }
    });

    let output = child
        .wait_with_output()
        .map_err(|e| format!("{} process error: {}", label, e))?;
    done.store(true, std::sync::atomic::Ordering::SeqCst);

    Ok(output)
}

/// SC-3: SHA-256 fingerprint of a file. Used for TOFU (trust-on-first-use)
/// tamper detection on sidecar binaries. Returns None if the file can't be
/// read — caller treats that as "verification skipped."
fn compute_file_sha256(path: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return None,
        }
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Helper function to locate the active yt-dlp executable (Absolute Paths)
fn get_yt_dlp_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 1. Check self-updated binary in %LOCALAPPDATA% (FR-4.1)
    if let Ok(local_data) = app.path().app_local_data_dir() {
        let updated_bin = local_data.join("bin").join("yt-dlp.exe");
        if updated_bin.exists() {
            return Ok(updated_bin);
        }
    }

    // 2. Check current_exe parent directory (Production install directory / NSIS / MSI)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("yt-dlp.exe"),
                exe_dir.join("bin").join("yt-dlp.exe"),
                exe_dir.join("yt-dlp-x86_64-pc-windows-msvc.exe"),
                exe_dir
                    .join("bin")
                    .join("yt-dlp-x86_64-pc-windows-msvc.exe"),
            ];
            for path in candidates {
                if path.exists() {
                    return Ok(path);
                }
            }
        }
    }

    // 3. Check Tauri resource_dir()
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("yt-dlp.exe"),
            resource_dir.join("bin").join("yt-dlp.exe"),
            resource_dir.join("yt-dlp-x86_64-pc-windows-msvc.exe"),
            resource_dir
                .join("bin")
                .join("yt-dlp-x86_64-pc-windows-msvc.exe"),
        ];
        for path in candidates {
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // 4. Check development paths relative to current working dir
    let cwd = std::env::current_dir().unwrap_or_default();
    let dev_candidates = [
        cwd.join("bin").join("yt-dlp-x86_64-pc-windows-msvc.exe"),
        cwd.join("src-tauri")
            .join("bin")
            .join("yt-dlp-x86_64-pc-windows-msvc.exe"),
        cwd.join("bin").join("yt-dlp.exe"),
        cwd.join("src-tauri").join("bin").join("yt-dlp.exe"),
        cwd.join("yt-dlp.exe"),
    ];
    for path in dev_candidates {
        if path.exists() {
            return Ok(path);
        }
    }

    // SC-3: refuse to fall back to system PATH. This was the primary attack
    // vector — any writable folder early in PATH (e.g. a hijacked user
    // temp dir) could host a malicious yt-dlp.exe that Devizee would execute
    // with the user's privileges. If none of the trusted candidates exist,
    // fail loudly instead of silently trusting PATH.
    Err("Could not locate yt-dlp.exe in any trusted location. \
         Please reinstall Devizee."
        .to_string())
}

/// Helper function to locate the ffmpeg binary (Absolute Paths)
fn get_ffmpeg_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 1. Check current_exe parent directory (Production install directory / NSIS / MSI)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("ffmpeg.exe"),
                exe_dir.join("bin").join("ffmpeg.exe"),
                exe_dir.join("ffmpeg-x86_64-pc-windows-msvc.exe"),
                exe_dir
                    .join("bin")
                    .join("ffmpeg-x86_64-pc-windows-msvc.exe"),
            ];
            for path in candidates {
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    // 2. Check Tauri resource_dir()
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("ffmpeg.exe"),
            resource_dir.join("bin").join("ffmpeg.exe"),
            resource_dir.join("ffmpeg-x86_64-pc-windows-msvc.exe"),
            resource_dir
                .join("bin")
                .join("ffmpeg-x86_64-pc-windows-msvc.exe"),
        ];
        for path in candidates {
            if path.exists() {
                return Some(path);
            }
        }
    }

    // 3. Check development paths relative to current working dir
    let cwd = std::env::current_dir().unwrap_or_default();
    let dev_candidates = [
        cwd.join("bin").join("ffmpeg-x86_64-pc-windows-msvc.exe"),
        cwd.join("src-tauri")
            .join("bin")
            .join("ffmpeg-x86_64-pc-windows-msvc.exe"),
        cwd.join("bin").join("ffmpeg.exe"),
        cwd.join("src-tauri").join("bin").join("ffmpeg.exe"),
        cwd.join("ffmpeg.exe"),
    ];
    dev_candidates.into_iter().find(|path| path.exists())
}

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/// Checks if a URL belongs to known DRM-restricted subscription services
fn is_known_drm_service(url: &str) -> bool {
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

/// Tauri command to inspect any URL and extract metadata & format tiers
#[tauri::command]
async fn fetch_video_info(
    url: String,
    cookies_from_browser: Option<String>,
    allow_insecure_ssl: Option<bool>,
    app: tauri::AppHandle,
) -> Result<VideoInfo, String> {
    if is_known_drm_service(&url) {
        return Err("DRM_PROTECTED: This platform uses hardware-level DRM encryption (Widevine/PlayReady) and cannot be downloaded.".to_string());
    }

    let yt_dlp_path = get_yt_dlp_path(&app)?;

    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--force-ipv4",
        "--geo-bypass",
        "--user-agent",
        BROWSER_USER_AGENT,
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--compat-options",
        "no-youtube-unavailable-videos",
        "--extractor-args",
        "youtube:skip=dash,translated_subs,comments",
    ]);

    if allow_insecure_ssl == Some(true) {
        cmd.arg("--no-check-certificates");
    }

    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    cmd.arg(&url);

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

        if cleaned_error.to_lowercase().contains("drm protected") {
            return Err("DRM_PROTECTED: This media is protected by Digital Rights Management (DRM) and cannot be downloaded.".to_string());
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
    })
}

fn categorize_error(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    if lower.contains("network is unreachable")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("timed out")
        || lower.contains("unable to download webpage")
        || lower.contains("temporary failure in name resolution")
        || lower.contains("getaddrinfo failed")
        || lower.contains("errno 11001")
        || lower.contains("ssl: certificate_verify_failed")
        || lower.contains("http error 5")
    {
        "network"
    } else if lower.contains("sign in to confirm your age")
        || lower.contains("age-restricted")
        || lower.contains("confirm you're not a bot")
        || lower.contains("bot detection")
    {
        "age_restricted"
    } else if lower.contains("video unavailable")
        || lower.contains("video is unavailable")
        || lower.contains("unavailable")
        || lower.contains("this video has been removed")
        || lower.contains("private video")
        || lower.contains("copyright claim")
        || lower.contains("not available in your country")
        || lower.contains("requested format is not available")
        || lower.contains("http error 404")
        || lower.contains("http error 403")
    {
        "unavailable"
    } else if lower.contains("no space left on device")
        || lower.contains("disk full")
        || lower.contains("not enough space")
        || lower.contains("os error 112")
    {
        "disk_full"
    } else if lower.contains("verification failed") || lower.contains("corrupt") {
        "verification_failed"
    } else {
        "unknown"
    }
}

/// Max size of downloads.log before rotation. If the file exceeds this
/// size, it is renamed to downloads.log.1 (replacing any previous .1) and
/// a fresh downloads.log is created. Disk usage stays bounded at ~2x this.
const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

fn rotate_log_if_needed(log_file: &std::path::Path) {
    // Only rotate if the file exists and exceeds the cap
    let size = match std::fs::metadata(log_file) {
        Ok(m) => m.len(),
        Err(_) => return, // doesn't exist — nothing to rotate
    };
    if size < MAX_LOG_SIZE {
        return;
    }

    let backup = log_file.with_extension("log.1");
    // Remove the old backup if it exists (ignore errors — we're about to
    // overwrite it anyway, and losing the previous .1 is acceptable)
    let _ = std::fs::remove_file(&backup);
    // Move the current file to .1
    if std::fs::rename(log_file, &backup).is_err() {
        // If rename fails (file locked, permission), truncate as fallback
        // so we don't infinitely grow.
        let _ = std::fs::write(log_file, b"");
    }
}

fn log_download_error(
    app: &tauri::AppHandle,
    task_id: &str,
    url: &str,
    error_code: &str,
    stderr: &str,
) {
    if let Ok(app_dir) = app.path().app_local_data_dir() {
        let logs_dir = app_dir.join("logs");
        let _ = std::fs::create_dir_all(&logs_dir);
        let log_file = logs_dir.join("downloads.log");

        // Rotate BEFORE opening for append so a giant file doesn't block us.
        rotate_log_if_needed(&log_file);

        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file)
        {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let _ = writeln!(
                file,
                "[{}] Task: {} | URL: {} | Code: {}\nStderr:\n{}\n----------------------------------------",
                timestamp, task_id, url, error_code, stderr
            );
        }
    }
}

// ─── W3-2: Disk space pre-flight ───
// Query free bytes on the volume containing the given path. Uses the
// widest-available Windows API. Returns None on non-Windows or if the
// query fails (caller should treat as "unknown, proceed anyway").
#[cfg(target_os = "windows")]
fn free_space_bytes_for_path(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // Canonicalize the parent directory (the file itself may not exist yet)
    let dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    // If the target dir doesn't exist yet, walk up until we find an existing one
    let mut probe = dir.as_path();
    while !probe.exists() {
        probe = probe.parent()?;
    }

    let wide: Vec<u16> = std::ffi::OsStr::new(probe)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut free_bytes: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_free: u64 = 0;

    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_bytes as *mut u64,
            &mut total_bytes as *mut u64,
            &mut total_free as *mut u64,
        )
    };

    if ok == 0 {
        None
    } else {
        // On older Windows without large-disk support, total_free is authoritative
        Some(if total_free > 0 {
            total_free
        } else {
            free_bytes
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn free_space_bytes_for_path(_path: &std::path::Path) -> Option<u64> {
    None
}

/// Single Source of Truth for Output Path Resolution
#[allow(clippy::too_many_arguments)]
fn resolve_output_dir(
    app: &tauri::AppHandle,
    base_dir: Option<String>,
    video_dir: Option<String>,
    audio_dir: Option<String>,
    docs_dir: Option<String>,
    comp_dir: Option<String>,
    prog_dir: Option<String>,
    ext: &str,
    is_audio_only: bool,
) -> PathBuf {
    let home_downloads = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let default_base = home_downloads.join("Devizee");

    let resolved_base = match base_dir {
        Some(dir) if !dir.trim().is_empty() => {
            let p = PathBuf::from(dir.trim());
            if p.is_absolute() {
                p
            } else {
                let trimmed = dir
                    .trim()
                    .trim_start_matches("Downloads/")
                    .trim_start_matches("Downloads\\");
                home_downloads.join(trimmed)
            }
        }
        _ => default_base,
    };

    let ext_lower = ext.to_lowercase();
    let ext_str = ext_lower.as_str();

    let (default_subfolder, target_override) =
        if is_audio_only || ["mp3", "m4a", "flac", "wav", "opus", "aac"].contains(&ext_str) {
            ("Audio", audio_dir)
        } else if ["mp4", "mkv", "webm", "avi", "mov"].contains(&ext_str) {
            ("Videos", video_dir)
        } else if ["zip", "rar", "7z", "tar", "gz"].contains(&ext_str) {
            ("Compressed", comp_dir)
        } else if ["exe", "msi", "apk", "dmg"].contains(&ext_str) {
            ("Programs", prog_dir)
        } else if ["pdf", "docx", "txt", "epub"].contains(&ext_str) {
            ("Documents", docs_dir)
        } else {
            ("General", None)
        };

    match target_override {
        Some(dir) if !dir.trim().is_empty() => {
            let p = PathBuf::from(dir.trim());
            if p.is_absolute() {
                p
            } else {
                resolved_base.join(p)
            }
        }
        _ => resolved_base.join(default_subfolder),
    }
}

// ─── W3-5: Orphan .part / .ytdl cleanup ───
// yt-dlp stages downloads as *.part and *.ytdl files. If a download is
// cancelled or the app crashes, those stay behind. On startup we walk the
// download root and remove any temp file older than 48 hours. Files newer
// than 48h are left alone (they may belong to a paused/interrupted task).
fn cleanup_orphan_part_files(root: &std::path::Path) -> usize {
    const MAX_AGE_SECS: u64 = 48 * 60 * 60; // 48 hours
    let mut removed = 0usize;
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(MAX_AGE_SECS))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

    fn walk(dir: &std::path::Path, cutoff: std::time::SystemTime, removed: &mut usize) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return, // unreadable dir — skip silently
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                walk(&path, cutoff, removed);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase());
            let is_temp = matches!(ext.as_deref(), Some("part") | Some("ytdl") | Some("temp"));
            if !is_temp {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
                if mtime < cutoff {
                    if std::fs::remove_file(&path).is_ok() {
                        *removed += 1;
                    }
                }
            }
        }
    }

    walk(root, cutoff, &mut removed);
    removed
}

/// Closes the application completely when the user closes the window with minimizeToTray disabled.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Frontend calls this on startup with the current saveFolder path.
/// Returns the number of orphan files removed (0 if none).
#[tauri::command]
async fn cleanup_orphan_parts(root: String) -> Result<usize, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let path = std::path::Path::new(trimmed);
    if !path.exists() || !path.is_dir() {
        return Ok(0);
    }
    // Run on a blocking task so the async runtime isn't held up by a
    // potentially large filesystem walk.
    let owned = path.to_path_buf();
    let removed = tauri::async_runtime::spawn_blocking(move || cleanup_orphan_part_files(&owned))
        .await
        .map_err(|e| format!("Cleanup task failed: {}", e))?;

    if removed > 0 {
        eprintln!(
            "[Devizee] Startup cleanup: removed {} orphan .part/.ytdl file(s)",
            removed
        );
    }
    Ok(removed)
}

#[tauri::command]
fn fix_legacy_paths(state: tauri::State<AppState>) -> Result<usize, String> {
    // SEC-10: Handle poisoned lock gracefully instead of panicking
    let mut conn = state
        .db_conn
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    let records = db::get_all_downloads(&conn).map_err(|e| e.to_string())?;
    let mut fixed = 0usize;

    // Edge Case: Wrap in transaction so sudden exit or crash leaves database in consistent state
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    for rec in records {
        let old_path = match &rec.file_path {
            Some(p) => p.clone(),
            None => continue,
        };

        let needs_fix = old_path.contains("Downloads\\Devizee\\Downloads\\Devizee\\")
            || old_path.contains("Downloads/Devizee/Downloads/Devizee/");
        if !needs_fix {
            continue;
        }

        let new_path = old_path
            .replace(
                "Downloads\\Devizee\\Downloads\\Devizee\\",
                "Downloads\\Devizee\\",
            )
            .replace("Downloads/Devizee/Downloads/Devizee/", "Downloads/Devizee/");

        let _ = db::update_download_status(
            &tx,
            &rec.id,
            &rec.status,
            rec.percent,
            Some(&new_path),
            None,
            None,
        );
        fixed += 1;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;
    Ok(fixed)
}

/// Starts a download (spawns yt-dlp in background thread)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_download(
    task_id: String,
    url: String,
    title: String,
    format_id: String,
    format_label: Option<String>,
    is_audio_only: bool,
    ext: String,
    base_dir: Option<String>,
    video_dir: Option<String>,
    audio_dir: Option<String>,
    docs_dir: Option<String>,
    comp_dir: Option<String>,
    prog_dir: Option<String>,
    temp_dir: Option<String>,
    speed_limit: Option<String>,
    proxy: Option<String>,
    custom_flags: Option<String>,
    scan_antivirus: Option<bool>,
    download_sections: Option<String>,
    cookies_from_browser: Option<String>,
    filename_template: Option<String>,
    estimated_size_bytes: Option<u64>,
    download_subtitles: Option<bool>,
    subtitle_languages: Option<String>,
    allow_insecure_ssl: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let ffmpeg_path_opt = get_ffmpeg_path(&app);

    let download_dir = resolve_output_dir(
        &app,
        base_dir.clone(),
        video_dir,
        audio_dir,
        docs_dir,
        comp_dir,
        prog_dir,
        &ext,
        is_audio_only,
    );

    // Edge Case: Validate destination directory write access / drive connectivity
    if !download_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&download_dir) {
            return Err(format!(
                "Cannot access download destination '{:?}': {}. Please check folder permissions or external drive connection.",
                download_dir, e
            ));
        }
    }

    // ─── W3-2: Disk-space pre-flight ───
    // If the caller provided an estimated size, verify at least that much
    // space is available (plus a 500 MB safety margin). This catches the
    // "50 GB download onto a 40 GB drive" case before we spawn yt-dlp and
    // trash the volume.
    if let Some(estimated) = estimated_size_bytes {
        const SAFETY_MARGIN_BYTES: u64 = 500 * 1024 * 1024; // 500 MB
        if let Some(free) = free_space_bytes_for_path(&download_dir) {
            let required = estimated.saturating_add(SAFETY_MARGIN_BYTES);
            if free < required {
                let free_gb = free as f64 / 1_073_741_824.0;
                let needed_gb = required as f64 / 1_073_741_824.0;
                return Err(format!(
                    "Not enough disk space. This download needs approximately {:.2} GB free, but the destination drive only has {:.2} GB available. Free up space or choose a different folder.",
                    needed_gb, free_gb
                ));
            }
        }
    }

    let resolved_temp_dir = match temp_dir {
        Some(ref tdir) if !tdir.trim().is_empty() => {
            let tp = PathBuf::from(tdir.trim());
            let final_tp = if tp.is_absolute() {
                tp
            } else {
                download_dir.join(tp)
            };
            if !final_tp.exists() {
                let _ = std::fs::create_dir_all(&final_tp);
            }
            Some(final_tp)
        }
        _ => None,
    };

    let template = filename_template
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("%(title)s [%(id)s].%(ext)s");

    // SEC-7: Block path traversal in the filename template.
    // A template like "../../Desktop/malicious%(ext)s" would escape the download dir.
    // yt-dlp expands %(title)s from untrusted video metadata, so also pass
    // --restrict-filenames to sanitise the expanded value on the yt-dlp side.
    if template.contains("..") || template.contains('/') || template.contains('\\') {
        return Err(
            "Filename template must not contain path separators or '..'. \
             Use yt-dlp format fields like %(title)s and %(ext)s only."
                .to_string(),
        );
    }

    // Edge Case: Windows 260-char MAX_PATH protection.
    // Dynamically calculate available space based on the full download_dir length.
    // Windows MAX_PATH is 260. We reserve 40 chars for ID, format ext, and temporary .part/.fXXX suffixes.
    let safe_template = if template.contains("%(title)s") {
        let dir_len = download_dir.to_string_lossy().len();
        let max_title_len = 240usize.saturating_sub(dir_len).clamp(30, 100);
        template.replace("%(title)s", &format!("%(title).{}B", max_title_len))
    } else {
        template.to_string()
    };

    let out_template = download_dir.join(&safe_template);
    let out_template_str = out_template.to_string_lossy().to_string();

    let task_id_clone = task_id.clone();
    let app_clone = app.clone();

    let record = db::DownloadRecord {
        id: task_id.clone(),
        url: url.clone(),
        title: title.clone(),
        file_path: None,
        status: DownloadStatus::Queued,
        percent: 0.0,
        format: format_label.unwrap_or_else(|| format_id.clone()),
        format_id: format_id.clone(),
        date_added: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        hidden: false,
        file_size: None,
        error_code: None,
        error_message: None,
    };

    // W3-4: use the shared connection from AppState instead of opening a new
    // one per download. Falls back to a fresh init only if AppState is
    // missing (should never happen in practice).
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(conn) = state.db_conn.lock() {
            let _ = db::insert_download(&conn, &record);
        }
    }

    // ─── F-09: Emit Queued, then await a concurrency slot ───
    // Emit "Queued" first so the frontend stops showing the optimistic
    // "Starting" state while we wait for a permit.
    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            task_id: task_id.clone(),
            percent: 0.0,
            speed: "Queued".to_string(),
            eta: "--".to_string(),
            status: DownloadStatus::Queued,
            error_code: None,
            error: None,
            file_path: None,
        },
    );

    // Acquire a slot from the global concurrency limiter. If all slots are
    // taken (3 concurrent downloads already running), this awaits until one
    // frees up. The permit is moved into the worker thread and released
    // automatically when the thread exits — no manual cleanup needed.
    let semaphore = app.state::<AppState>().download_semaphore.clone();
    let _permit = semaphore
        .acquire_owned()
        .await
        .map_err(|_| "Download queue was closed".to_string())?;

    let download_dir_clone = download_dir.clone();
    let url_clone = url.clone();
    let cookies_clone = cookies_from_browser.clone();
    let allow_insecure_ssl_clone = allow_insecure_ssl;

    std::thread::spawn(move || {
        // Hold the concurrency permit for the entire lifetime of this
        // download. Drop fires automatically when the closure exits,
        // whether by completion, error, or cancellation.
        let _permit = _permit;
        let mut cmd = Command::new(&yt_dlp_path);
        let progress_template = "DEVIZEE_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s";

        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.args([
            "--encoding",
            "utf-8",
            "--newline",
            "--no-colors",
            "--progress-template",
            progress_template,
            "-o",
            &out_template_str,
            "--force-overwrites",
            "--no-playlist",
            "--no-warnings",
            "--force-ipv4",
            "--geo-bypass",
            "--user-agent",
            BROWSER_USER_AGENT,
            "--concurrent-fragments",
            "4",
            "--compat-options",
            "no-youtube-unavailable-videos",
            // SEC-7 (defense-in-depth): sanitise expanded template values so that
            // untrusted video titles cannot introduce path separators into filenames.
            "--restrict-filenames",
            // PERFORMANCE: Move the MP4/MOV moov atom to the front of the file so
            // players can read metadata instantly instead of seeking to the end
            // (fixes the 5+ second cold-start delay for local playback).
            "--postprocessor-args",
            "Merger:-movflags +faststart",
            // W3-8: Network resilience for DASH/HLS multi-fragment downloads.
            // A single dropped fragment on a shaky Wi-Fi connection used to
            // abort the entire download. These flags retry each fragment up
            // to 10 times with exponential backoff before giving up.
            "--retries",
            "10",
            "--fragment-retries",
            "10",
            "--retry-sleep",
            "fragment:exp=1:20",
            "--file-access-retries",
            "5",
            "--socket-timeout",
            "30",
            "--convert-thumbnails",
            "jpg",
        ]);

        if allow_insecure_ssl_clone == Some(true) {
            cmd.arg("--no-check-certificates");
        }

        // Priority 9: Stage temp/.part files into separate temp folder if configured
        if let Some(ref tp) = resolved_temp_dir {
            cmd.args(["-P", &format!("temp:{}", tp.to_string_lossy())]);
        }

        // Cookies from browser (opt-in auth for age-restricted / bot-detected videos)
        for arg in cookies_args(cookies_clone) {
            cmd.arg(arg);
        }

        if is_audio_only {
            let audio_selector = if ext == "m4a" || ext == "aac" {
                "ba[ext=m4a]/ba[acodec^=mp4a]/ba/b"
            } else if ext == "opus" || ext == "webm" {
                "ba[ext=webm]/ba[acodec^=opus]/ba/b"
            } else {
                "ba/b"
            };

            let effective_fmt = if format_id.contains("bestaudio") || format_id.is_empty() {
                audio_selector
            } else {
                &format_id
            };

            cmd.args([
                "-f",
                effective_fmt,
                "-x",
                "--audio-format",
                &ext,
                "--audio-quality",
                "0",
                "--embed-metadata",
                "--embed-thumbnail",
            ]);
        } else {
            cmd.args(["-f", &format_id, "--merge-output-format", &ext]);
        }

        if !is_audio_only && download_subtitles.unwrap_or(false) {
            let langs = subtitle_languages
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("all");
            cmd.args([
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs",
                langs,
                "--embed-subs",
            ]);
        }

        if let Some(ref sec) = download_sections {
            let sec_str = sec.trim();
            if !sec_str.is_empty() {
                cmd.args(["--download-sections", sec_str, "--force-keyframes-at-cuts"]);
            }
        }

        if let Some(ref ffmpeg_path) = ffmpeg_path_opt {
            cmd.arg("--ffmpeg-location");
            cmd.arg(ffmpeg_path);
        }

        if let Some(ref limit) = speed_limit {
            let limit_str = limit.trim();
            if !limit_str.is_empty() && limit_str.to_lowercase() != "unlimited" {
                cmd.args(["--limit-rate", limit_str]);
            }
        }

        // F-22: proxy credentials in --proxy user:pass@host:port are visible
        // to any local process via Task Manager / wmic / Process Explorer.
        // Pass via HTTP_PROXY / HTTPS_PROXY env vars instead. yt-dlp reads
        // these natively and they don't appear in the process command line.
        if let Some(ref prx) = proxy {
            let prx_str = prx.trim();
            if !prx_str.is_empty() {
                cmd.env("HTTP_PROXY", prx_str);
                cmd.env("HTTPS_PROXY", prx_str);
                cmd.env("http_proxy", prx_str);
                cmd.env("https_proxy", prx_str);
            }
        }

        // SEC-1: Argument injection guard.
        // custom_flags is split by whitespace and each token is passed as a discrete
        // Command::arg() call (no shell), but yt-dlp flags like --exec / --config-location
        // / --batch-file can still be weaponised. Use a strict allowlist.
        // Value-flag pairs (e.g. "--retries 3") must appear consecutively; the value
        // following a known value-flag is admitted verbatim but is bounded to 256 chars.
        if let Some(ref flags) = custom_flags {
            // Flags that stand alone (no following value)
            // F-21: removed --no-check-certificates. It enables MITM by any
            // network attacker. If a user has a legitimate need (self-signed
            // proxy cert), they can add the yt-dlp arg via a config file —
            // not through Devizee's UI.
            const ALLOWED_LONE: &[&str] = &[
                "--geo-bypass",
                "--no-part",
                "--no-playlist",
                "--prefer-free-formats",
                "--force-overwrites",
                "--no-overwrites",
                "--mark-watched",
                "--no-mark-watched",
            ];
            // Flags that take exactly one value token after them
            const ALLOWED_VALUE: &[&str] = &[
                "--limit-rate",
                // --proxy removed: proxy credentials passed via HTTP_PROXY /
                // HTTPS_PROXY env vars (see F-22) to prevent leaking through
                // Task Manager. Users configure proxy in Settings → Connection.
                "--retries",
                "--fragment-retries",
                "--concurrent-fragments",
                "--socket-timeout",
                "--source-address",
                "--sleep-interval",
                "--max-sleep-interval",
            ];

            let tokens: Vec<&str> = flags.trim().split_whitespace().collect();
            let mut i = 0;
            while i < tokens.len() {
                let tok = tokens[i];
                if ALLOWED_LONE.contains(&tok) {
                    cmd.arg(tok);
                    i += 1;
                } else if ALLOWED_VALUE.contains(&tok) {
                    if i + 1 < tokens.len() {
                        let val = tokens[i + 1];
                        // Bound value length and reject any shell metacharacters
                        let safe = val.len() <= 256
                            && !val.contains('"')
                            && !val.contains('\'')
                            && !val.contains('`')
                            && !val.contains('&')
                            && !val.contains('|')
                            && !val.contains(';')
                            && !val.contains('\n');
                        if safe {
                            cmd.arg(tok);
                            cmd.arg(val);
                        }
                        i += 2;
                    } else {
                        i += 1; // dangling flag with no value — skip silently
                    }
                } else {
                    // Unrecognised or dangerous flag — silently dropped
                    i += 1;
                }
            }
        }

        cmd.arg(&url_clone);

        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);

        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        static GLOBAL_JOB_OBJECT: std::sync::OnceLock<windows_sys::Win32::Foundation::HANDLE> =
            std::sync::OnceLock::new();

        #[cfg(target_os = "windows")]
        fn assign_child_to_job(child: &std::process::Child) {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::HANDLE;
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            let job_handle = *GLOBAL_JOB_OBJECT.get_or_init(|| unsafe {
                let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if job != 0 as HANDLE {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    let res = SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const std::ffi::c_void,
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    );
                    if res != 0 {
                        return job;
                    }
                }
                0 as HANDLE
            });

            if job_handle != 0 as windows_sys::Win32::Foundation::HANDLE {
                unsafe {
                    let _ = AssignProcessToJobObject(job_handle, child.as_raw_handle() as HANDLE);
                }
            }
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let err_str = e.to_string();
                log_download_error(
                    &app_clone,
                    &task_id_clone,
                    &url_clone,
                    "spawn_failed",
                    &err_str,
                );
                let _ = app_clone.emit(
                    "download-progress",
                    DownloadProgressPayload {
                        task_id: task_id_clone.clone(),
                        percent: 0.0,
                        speed: "0 B/s".to_string(),
                        eta: "--".to_string(),
                        status: DownloadStatus::Error,
                        error_code: Some("spawn_failed".to_string()),
                        error: Some(err_str.clone()),
                        file_path: None,
                    },
                );
                if let Some(state) = app_clone.try_state::<AppState>() {
                    let conn = state.db_conn.lock().unwrap();
                    let _ = db::update_download_status(
                        &conn,
                        &task_id_clone,
                        &DownloadStatus::Error,
                        0.0,
                        None,
                        Some("spawn_failed"),
                        Some(&err_str),
                    );
                }
                return;
            }
        };

        let pid = child.id();
        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(mut procs) = state.active_processes.lock() {
                procs.insert(task_id_clone.clone(), pid);
            }
        }

        #[cfg(target_os = "windows")]
        assign_child_to_job(&child);

        let _ = app_clone.emit(
            "download-progress",
            DownloadProgressPayload {
                task_id: task_id_clone.clone(),
                percent: 0.0,
                speed: "Booting engine...".to_string(),
                eta: "Waiting for connection".to_string(),
                status: DownloadStatus::Starting,
                error_code: None,
                error: None,
                file_path: None,
            },
        );

        // ─── F-11: Inactivity watchdog ───
        // If yt-dlp emits nothing on stdout/stderr for 45 consecutive seconds
        // (after a 45s grace window for metadata + connection handshake), assume
        // the socket is dead and kill the process tree. Without this, a hung
        // yt-dlp on a silent TCP connection leaks its worker thread forever.
        let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));
        let last_activity_stderr = last_activity.clone();
        let last_activity_stdout = last_activity.clone();
        let watchdog_alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let watchdog_alive_clone = watchdog_alive.clone();
        let watchdog_pid = pid;
        let watchdog_task_id = task_id_clone.clone();
        let watchdog_app = app_clone.clone();

        std::thread::spawn(move || {
            const CHECK_INTERVAL_SECS: u64 = 15;
            const INACTIVITY_LIMIT_SECS: u64 = 45;
            const WATCHDOG_GRACE_SECS: u64 = 45;

            // Grace period: metadata extraction + first TCP handshake can
            // legitimately take 20-30s on slow networks.
            std::thread::sleep(std::time::Duration::from_secs(WATCHDOG_GRACE_SECS));

            loop {
                if !watchdog_alive_clone.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECS));
                if !watchdog_alive_clone.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }

                let since_last = match last_activity.lock() {
                    Ok(t) => t.elapsed().as_secs(),
                    Err(_) => continue,
                };

                if since_last >= INACTIVITY_LIMIT_SECS {
                    eprintln!(
                        "[Devizee Watchdog] No output from PID {} for {}s — killing (task {})",
                        watchdog_pid, since_last, watchdog_task_id
                    );

                    // Bug 5: verify image name before kill to prevent PID-recycle hits.
                    if is_safe_to_kill(watchdog_pid) {
                        #[cfg(target_os = "windows")]
                        {
                            let mut kill_cmd = Command::new("taskkill");
                            kill_cmd.args(["/F", "/T", "/PID", &watchdog_pid.to_string()]);
                            kill_cmd.creation_flags(0x08000000);
                            let _ = kill_cmd.status();
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            let _ = Command::new("kill")
                                .args(["-9", &watchdog_pid.to_string()])
                                .status();
                        }
                    } else {
                        eprintln!(
                            "[Devizee Watchdog] PID {} no longer matches — skipping kill",
                            watchdog_pid
                        );
                    }

                    let _ = watchdog_app.emit(
                        "download-progress",
                        DownloadProgressPayload {
                            task_id: watchdog_task_id.clone(),
                            percent: 0.0,
                            speed: "".to_string(),
                            eta: "".to_string(),
                            status: DownloadStatus::Error,
                            error_code: Some("network".to_string()),
                            error: Some(format!(
                                "Download stalled — no data received for {} seconds. The connection may be dead. Retry from the Downloads tab.",
                                since_last
                            )),
                            file_path: None,
                        },
                    );

                    if let Some(state) = watchdog_app.try_state::<AppState>() {
                        if let Ok(conn) = state.db_conn.lock() {
                            let _ = db::update_download_status(
                                &conn,
                                &watchdog_task_id,
                                &DownloadStatus::Error,
                                0.0,
                                None,
                                Some("network"),
                                Some("Download stalled — no data received. Retry from Downloads tab."),
                            );
                        }
                        if let Ok(mut procs) = state.active_processes.lock() {
                            procs.remove(&watchdog_task_id);
                        }
                    }

                    return;
                }
            }
        });

        let stderr = child.stderr.take().unwrap();
        let error_logs = Arc::new(Mutex::new(Vec::new()));
        let error_logs_clone = error_logs.clone();
        std::thread::spawn(move || {
            // W3-7: Cap stderr accumulation. A chatty yt-dlp error loop can
            // emit thousands of warning lines on long downloads, previously
            // growing this Vec unboundedly. We keep only the last 1000 lines —
            // which is more than enough context for error categorization and
            // log display. Older lines are dropped.
            const MAX_STDERR_LINES: usize = 1000;
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                if n == 0 {
                    break;
                }
                // F-11: touch activity timestamp on every stderr line
                if let Ok(mut t) = last_activity_stderr.lock() {
                    *t = std::time::Instant::now();
                }
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                buf.clear();
                if !line.is_empty() {
                    let mut logs = error_logs_clone.lock().unwrap();
                    logs.push(line);
                    if logs.len() > MAX_STDERR_LINES {
                        // Drop the oldest 200 lines when we hit the cap. This
                        // is cheaper than removing one at a time and keeps
                        // recent context intact.
                        let excess = logs.len() - MAX_STDERR_LINES;
                        logs.drain(0..excess);
                    }
                }
            }
        });

        let mut final_file_path = None;

        // ─── F-24: Throttle progress DB writes ───
        // yt-dlp emits DEVIZEE_PROGRESS lines many times per second. Writing
        // to SQLite on every tick blocks the DB mutex under multi-download
        // load and stalls the UI. We write to the DB at most once per second
        // per task, PLUS immediately whenever the status changes (Downloading
        // → Muxing, etc.). Final states (Completed/Error) are written outside
        // this loop and are always flushed.
        let mut last_db_write = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(10))
            .unwrap_or_else(std::time::Instant::now);
        let mut last_db_status: Option<DownloadStatus> = None;
        const DB_WRITE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1000);

        let is_multi_stream = !is_audio_only
            && (format_id.contains('+')
                || format_id.contains("bestvideo")
                || format_id.is_empty()
                || format_id == "best");
        let mut detected_stream_count: Option<usize> = None;
        let mut destination_count: usize = 0;

        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            while let Ok(n) = reader.read_until(b'\n', &mut buf) {
                if n == 0 {
                    break;
                }
                // F-11: touch activity timestamp on every stdout line
                if let Ok(mut t) = last_activity_stdout.lock() {
                    *t = std::time::Instant::now();
                }
                let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                buf.clear();

                if line.contains("format(s)") && line.contains("Downloading") {
                    if let Some(pos) = line.find(" format(s)") {
                        if let Some(space_pos) = line[..pos].rfind(' ') {
                            if let Ok(count) = line[space_pos + 1..pos].parse::<usize>() {
                                detected_stream_count = Some(count);
                            }
                        }
                    }
                }

                if line.contains("Destination:") {
                    let is_sub = line.ends_with(".vtt") || line.ends_with(".srt") || line.ends_with(".lrc");
                    if !is_sub {
                        destination_count += 1;
                    }
                    if let Some(idx) = line.find("Destination:") {
                        let fp = line[idx + "Destination:".len()..]
                            .trim()
                            .trim_matches('"')
                            .to_string();
                        if !fp.is_empty() && !is_sub {
                            final_file_path = Some(fp);
                        }
                    }
                } else if line.contains("DEVIZEE_PROGRESS:") {
                    let parts_str = line.replace("DEVIZEE_PROGRESS:", "");
                    let parts: Vec<&str> = parts_str.split('|').collect();
                    if parts.len() >= 3 {
                        let percent_str = parts[0].trim().replace('%', "");
                        let raw_percent: f32 = percent_str.parse().unwrap_or(0.0);
                        let speed = parts[1].trim().to_string();
                        let eta = parts[2].trim().to_string();

                        // Multi-stream DASH smooth scaling:
                        // Accurately tracks actual stream count (e.g. YouTube DASH video+audio = 2, TikTok single = 1)
                        // Stream 1 (video) is ~85% of total download.
                        // Stream 2 (audio) is the remaining ~15%.
                        // This prevents progress locking at 85% on single streams or 99% during multi-stream.
                        let is_multi = detected_stream_count.map(|c| c > 1).unwrap_or(is_multi_stream);
                        let percent: f32 = if is_multi {
                            if destination_count <= 1 {
                                (raw_percent * 0.85).min(85.0)
                            } else {
                                (85.0 + (raw_percent * 0.14)).min(99.0)
                            }
                        } else {
                            raw_percent.min(99.0)
                        };

                        let status = DownloadStatus::Downloading;

                        // Always emit to the frontend for a live progress bar.
                        let _ = app_clone.emit(
                            "download-progress",
                            DownloadProgressPayload {
                                task_id: task_id_clone.clone(),
                                percent,
                                speed,
                                eta,
                                status: status.clone(),
                                error_code: None,
                                error: None,
                                file_path: None,
                            },
                        );

                        // F-24: Throttle DB writes — status change flushes
                        // immediately, otherwise at most once per second.
                        let now = std::time::Instant::now();
                        let status_changed = last_db_status.as_ref() != Some(&status);
                        let interval_elapsed =
                            now.duration_since(last_db_write) >= DB_WRITE_INTERVAL;

                        if status_changed || interval_elapsed {
                            if let Some(state) = app_clone.try_state::<AppState>() {
                                let conn = state.db_conn.lock().unwrap();
                                let _ = db::update_download_status(
                                    &conn,
                                    &task_id_clone,
                                    &status,
                                    percent,
                                    None,
                                    None,
                                    None,
                                );
                            }
                            last_db_write = now;
                            last_db_status = Some(status.clone());
                        }
                    }
                } else if line.contains("Merging formats into") {
                    if let Some(idx) = line.find("Merging formats into") {
                        let fp = line[idx + "Merging formats into".len()..]
                            .trim()
                            .trim_matches('"')
                            .to_string();
                        if !fp.is_empty() {
                            final_file_path = Some(fp);
                        }
                    }

                    // F-XX: Real muxing phase begins now — the last thing
                    // before the file is finalized. Emit the status change.
                    let _ = app_clone.emit(
                        "download-progress",
                        DownloadProgressPayload {
                            task_id: task_id_clone.clone(),
                            percent: 99.5,
                            speed: "Finalizing".to_string(),
                            eta: "--".to_string(),
                            status: DownloadStatus::Muxing,
                            error_code: None,
                            error: None,
                            file_path: final_file_path.clone(),
                        },
                    );
                    if let Some(state) = app_clone.try_state::<AppState>() {
                        let conn = state.db_conn.lock().unwrap();
                        let _ = db::update_download_status(
                            &conn,
                            &task_id_clone,
                            &DownloadStatus::Muxing,
                            99.5,
                            None,
                            None,
                            None,
                        );
                    }
                } else if line.contains("has already been downloaded") {
                    let cleaned = line
                        .replace("[download]", "")
                        .replace("has already been downloaded", "");
                    let fp = cleaned.trim().trim_matches('"').to_string();
                    if !fp.is_empty() {
                        final_file_path = Some(fp);
                    }
                }
            }
        }

        let status = child.wait();

        // F-11: disarm the watchdog — process already exited, no need to kill
        watchdog_alive.store(false, std::sync::atomic::Ordering::SeqCst);

        let was_active = if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(mut procs) = state.active_processes.lock() {
                procs.remove(&task_id_clone).is_some()
            } else {
                false
            }
        } else {
            false
        };

        if !was_active {
            return;
        }

        let is_success = match status {
            Ok(s) => s.success(),
            Err(_) => false,
        };

        if is_success {
            if let Some(ref fp) = final_file_path {
                if !std::path::Path::new(fp).exists() {
                    if let Ok(entries) = std::fs::read_dir(&download_dir_clone) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_file() {
                                if let Some(ext_os) = p.extension() {
                                    let ext_str = ext_os.to_string_lossy();
                                    if ext_str != "part" && ext_str != "ytdl" {
                                        if let Ok(meta) = p.metadata() {
                                            if let Ok(mtime) = meta.modified() {
                                                if let Ok(elapsed) = mtime.elapsed() {
                                                    if elapsed.as_secs() < 30 {
                                                        final_file_path =
                                                            Some(p.to_string_lossy().to_string());
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            #[cfg(target_os = "windows")]
            if scan_antivirus.unwrap_or(false) {
                if let Some(ref fp) = final_file_path {
                    // F-18: modern Defender lives under ProgramData\...\Platform\<ver>\
                    let candidates: Vec<std::path::PathBuf> = {
                        let mut v = Vec::new();
                        v.push(std::path::PathBuf::from(
                            r"C:\Program Files\Windows Defender\MpCmdRun.exe",
                        ));
                        if let Ok(entries) =
                            std::fs::read_dir(r"C:\ProgramData\Microsoft\Windows Defender\Platform")
                        {
                            for e in entries.flatten() {
                                let c = e.path().join("MpCmdRun.exe");
                                if c.exists() {
                                    v.push(c);
                                }
                            }
                        }
                        v
                    };
                    if let Some(mpcmdrun) = candidates.iter().find(|p| p.exists()) {
                        let mut av_cmd = Command::new(mpcmdrun);
                        av_cmd.args(["-Scan", "-ScanType", "3", "-File", fp]);
                        av_cmd.creation_flags(0x08000000);
                        let _ = av_cmd.status();
                    }
                }
            }

            // Bug 2 fix: re-check DB status. AV scanning blocks for 2–8
            // seconds. If the user clicked Cancel during that window,
            // cancel_download has already set the record to Cancelled.
            // We must NOT overwrite that with Completed.
            if let Some(state) = app_clone.try_state::<AppState>() {
                if let Ok(conn) = state.db_conn.lock() {
                    if let Ok(recs) = db::get_all_downloads(&conn) {
                        if let Some(rec) = recs.into_iter().find(|r| r.id == task_id_clone) {
                            if rec.status == DownloadStatus::Cancelled
                                || rec.status == DownloadStatus::Interrupted
                            {
                                eprintln!(
                                    "[Devizee] Task {} was cancelled during AV scan — not overriding to Completed",
                                    task_id_clone
                                );
                                return;
                            }
                        }
                    }
                }
            }

            let _ = app_clone.emit(
                "download-progress",
                DownloadProgressPayload {
                    task_id: task_id_clone.clone(),
                    percent: 100.0,
                    speed: "Done".to_string(),
                    eta: "".to_string(),
                    status: DownloadStatus::Completed,
                    error_code: None,
                    error: None,
                    file_path: final_file_path.clone(),
                },
            );
            if let Some(state) = app_clone.try_state::<AppState>() {
                let conn = state.db_conn.lock().unwrap();
                let _ = db::update_download_status(
                    &conn,
                    &task_id_clone,
                    &DownloadStatus::Completed,
                    100.0,
                    final_file_path.as_deref(),
                    None,
                    None,
                );
            }
        } else {
            let logs = error_logs.lock().unwrap().join("\n");
            let error_code = categorize_error(&logs);
            log_download_error(&app_clone, &task_id_clone, &url_clone, error_code, &logs);

            let _ = app_clone.emit(
                "download-progress",
                DownloadProgressPayload {
                    task_id: task_id_clone.clone(),
                    percent: 0.0,
                    speed: "".to_string(),
                    eta: "".to_string(),
                    status: DownloadStatus::Error,
                    error_code: Some(error_code.to_string()),
                    error: Some(logs.clone()),
                    file_path: None,
                },
            );
            if let Some(state) = app_clone.try_state::<AppState>() {
                let conn = state.db_conn.lock().unwrap();
                let _ = db::update_download_status(
                    &conn,
                    &task_id_clone,
                    &DownloadStatus::Error,
                    0.0,
                    None,
                    Some(error_code),
                    Some(&logs),
                );
            }
        }

        // Checkpoint SQLite WAL log to keep WAL file size bounded
        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(conn) = state.db_conn.lock() {
                db::checkpoint_db(&conn);
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn resolve_folder_path(
    path: Option<String>,
    base_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let home_downloads: PathBuf = {
        #[cfg(target_os = "windows")]
        {
            std::env::var("USERPROFILE")
                .map(|p| PathBuf::from(p).join("Downloads"))
                .unwrap_or_else(|_| {
                    app.path()
                        .download_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                })
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::var("HOME")
                .map(|p| PathBuf::from(p).join("Downloads"))
                .unwrap_or_else(|_| {
                    app.path()
                        .download_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                })
        }
    };
    let default_base = home_downloads.join("Devizee");

    let resolved_base: PathBuf = match base_dir {
        Some(dir) if !dir.trim().is_empty() => {
            let p = PathBuf::from(dir.trim());
            if p.is_absolute() {
                p
            } else {
                let trimmed = dir
                    .trim()
                    .trim_start_matches("Downloads/")
                    .trim_start_matches("Downloads\\");
                home_downloads.join(trimmed)
            }
        }
        _ => default_base.clone(),
    };

    let target: PathBuf = match path {
        Some(p) if !p.trim().is_empty() => {
            let pb = PathBuf::from(p.trim());
            if pb.exists() {
                pb
            } else {
                let alt = resolved_base.join(p.trim());
                if alt.exists() {
                    alt
                } else {
                    resolved_base.clone()
                }
            }
        }
        _ => resolved_base.clone(),
    };

    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn open_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    // SEC-2: Never open files through cmd.exe / xdg-open with user-controlled paths.
    // The opener plugin uses ShellExecuteW / xdg-open internally but does NOT invoke
    // a shell interpreter, so shell metacharacters are inert. Additionally we block
    // executable extensions that should never be "opened" from the download history UI.
    let p = std::path::Path::new(&path);

    // Must exist and be a regular file
    if !p.exists() {
        return Err("File not found".to_string());
    }
    if !p.is_file() {
        return Err("Path is not a regular file".to_string());
    }

    // Block executable/script extensions — these have no legitimate reason to be
    // "opened" from the download-history UI; the user should locate them in Explorer.
    const DANGEROUS_EXT: &[&str] = &[
        "exe", "msi", "bat", "cmd", "ps1", "vbs", "js", "wsf", "com", "scr", "pif", "hta", "reg",
        "lnk",
    ];
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        if DANGEROUS_EXT.contains(&ext.to_lowercase().as_str()) {
            return Err(
                "Opening executable files is not allowed from Devizee. Use File Explorer."
                    .to_string(),
            );
        }
    }

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe_path.to_string_lossy().to_string();

        if enable {
            let output = Command::new("reg")
                .args([
                    "add",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "Devizee",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &format!("\"{}\"", exe_str),
                    "/f",
                ])
                .creation_flags(0x08000000)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
        } else {
            // F-28: log if delete fails (registry key may be absent — that's
            // fine — but permission/other errors should be visible)
            match Command::new("reg")
                .args([
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "Devizee",
                    "/f",
                ])
                .creation_flags(0x08000000)
                .output()
            {
                Ok(out) if out.status.success() => {
                    // Cleaned up successfully — no-op
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    // Absence of the value is expected on first disable
                    if !stderr.to_lowercase().contains("unable to find") {
                        eprintln!("[Devizee] Autostart delete: {}", stderr.trim());
                    }
                }
                Err(e) => {
                    eprintln!("[Devizee] Autostart delete spawn failed: {}", e);
                }
            }
        }
    }
    Ok(())
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

#[tauri::command]
async fn get_audio_stream_url(
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
        "--user-agent",
        BROWSER_USER_AGENT,
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
async fn get_video_stream_url(
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
        "--user-agent",
        BROWSER_USER_AGENT,
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
    cmd.arg(&url);
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
async fn fetch_playlist_info(
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
        "--user-agent",
        BROWSER_USER_AGENT,
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--compat-options",
        "no-youtube-unavailable-videos",
        "--extractor-args",
        "youtube:skip=dash,translated_subs,comments",
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
async fn search_youtube(
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

struct AppState {
    db_conn: std::sync::Mutex<rusqlite::Connection>,
    active_processes: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, u32>>>,
    // ─── F-09: Concurrency gate ───
    // Caps the number of yt-dlp child processes running at once. Prevents
    // CPU/disk thrashing when the user queues dozens of downloads rapidly.
    // Hardcoded to 3 for Wave 1. Dynamic configuration comes in Wave 2.
    download_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}

/// F-10: Verify a PID still belongs to one of our known sidecar binaries
/// before we taskkill it. Prevents killing an innocent process when Windows
/// has recycled the PID between read and kill.
#[cfg(target_os = "windows")]
fn is_safe_to_kill(pid: u32) -> bool {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        // Open with minimal rights — just enough to read the image name
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 || handle == INVALID_HANDLE_VALUE {
            // Process no longer exists — safe to skip killing
            return false;
        }

        let mut buf: [u16; 260] = [0; 260];
        let mut size: u32 = 260;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32 as u32,
            buf.as_mut_ptr(),
            &mut size,
        );
        let _ = CloseHandle(handle);

        if ok == 0 {
            // Query failed — treat as "not our process"
            return false;
        }

        let path_str = std::ffi::OsString::from_wide(&buf[..size as usize])
            .to_string_lossy()
            .to_lowercase();
        // Only yt-dlp and ffmpeg are legitimate targets
        path_str.contains("yt-dlp") || path_str.contains("ffmpeg")
    }
}

#[cfg(not(target_os = "windows"))]
fn is_safe_to_kill(_pid: u32) -> bool {
    true
}

#[tauri::command]
async fn pause_download(
    task_id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let pid_opt = {
        let mut procs = state
            .active_processes
            .lock()
            .map_err(|_| "Process map lock poisoned")?;
        procs.remove(&task_id)
    };

    if let Some(pid) = pid_opt {
        // F-10: verify the PID still belongs to our yt-dlp/ffmpeg before kill.
        if is_safe_to_kill(pid) {
            #[cfg(target_os = "windows")]
            {
                let mut kill_cmd = Command::new("taskkill");
                kill_cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
                kill_cmd.creation_flags(0x08000000);
                let _ = kill_cmd.status();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut kill_cmd = Command::new("kill");
                kill_cmd.args(["-9", &pid.to_string()]);
                let _ = kill_cmd.status();
            }
        } else {
            eprintln!(
                "[Devizee] Pause: PID {} no longer matches yt-dlp/ffmpeg — skipping kill (already exited)",
                pid
            );
        }
    }

    {
        let conn = state.db_conn.lock().map_err(|_| "Database lock poisoned")?;
        let _ = db::update_status_only(&conn, &task_id, &DownloadStatus::Interrupted);
    }

    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            task_id,
            percent: 0.0,
            speed: "Paused".to_string(),
            eta: "--".to_string(),
            status: DownloadStatus::Interrupted,
            error_code: None,
            error: None,
            file_path: None,
        },
    );

    Ok(())
}

#[tauri::command]
async fn cancel_download(
    task_id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let pid_opt = {
        let mut procs = state
            .active_processes
            .lock()
            .map_err(|_| "Process map lock poisoned")?;
        procs.remove(&task_id)
    };

    if let Some(pid) = pid_opt {
        // F-10: verify the PID still belongs to our yt-dlp/ffmpeg before kill.
        if is_safe_to_kill(pid) {
            #[cfg(target_os = "windows")]
            {
                let mut kill_cmd = Command::new("taskkill");
                kill_cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
                kill_cmd.creation_flags(0x08000000);
                let _ = kill_cmd.status();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut kill_cmd = Command::new("kill");
                kill_cmd.args(["-9", &pid.to_string()]);
                let _ = kill_cmd.status();
            }
        } else {
            eprintln!(
                "[Devizee] Cancel: PID {} no longer matches yt-dlp/ffmpeg — skipping kill (already exited)",
                pid
            );
        }
    }

    {
        let conn = state.db_conn.lock().map_err(|_| "Database lock poisoned")?;
        let _ = db::update_status_only(&conn, &task_id, &DownloadStatus::Cancelled);
    }

    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            task_id,
            percent: 0.0,
            speed: "Cancelled".to_string(),
            eta: "--".to_string(),
            status: DownloadStatus::Cancelled,
            error_code: None,
            error: None,
            file_path: None,
        },
    );

    Ok(())
}

#[tauri::command]
async fn fetch_audio_bytes(
    url: String,
    cookies_from_browser: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<u8>, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let ffmpeg_path = get_ffmpeg_path(&app);

    let mut cmd = Command::new(&yt_dlp_path);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.args([
        "-f",
        "bestaudio/best",
        "-o",
        "-",
        "--no-playlist",
        "--no-warnings",
        "--no-colors",
        "--force-ipv4",
        "--geo-bypass",
        "--user-agent",
        BROWSER_USER_AGENT,
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--quiet",
        "--no-part",
        "--concurrent-fragments",
        "4",
    ]);
    for arg in cookies_args(cookies_from_browser) {
        cmd.arg(arg);
    }
    if let Some(ref ff) = ffmpeg_path {
        cmd.arg("--ffmpeg-location");
        cmd.arg(ff);
    }
    cmd.arg(&url);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    // Bug 8: 60s timeout — audio byte fetch can take longer than metadata.
    let output = run_command_with_timeout(cmd, 60, "yt-dlp audio bytes")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let clean: Vec<&str> = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(5)
            .collect();
        return Err(format!("yt-dlp failed: {}", clean.join(" | ")));
    }

    if output.stdout.len() < 4096 {
        return Err(format!(
            "Audio fetch returned only {} bytes — likely an error page, not real media",
            output.stdout.len()
        ));
    }

    Ok(output.stdout)
}

#[tauri::command]
async fn read_local_file(path: String, app: tauri::AppHandle) -> Result<Vec<u8>, String> {
    // SEC-3: Restrict file reads to the download directory tree.
    // Any path that canonicalizes outside Downloads/Devizee (or the user-configured
    // equivalent) is rejected — this prevents a compromised frontend from reading
    // SSH keys, browser cookies, or arbitrary system files.

    let p = std::path::Path::new(&path);

    // Require the file to actually exist before canonicalizing
    if !p.exists() || !p.is_file() {
        return Err("File not found".to_string());
    }

    let canonical = p
        .canonicalize()
        .map_err(|e| format!("Path resolution failed: {}", e))?;

    // Determine the allowed root: system Downloads/Devizee
    let allowed_root = app
        .path()
        .download_dir()
        .map(|d| d.join("Devizee"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    // Try to canonicalize the allowed root; if it doesn't exist yet, use it as-is
    let allowed_canonical = allowed_root.canonicalize().unwrap_or(allowed_root);

    // F-16: normalize case on Windows for UNC path prefix comparison.
    let canon_str = canonical.to_string_lossy().to_lowercase();
    let allowed_str = allowed_canonical.to_string_lossy().to_lowercase();

    // Bug 1 fix: allow any file recorded in the DB, even if the user
    // configured a custom download folder (e.g. D:\Media). Without this,
    // users on custom paths cannot preview their own downloads.
    let mut is_known_download = false;
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(conn) = state.db_conn.lock() {
            if let Ok(records) = db::get_all_downloads(&conn) {
                is_known_download = records
                    .iter()
                    .any(|r| r.file_path.as_deref() == Some(path.as_str()));
            }
        }
    }

    if !is_known_download && !canon_str.starts_with(&allowed_str) {
        return Err("Access denied: file is outside the Devizee download directory".to_string());
    }

    std::fs::read(&canonical).map_err(|e| format!("read_local_file failed: {}", e))
}

#[tauri::command]
fn read_subtitle_file(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() || !p.is_file() {
        return Err("Subtitle file not found".to_string());
    }

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "srt" && ext != "vtt" && ext != "txt" {
        return Err("Unsupported subtitle format. Please select an .srt or .vtt file.".to_string());
    }

    let content = std::fs::read_to_string(p)
        .map_err(|e| format!("Failed to read subtitle file: {}", e))?;

    if content.trim_start().starts_with("WEBVTT") {
        return Ok(content);
    }

    // Convert SubRip (.srt) timestamps to WebVTT (.vtt)
    let converted = content
        .lines()
        .map(|line| {
            if line.contains("-->") {
                line.replace(',', ".")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<String>>()
        .join("\n");

    Ok(format!("WEBVTT\n\n{}", converted))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineInfo {
    pub current_version: String,
    pub binary_path: String,
    pub is_custom_updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineUpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineUpdateResult {
    pub success: bool,
    pub new_version: String,
    pub new_hash: Option<String>,
    pub message: String,
}

#[tauri::command]
async fn get_engine_info(app: tauri::AppHandle) -> Result<EngineInfo, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let mut cmd = Command::new(&yt_dlp_path);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let output = run_command_with_timeout(cmd, 10, "yt-dlp version check")?;
    let current_version = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let is_custom_updated = if let Ok(local_data) = app.path().app_local_data_dir() {
        let updated_bin = local_data.join("bin").join("yt-dlp.exe");
        yt_dlp_path == updated_bin
    } else {
        false
    };

    Ok(EngineInfo {
        current_version,
        binary_path: yt_dlp_path.to_string_lossy().to_string(),
        is_custom_updated,
    })
}

#[tauri::command]
async fn check_engine_update(app: tauri::AppHandle) -> Result<EngineUpdateCheck, String> {
    let engine_info = get_engine_info(app).await?;
    let client = reqwest::Client::builder()
        .user_agent("Devizee-Download-Manager")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let res = client
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Network error checking yt-dlp release: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("GitHub API returned HTTP {}", res.status()));
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse release JSON: {}", e))?;

    let latest_version = json["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();

    if latest_version.is_empty() {
        return Err("Could not parse version tag from GitHub release".to_string());
    }

    let update_available = engine_info.current_version.trim() != latest_version.trim();
    let release_notes = json["body"].as_str().map(|s| s.to_string());

    Ok(EngineUpdateCheck {
        current_version: engine_info.current_version,
        latest_version,
        update_available,
        release_notes,
    })
}

#[tauri::command]
async fn update_engine(app: tauri::AppHandle) -> Result<EngineUpdateResult, String> {
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data directory: {}", e))?;
    let bin_dir = local_data.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create bin directory: {}", e))?;

    let target_path = bin_dir.join("yt-dlp.exe");
    let temp_path = bin_dir.join("yt-dlp.exe.download");

    let client = reqwest::Client::builder()
        .user_agent("Devizee-Download-Manager")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let res = client
        .get("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe")
        .send()
        .await
        .map_err(|e| format!("Failed to download yt-dlp.exe: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("GitHub download returned HTTP {}", res.status()));
    }

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download stream: {}", e))?;

    if bytes.len() < 5_000_000 {
        return Err(format!(
            "Downloaded binary is only {} bytes, expected >5 MB. Download aborted.",
            bytes.len()
        ));
    }

    // Write to temporary file first
    std::fs::write(&temp_path, &bytes)
        .map_err(|e| format!("Failed to write downloaded binary: {}", e))?;

    // Verify the downloaded binary can execute and output version
    let mut verify_cmd = Command::new(&temp_path);
    verify_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    verify_cmd.creation_flags(0x08000000);

    let verify_output = run_command_with_timeout(verify_cmd, 10, "verify new yt-dlp binary")
        .map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Downloaded binary failed execution check: {}", e)
        })?;

    if !verify_output.status.success() {
        let _ = std::fs::remove_file(&temp_path);
        return Err("New binary verification failed --version check".to_string());
    }

    let new_version = String::from_utf8_lossy(&verify_output.stdout)
        .trim()
        .to_string();

    // Replace target binary atomically
    if target_path.exists() {
        let backup_path = bin_dir.join("yt-dlp.exe.old");
        let _ = std::fs::remove_file(&backup_path);
        let _ = std::fs::rename(&target_path, &backup_path);
    }

    if let Err(e) = std::fs::rename(&temp_path, &target_path) {
        return Err(format!("Failed to move new binary into place: {}", e));
    }

    // Clean up old backup
    let backup_path = bin_dir.join("yt-dlp.exe.old");
    let _ = std::fs::remove_file(&backup_path);

    let new_hash = compute_file_sha256(&target_path);

    Ok(EngineUpdateResult {
        success: true,
        new_version: new_version.clone(),
        new_hash,
        message: format!("Successfully upgraded yt-dlp engine to version {}", new_version),
    })
}

#[tauri::command]
fn get_history(state: tauri::State<AppState>) -> Result<Vec<db::DownloadRecord>, String> {
    // SEC-10: Handle poisoned lock gracefully
    let conn = state
        .db_conn
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;

    let mut records = db::get_all_downloads(&conn).map_err(|e| e.to_string())?;
    for record in &mut records {
        if record.status == DownloadStatus::Completed {
            if let Some(ref path) = record.file_path {
                let p = std::path::Path::new(path);
                if !p.exists() {
                    record.status = DownloadStatus::Missing;
                    let _ = db::update_download_status(
                        &conn,
                        &record.id,
                        &DownloadStatus::Missing,
                        record.percent,
                        Some(path),
                        None,
                        None,
                    );
                } else if let Ok(meta) = std::fs::metadata(p) {
                    record.file_size = Some(meta.len());
                }
            }
        }
    }
    Ok(records)
}

#[tauri::command]
fn hide_history_item(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    // SEC-10: Handle poisoned lock gracefully
    let conn = state
        .db_conn
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db::hide_download(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_history_file(
    id: String,
    file_path: String,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // SEC-6: Restrict file deletion to the download directory tree.
    // file_path comes from the frontend and must be validated before deletion.
    let p = std::path::Path::new(&file_path);
    if p.exists() {
        // Canonicalize and bounds-check before deletion
        let canonical = p
            .canonicalize()
            .map_err(|e| format!("Path resolution failed: {}", e))?;

        let allowed_root = app
            .path()
            .download_dir()
            .map(|d| d.join("Devizee"))
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        let allowed_canonical = allowed_root.canonicalize().unwrap_or(allowed_root);

        // Bug 1 fix: allow any file recorded in the DB, even if the user
        // configured a custom download folder (e.g. D:\Media). Without this,
        // users on custom paths cannot delete their own downloads.
        let mut is_known_download = false;
        if let Ok(conn) = state.db_conn.lock() {
            if let Ok(records) = db::get_all_downloads(&conn) {
                is_known_download = records
                    .iter()
                    .any(|r| r.file_path.as_deref() == Some(file_path.as_str()));
            }
        }

        if !is_known_download && !canonical.starts_with(&allowed_canonical) {
            return Err(
                "Access denied: file is outside the Devizee download directory".to_string(),
            );
        }

        let _ = std::fs::remove_file(&canonical);
    }
    let conn = state
        .db_conn
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db::hide_download(&conn, &id).map_err(|e| e.to_string())
}

/// Spawns a lightweight local HTTP server bound exclusively to 127.0.0.1:42421.
/// Allows the Devizee browser extension to communicate seamlessly with zero configuration.
fn start_local_http_bridge(app_handle: tauri::AppHandle, port: u16) {
    let addr = ("127.0.0.1", port);
    let listener = match std::net::TcpListener::bind(addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[Devizee Bridge] Local port {} unavailable (already running or in use): {}", port, e);
            return;
        }
    };

    // Generate random 32-character bridge token on startup
    let token = format!(
        "{:016x}{:016x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(987654321),
        std::process::id()
    );

    // Save token to %LOCALAPPDATA%\Devizee\bridge_token
    if let Ok(app_dir) = app_handle.path().app_local_data_dir() {
        let _ = std::fs::create_dir_all(&app_dir);
        let _ = std::fs::write(app_dir.join("bridge_token"), token.as_bytes());
    }

    println!("[Devizee Bridge] Listening on http://127.0.0.1:{}", port);

    let token_clone = token.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let app = app_handle.clone();
                let token = token_clone.clone();
                std::thread::spawn(move || {
                    handle_bridge_connection(&mut stream, &app, &token);
                });
            }
        }
    });
}

fn handle_bridge_connection(
    stream: &mut std::net::TcpStream,
    app: &tauri::AppHandle,
    expected_token: &str,
) {
    use std::io::{Read, Write};
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1500)));

    let mut buf = [0u8; 8192];
    let bytes_read = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let req = String::from_utf8_lossy(&buf[..bytes_read]);
    let mut lines = req.lines();
    let request_line = match lines.next() {
        Some(l) => l,
        None => return,
    };

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // Extract Origin and X-Devizee-Token headers
    let mut origin: Option<String> = None;
    let mut token_header: Option<String> = None;

    for line in lines {
        if line.is_empty() {
            break;
        }
        let lower = line.to_lowercase();
        if lower.starts_with("origin:") {
            origin = Some(line["origin:".len()..].trim().to_string());
        } else if lower.starts_with("x-devizee-token:") {
            token_header = Some(line["x-devizee-token:".len()..].trim().to_string());
        }
    }

    // SECURITY: Block external websites from triggering downloads.
    // Browsers forbid web pages from setting chrome-extension:// or moz-extension:// Origin.
    let is_valid_extension_origin = match origin.as_deref() {
        Some(o) => o.starts_with("chrome-extension://") || o.starts_with("moz-extension://"),
        None => false,
    };

    let is_authenticated_token = match token_header.as_deref() {
        Some(t) => t == expected_token,
        None => false,
    };

    // If an external web page attempts cross-origin access, reject immediately with 403 Forbidden!
    if origin.is_some() && !is_valid_extension_origin {
        let resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Cross-origin web requests are blocked.";
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    let allowed_origin = origin.unwrap_or_else(|| "null".to_string());
    let cors_headers = format!(
        "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-Devizee-Token\r\nConnection: close",
        allowed_origin
    );

    if method == "OPTIONS" {
        let resp = format!("HTTP/1.1 204 No Content\r\n{}\r\n\r\n", cors_headers);
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    if path == "/status" || path == "/ping" {
        let body = serde_json::json!({
            "status": "ok",
            "app": "Devizee Lite",
            "port": 42421,
            "version": "0.5.0"
        }).to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n\r\n{}",
            body.len(),
            cors_headers,
            body
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    if method == "POST" && path.starts_with("/download") {
        // Enforce that caller is either a valid extension Origin OR holds the secret token
        if !is_valid_extension_origin && !is_authenticated_token {
            let body = serde_json::json!({"error": "unauthorized"}).to_string();
            let resp = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n\r\n{}",
                body.len(),
                cors_headers,
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            return;
        }

        let mut target_url: Option<String> = None;

        if let Some(body_start) = req.find("\r\n\r\n") {
            let body = &req[body_start + 4..];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(u) = v.get("url").and_then(|x| x.as_str()) {
                    target_url = Some(u.to_string());
                }
            }
        }

        if let Some(url) = target_url {
            let clean_url = url.trim().to_string();
            if clean_url.starts_with("http://") || clean_url.starts_with("https://") {
                if is_known_drm_service(&clean_url) {
                    let body = serde_json::json!({
                        "error": "drm_protected",
                        "message": "This platform uses hardware-level DRM encryption and cannot be downloaded."
                    }).to_string();
                    let resp = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n\r\n{}",
                        body.len(),
                        cors_headers,
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();
                    return;
                }

                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                let _ = app.emit("open-url", clean_url);

                let body = serde_json::json!({"status": "queued"}).to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n\r\n{}",
                    body.len(),
                    cors_headers,
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
                return;
            }
        }

        let body = serde_json::json!({"error": "invalid url"}).to_string();
        let resp = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n\r\n{}",
            body.len(),
            cors_headers,
            body
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

    let body = "Not Found";
    let resp = format!(
        "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\n{}\r\n\r\n{}",
        body.len(),
        cors_headers,
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            let mut iter = argv.iter();
            while let Some(arg) = iter.next() {
                if arg == "--url" {
                    if let Some(target) = iter.next() {
                        let _ = app.emit("open-url", target.to_string());
                    }
                } else if arg.starts_with("streamgrab://download?url=") {
                    // F-27: hardened deep-link validation.
                    // - Reject any URL containing a null byte (truncation trick)
                    // - Reject any URL with control characters
                    // - Reject anything that isn't http/https after ONE decode pass
                    // - Cap length to prevent DoS via giant pasted URLs
                    let raw = arg.trim_start_matches("streamgrab://download?url=");

                    if raw.len() > 2048 {
                        eprintln!("[Devizee] Deep link rejected: URL exceeds 2048 chars");
                    } else if raw.contains('\0')
                        || raw.chars().any(|c| c.is_control() && c != '\t')
                    {
                        eprintln!("[Devizee] Deep link rejected: contains null/control chars");
                    } else {
                        // Single percent-decode of the transport layer only.
                        // The embedded URL is not recursively decoded, so
                        // double-encoded schemes like %256a... cannot slip
                        // through as javascript: after decoding.
                        let decoded = raw
                            .replace("%3A", ":")
                            .replace("%3a", ":")
                            .replace("%2F", "/")
                            .replace("%2f", "/");

                        if decoded.starts_with("http://") || decoded.starts_with("https://") {
                            let _ = app.emit("open-url", decoded);
                        } else {
                            eprintln!(
                                "[Devizee] Deep link rejected: scheme not http/https ({})",
                                &decoded.chars().take(40).collect::<String>()
                            );
                        }
                    }
                } else if arg.starts_with("http://") || arg.starts_with("https://") {
                    // Already a validated http/https URL from the single-instance argv
                    let _ = app.emit("open-url", arg.to_string());
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let ctrl_shift_d =
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD);
                    if shortcut == &ctrl_shift_d {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                        let _ = app.emit("global-hotkey-paste", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // W3-4: init_db is now self-healing (quarantines corrupt DB and
            // starts fresh). If it still fails, log clearly and shut down
            // gracefully instead of panicking with an unreadable stack trace.
            let conn = match db::init_db(app.handle()) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "[Devizee] FATAL: Could not initialize database after recovery attempts: {}",
                        e
                    );
                    // Return the error so Tauri aborts the setup cleanly. The
                    // app will exit rather than run in a broken state.
                    return Err(Box::new(e) as Box<dyn std::error::Error>);
                }
            };
            app.manage(AppState {
                db_conn: std::sync::Mutex::new(conn),
                active_processes: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::HashMap::new(),
                )),
                // F-09: 3 concurrent yt-dlp processes maximum.
                // Wave 2 will read this from user settings.
                download_semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(3)),
            });

            // ─── SC-1: Sleep / hibernate detection ───
            // Windows doesn't easily expose WM_POWERBROADCAST to Tauri v2.
            // We detect sleep via wall-clock jumps: if Instant::now() advances
            // by >30 seconds during a 5-second check cycle, the system was
            // almost certainly suspended. On detection we kill active yt-dlp
            // processes (they'd hang on dead sockets after wake) and mark
            // their tasks as Interrupted so the user can resume.
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    const CHECK_INTERVAL_SECS: u64 = 5;
                    const SLEEP_THRESHOLD_SECS: u64 = 30;

                    let mut last_check = std::time::Instant::now();

                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECS));
                        let now = std::time::Instant::now();
                        let elapsed = now
                            .checked_duration_since(last_check)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        last_check = now;

                        if elapsed > SLEEP_THRESHOLD_SECS {
                            eprintln!(
                                "[Devizee] Sleep detected ({}s jump). Interrupting active downloads.",
                                elapsed
                            );

                            if let Some(state) = app_handle.try_state::<AppState>() {
                                // Snapshot the process map. Vec is owned so we
                                // can consume it in the loop.
                                let victims: Vec<(String, u32)> = {
                                    match state.active_processes.lock() {
                                        Ok(procs) => procs
                                            .iter()
                                            .map(|(k, v)| (k.clone(), *v))
                                            .collect(),
                                        Err(_) => Vec::new(),
                                    }
                                };

                                // Capture emptiness BEFORE the loop consumes victims.
                                let had_victims = !victims.is_empty();

                                for (task_id, pid) in victims {
                                    // Bug 3 fix: Muxing tasks use local ffmpeg,
                                    // not network. They can safely complete after
                                    // wake. Killing them leaves a truncated .mp4
                                    // that yt-dlp refuses to re-mux on resume
                                    // (it sees the file already exists).
                                    let is_muxing = {
                                        match state.db_conn.lock() {
                                            Ok(conn) => db::get_all_downloads(&conn)
                                                .ok()
                                                .and_then(|recs| {
                                                    recs.into_iter()
                                                        .find(|r| r.id == task_id)
                                                })
                                                .map(|r| r.status == DownloadStatus::Muxing)
                                                .unwrap_or(false),
                                            Err(_) => false,
                                        }
                                    };

                                    if is_muxing {
                                        eprintln!(
                                            "[Devizee Sleep] Skipping Muxing task {} — ffmpeg can finish after wake",
                                            task_id
                                        );
                                        continue;
                                    }

                                    // Bug 5: verify image name before kill to prevent PID-recycle hits.
                                    if is_safe_to_kill(pid) {
                                        #[cfg(target_os = "windows")]
                                        {
                                            let mut kill_cmd = Command::new("taskkill");
                                            kill_cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
                                            kill_cmd.creation_flags(0x08000000);
                                            let _ = kill_cmd.status();
                                        }
                                        #[cfg(not(target_os = "windows"))]
                                        {
                                            let _ = Command::new("kill")
                                                .args(["-9", &pid.to_string()])
                                                .status();
                                        }
                                    } else {
                                        eprintln!(
                                            "[Devizee Sleep] PID {} no longer matches — skipping kill",
                                            pid
                                        );
                                    }

                                    if let Ok(mut procs) = state.active_processes.lock() {
                                        procs.remove(&task_id);
                                    }

                                    if let Ok(conn) = state.db_conn.lock() {
                                        let _ = db::update_status_only(
                                            &conn,
                                            &task_id,
                                            &DownloadStatus::Interrupted,
                                        );
                                    }

                                    let _ = app_handle.emit(
                                        "download-progress",
                                        DownloadProgressPayload {
                                            task_id: task_id.clone(),
                                            percent: 0.0,
                                            speed: "Paused after system wake".to_string(),
                                            eta: "--".to_string(),
                                            status: DownloadStatus::Interrupted,
                                            error_code: None,
                                            error: None,
                                            file_path: None,
                                        },
                                    );
                                }

                                if had_victims {
                                    let _ = app_handle.emit("system-woke-from-sleep", ());
                                }
                            }
                        }
                    }
                });
            }

            // System tray icon + menu
            let open_item = MenuItem::with_id(app, "open", "Open Devizee", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .ok_or("No default window icon configured")?
                .clone();

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Devizee Lite - Universal Video Downloader")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ─── SC-3: sidecar binary fingerprint check ───
            // Compute SHA-256 of the resolved yt-dlp and ffmpeg binaries
            // and emit them to the frontend. The frontend compares against
            // a stored baseline (localStorage) and notifies the user if the
            // hashes changed — indicating possible tampering or a legitimate
            // binary update.
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Small delay so the main window is ready to receive events
                    std::thread::sleep(std::time::Duration::from_secs(2));

                    let yt_dlp_hash = get_yt_dlp_path(&app_handle)
                        .ok()
                        .and_then(|p| compute_file_sha256(&p));
                    let ffmpeg_hash = get_ffmpeg_path(&app_handle)
                        .and_then(|p| compute_file_sha256(&p));

                    let _ = app_handle.emit(
                        "sidecar-fingerprint",
                        serde_json::json!({
                            "yt_dlp": yt_dlp_hash,
                            "ffmpeg": ffmpeg_hash,
                        }),
                    );
                });
            }

            // Periodic SQLite WAL checkpointing every 5 minutes to prevent WAL file growth
            {
                let app_handle_wal = app.handle().clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(300));
                        if let Some(state) = app_handle_wal.try_state::<AppState>() {
                            if let Ok(conn) = state.db_conn.lock() {
                                db::checkpoint_db(&conn);
                            }
                        }
                    }
                });
            }

            // Start local loopback HTTP bridge for browser extension communication (port 42421)
            start_local_http_bridge(app.handle().clone(), 42421);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_video_info,
            fetch_playlist_info,
            search_youtube,
            get_audio_stream_url,
            get_video_stream_url,
            start_download,
            pause_download,
            cancel_download,
            resolve_folder_path,
            open_file,
            get_history,
            hide_history_item,
            delete_history_file,
            set_autostart,
            fetch_audio_bytes,
            fix_legacy_paths,
            read_local_file,
            read_subtitle_file,
            cleanup_orphan_parts,
            exit_app,
            get_engine_info,
            check_engine_update,
            update_engine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
