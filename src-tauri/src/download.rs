use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::db;
use crate::engine::{get_ffmpeg_path, get_yt_dlp_path};
use crate::is_safe_to_kill;
use crate::metadata::cookies_args;
use crate::status::DownloadStatus;
use crate::AppState;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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
    pub downloaded_bytes: Option<String>,
    pub total_bytes: Option<String>,
}

pub(crate) fn categorize_error(stderr: &str) -> &'static str {
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
    } else if lower.contains("sign in to confirm")
        || lower.contains("not a bot")
        || lower.contains("bot detection")
        || lower.contains("cookies-from-browser")
        || lower.contains("sign in to confirm your age")
        || lower.contains("age-restricted")
    {
        "auth_required"
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

pub(crate) fn log_download_error(
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
pub(crate) fn free_space_bytes_for_path(path: &std::path::Path) -> Option<u64> {
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
pub(crate) fn free_space_bytes_for_path(_path: &std::path::Path) -> Option<u64> {
    None
}

/// Single Source of Truth for Output Path Resolution
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_output_dir(
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
pub(crate) fn cleanup_orphan_part_files(root: &std::path::Path) -> usize {
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

/// Frontend calls this on startup with the current saveFolder path.
/// Returns the number of orphan files removed (0 if none).
#[tauri::command]
pub async fn cleanup_orphan_parts(root: String) -> Result<usize, String> {
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

/// Starts a download (spawns yt-dlp in background thread)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_download(
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
    subtitles_in_subfolder: Option<bool>,
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
            downloaded_bytes: None,
            total_bytes: None,
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
        let download_start_time = std::time::Instant::now();
        let mut cmd = Command::new(&yt_dlp_path);
        let progress_template = "DEVIZEE_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s|vcodec:%(info.vcodec)s|acodec:%(info.acodec)s|format:%(info.format_id)s|ext:%(info.ext)s";

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
            "--concurrent-fragments",
            "4",
            "--compat-options",
            "no-youtube-unavailable-videos",
            "--no-abort-on-error",
            "--extractor-args",
            "youtube:skip=translated_subs,comments",
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

            let effective_fmt = if format_id.contains("bestaudio") || format_id.is_empty() || format_id.contains('(') || format_id.contains(' ') {
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
            let sanitized_fmt = if format_id.is_empty()
                || format_id == "best"
                || format_id.contains('(')
                || format_id.contains(' ')
            {
                "bestvideo+bestaudio/best".to_string()
            } else if !format_id.contains('/') && !format_id.contains('+') && !format_id.contains("best") {
                format!("{}+bestaudio/best", format_id)
            } else {
                format_id.clone()
            };
            cmd.args(["-f", &sanitized_fmt, "--merge-output-format", &ext]);
        }

        if !is_audio_only && download_subtitles.unwrap_or(false) && download_sections.is_none() {
            if subtitles_in_subfolder.unwrap_or(true) {
                // Route all standalone subtitle (.vtt/.srt) files into a dedicated "subtitles" subfolder
                // inside the video download directory so they don't clutter the main videos folder.
                let subs_dir = download_dir.join("subtitles");
                let _ = std::fs::create_dir_all(&subs_dir);
                cmd.args(["-P", &format!("subtitle:{}", subs_dir.to_string_lossy())]);
            }

            let langs = subtitle_languages
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("en.*,en");

            if langs == "all" {
                // When "all" is requested, only write official/manual subtitles.
                // Requesting 100+ machine-translated auto-subs triggers YouTube HTTP 429 Too Many Requests.
                cmd.args([
                    "--write-subs",
                    "--embed-subs",
                ]);
            } else {
                cmd.args([
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs",
                    langs,
                    "--embed-subs",
                ]);
            }
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
                        downloaded_bytes: None,
                        total_bytes: None,
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
                downloaded_bytes: None,
                total_bytes: None,
            },
        );

        // ─── F-11: Inactivity watchdog ───
        // If yt-dlp emits nothing on stdout/stderr for an extended period,
        // assume the socket is dead and kill the process tree.
        // During active network download: 90s timeout.
        // During ffmpeg post-processing / audio conversion / format muxing: 300s (5m) timeout.
        let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));
        let last_activity_stderr = last_activity.clone();
        let last_activity_stdout = last_activity.clone();
        let is_postprocessing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let is_postprocessing_watchdog = is_postprocessing.clone();
        let is_postprocessing_stderr = is_postprocessing.clone();
        let is_postprocessing_stdout = is_postprocessing.clone();
        let watchdog_alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let watchdog_alive_clone = watchdog_alive.clone();
        let watchdog_pid = pid;
        let watchdog_task_id = task_id_clone.clone();
        let watchdog_app = app_clone.clone();

        std::thread::spawn(move || {
            const CHECK_INTERVAL_SECS: u64 = 15;
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

                let inactivity_limit = if is_postprocessing_watchdog.load(std::sync::atomic::Ordering::SeqCst) {
                    300 // 5 minutes during muxing / audio conversion / post-processing
                } else {
                    90  // 90 seconds during network downloading
                };

                if since_last >= inactivity_limit {
                    eprintln!(
                        "[Devizee Watchdog] No output from PID {} for {}s (postprocessing: {}) — killing (task {})",
                        watchdog_pid, since_last, is_postprocessing_watchdog.load(std::sync::atomic::Ordering::SeqCst), watchdog_task_id
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
                            downloaded_bytes: None,
                            total_bytes: None,
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
            let mut chunk = [0u8; 4096];
            let mut line_buf = Vec::new();
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                // F-11: touch activity timestamp on ANY stderr bytes (including \r carriage returns from ffmpeg)
                if let Ok(mut t) = last_activity_stderr.lock() {
                    *t = std::time::Instant::now();
                }

                for &byte in &chunk[..n] {
                    if byte == b'\n' || byte == b'\r' {
                        if !line_buf.is_empty() {
                            let line = String::from_utf8_lossy(&line_buf).trim().to_string();
                            line_buf.clear();
                            if !line.is_empty() {
                                if line.contains("Postprocessing") || line.contains("ExtractAudio") || line.contains("Merger") {
                                    is_postprocessing_stderr.store(true, std::sync::atomic::Ordering::SeqCst);
                                }
                                let mut logs = error_logs_clone.lock().unwrap();
                                logs.push(line);
                                if logs.len() > MAX_STDERR_LINES {
                                    let excess = logs.len() - MAX_STDERR_LINES;
                                    logs.drain(0..excess);
                                }
                            }
                        }
                    } else {
                        line_buf.push(byte);
                    }
                }
            }
        });

        let mut final_file_path = None;

        // ─── F-24: Throttle progress DB writes & IPC emits ───
        // yt-dlp emits DEVIZEE_PROGRESS lines dozens of times per second. Writing
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

        let mut last_ipc_emit = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(500))
            .unwrap_or_else(std::time::Instant::now);
        let mut last_ipc_percent: f32 = -1.0;
        const IPC_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(180);

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

                if line.contains("Merging formats into") || line.contains("Postprocessing") || line.contains("[ExtractAudio]") || line.contains("[Merger]") {
                    is_postprocessing_stdout.store(true, std::sync::atomic::Ordering::SeqCst);
                }

                if line.contains("format(s)") && line.contains("Downloading") {
                    if line.contains('+') {
                        let plus_count = line.matches('+').count();
                        detected_stream_count = Some(plus_count + 1);
                    } else if let Some(pos) = line.find(" format(s)") {
                        if let Some(space_pos) = line[..pos].rfind(' ') {
                            if let Ok(count) = line[space_pos + 1..pos].parse::<usize>() {
                                detected_stream_count = Some(count);
                            }
                        }
                    }
                }

                if line.contains("Destination:") {
                    let is_aux_file = line.ends_with(".vtt")
                        || line.ends_with(".srt")
                        || line.ends_with(".lrc")
                        || line.ends_with(".jpg")
                        || line.ends_with(".webp")
                        || line.ends_with(".png");
                    if !is_aux_file {
                        destination_count += 1;
                    }
                    if let Some(idx) = line.find("Destination:") {
                        let fp = line[idx + "Destination:".len()..]
                            .trim()
                            .trim_matches('"')
                            .to_string();
                        if !fp.is_empty() && !is_aux_file {
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
                        let raw_eta = parts[2].trim().to_string();

                        let downloaded_bytes = if parts.len() > 3 {
                            let s = parts[3].trim();
                            if s != "NA" && s != "N/A" && !s.is_empty() {
                                Some(s.to_string())
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        let total_bytes = if parts.len() > 4 {
                            let s = parts[4].trim();
                            if s != "NA" && s != "N/A" && !s.is_empty() {
                                Some(s.to_string())
                            } else if parts.len() > 5 {
                                let est = parts[5].trim();
                                if est != "NA" && est != "N/A" && !est.is_empty() {
                                    Some(format!("~{}", est))
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        let vcodec = parts.iter().find(|p| p.starts_with("vcodec:")).map(|p| &p[7..]).unwrap_or("");
                        let acodec = parts.iter().find(|p| p.starts_with("acodec:")).map(|p| &p[7..]).unwrap_or("");
                        let format_info = parts.iter().find(|p| p.starts_with("format:")).map(|p| &p[7..]).unwrap_or("");
                        let ext_info = parts.iter().find(|p| p.starts_with("ext:")).map(|p| &p[4..]).unwrap_or("");

                        // Filter out auxiliary downloads (subtitles, thumbnails) so their 100% completion does not jump the progress bar
                        let is_auxiliary = format_info == "NA"
                            || ext_info == "vtt"
                            || ext_info == "srt"
                            || ext_info == "lrc"
                            || ext_info == "ttml"
                            || ext_info == "jpg"
                            || ext_info == "webp"
                            || ext_info == "png";

                        if is_auxiliary {
                            continue;
                        }

                        // Stream type detection:
                        let is_video_stream = vcodec != "none" && vcodec != "NA" && !vcodec.is_empty();
                        let is_audio_stream = (vcodec == "none" || vcodec.is_empty()) && acodec != "none" && acodec != "NA" && !acodec.is_empty();

                        // Multi-stream DASH smooth scaling:
                        // Tracks multi-stream downloads (e.g. YouTube DASH video+audio = 2, TikTok single = 1).
                        // Video stream is scaled to 0..88%, audio stream to 88..99%, avoiding premature 99% jumps.
                        let is_multi = is_multi_stream || detected_stream_count.map(|c| c > 1).unwrap_or(false);
                        let percent: f32 = if is_multi {
                            if is_video_stream {
                                (raw_percent * 0.88).min(88.0)
                            } else if is_audio_stream {
                                (88.0 + (raw_percent * 0.11)).min(99.0)
                            } else if destination_count <= 1 {
                                (raw_percent * 0.88).min(88.0)
                            } else {
                                (88.0 + (raw_percent * 0.11)).min(99.0)
                            }
                        } else {
                            raw_percent.min(99.0)
                        };

                        let eta = if raw_eta != "NA" && !raw_eta.is_empty() && raw_eta.to_lowercase() != "none" && raw_eta != "--" {
                            raw_eta
                        } else if percent > 1.0 {
                            let elapsed = download_start_time.elapsed().as_secs_f32();
                            let remaining_secs = ((elapsed * (100.0 - percent)) / percent).round() as u64;
                            if remaining_secs > 3600 {
                                format!("{:02}:{:02}:{:02}", remaining_secs / 3600, (remaining_secs % 3600) / 60, remaining_secs % 60)
                            } else {
                                format!("{:02}:{:02}", remaining_secs / 60, remaining_secs % 60)
                            }
                        } else {
                            "Calculating...".to_string()
                        };

                        let status = DownloadStatus::Downloading;

                        let now = std::time::Instant::now();
                        let should_emit_ipc = now.duration_since(last_ipc_emit) >= IPC_EMIT_INTERVAL
                            || (percent - last_ipc_percent).abs() >= 1.0
                            || percent >= 99.0;

                        if should_emit_ipc {
                            last_ipc_emit = now;
                            last_ipc_percent = percent;
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
                                    downloaded_bytes,
                                    total_bytes,
                                },
                            );
                        }

                        // F-24: Throttle DB writes — status change flushes
                        // immediately, otherwise at most once per second.
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
                    is_postprocessing_stdout.store(true, std::sync::atomic::Ordering::SeqCst);
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
                            downloaded_bytes: None,
                            total_bytes: None,
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
                    downloaded_bytes: None,
                    total_bytes: None,
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
                    downloaded_bytes: None,
                    total_bytes: None,
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
pub async fn pause_download(
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
            downloaded_bytes: None,
            total_bytes: None,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn cancel_download(
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
            downloaded_bytes: None,
            total_bytes: None,
        },
    );

    Ok(())
}
