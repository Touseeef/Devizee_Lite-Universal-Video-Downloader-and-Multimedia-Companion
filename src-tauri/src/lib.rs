use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

pub(crate) mod db;
pub mod bridge;
pub mod download;
pub mod engine;
pub mod metadata;
pub mod status;
pub use download::{cancel_download, cleanup_orphan_parts, pause_download, start_download, DownloadProgressPayload};
pub use engine::{compute_file_sha256, get_ffmpeg_path, get_yt_dlp_path};
pub use metadata::{cookies_args, is_known_drm_service, Chapter, FormatOption, PlaylistEntry, PlaylistInfo, VideoInfo};
pub use status::DownloadStatus;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;


/// F-20: Run a Command with a hard timeout. Kills the process tree if it
/// doesn't complete in time. Prevents UI freezes when yt-dlp hangs on a
/// slow/dead server during metadata fetch, playlist enumeration, or search.
pub(crate) fn run_command_with_timeout(
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




/// Closes the application completely when the user closes the window with minimizeToTray disabled.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
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


pub struct AppState {
    pub db_conn: std::sync::Mutex<rusqlite::Connection>,
    pub active_processes: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, u32>>>,
    // ─── F-09: Concurrency gate ───
    // Caps the number of yt-dlp child processes running at once. Prevents
    // CPU/disk thrashing when the user queues dozens of downloads rapidly.
    // Hardcoded to 3 for Wave 1. Dynamic configuration comes in Wave 2.
    pub download_semaphore: std::sync::Arc<tokio::sync::Semaphore>,
}

/// F-10: Verify a PID still belongs to one of our known sidecar binaries
/// before we taskkill it. Prevents killing an innocent process when Windows
/// has recycled the PID between read and kill.
#[cfg(target_os = "windows")]
pub(crate) fn is_safe_to_kill(pid: u32) -> bool {
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
pub(crate) fn is_safe_to_kill(_pid: u32) -> bool {
    true
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
pub struct LocalMediaFile {
    pub id: String,
    pub title: String,
    pub file_path: String,
    pub format: String,
    pub is_audio: bool,
    pub file_size: u64,
    pub modified_time: i64,
}

#[tauri::command]
fn scan_local_folder(path: String) -> Result<Vec<LocalMediaFile>, String> {
    let root = PathBuf::from(path.trim());
    if !root.exists() || !root.is_dir() {
        return Err("Specified path does not exist or is not a directory".to_string());
    }

    let mut results: Vec<LocalMediaFile> = Vec::new();

    fn process_dir(dir: &std::path::Path, results: &mut Vec<LocalMediaFile>, depth: usize) {
        if depth > 3 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if !name.starts_with('.') && name != "node_modules" && name != "$RECYCLE.BIN" {
                        process_dir(&p, results, depth + 1);
                    }
                }
            } else if p.is_file() {
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();

                let is_vid = matches!(
                    ext.as_str(),
                    "mp4" | "mkv" | "webm" | "avi" | "mov" | "m4v" | "flv" | "wmv" | "ts" | "3gp"
                );
                let is_aud = matches!(
                    ext.as_str(),
                    "mp3" | "m4a" | "flac" | "wav" | "aac" | "opus" | "ogg" | "wma"
                );

                if is_vid || is_aud {
                    let title = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Untitled")
                        .to_string();

                    let metadata = std::fs::metadata(&p).ok();
                    let file_size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                    let modified_time = metadata
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);

                    let format_label = if is_vid {
                        match ext.as_str() {
                            "mov" => "MOV (iPhone/Apple Video)".to_string(),
                            "mp4" => "MP4 Video".to_string(),
                            "mkv" => "MKV Video".to_string(),
                            "webm" => "WebM Video".to_string(),
                            "avi" => "AVI Video".to_string(),
                            _ => format!("{} Video", ext.to_uppercase()),
                        }
                    } else {
                        match ext.as_str() {
                            "mp3" => "MP3 Audio".to_string(),
                            "m4a" => "M4A Audio (AAC)".to_string(),
                            "flac" => "FLAC Audio (Lossless)".to_string(),
                            "wav" => "WAV Audio".to_string(),
                            _ => format!("{} Audio", ext.to_uppercase()),
                        }
                    };

                    use std::hash::{Hash, Hasher};
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    p.to_string_lossy().hash(&mut hasher);
                    let id = format!("local-{:x}", hasher.finish());

                    results.push(LocalMediaFile {
                        id,
                        title,
                        file_path: p.to_string_lossy().to_string(),
                        format: format_label,
                        is_audio: is_aud,
                        file_size,
                        modified_time,
                    });
                }
            }
        }
    }

    process_dir(&root, &mut results, 0);
    results.sort_by(|a, b| b.modified_time.cmp(&a.modified_time));
    Ok(results)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
                } else if arg.starts_with("streamgrab://download?url=") || arg.starts_with("devizee://download?url=") {
                    // F-27: hardened deep-link validation.
                    // - Reject any URL containing a null byte (truncation trick)
                    // - Reject any URL with control characters
                    // - Reject anything that isn't http/https after ONE decode pass
                    // - Cap length to prevent DoS via giant pasted URLs
                    let raw = if arg.starts_with("devizee://download?url=") {
                        arg.trim_start_matches("devizee://download?url=")
                    } else {
                        arg.trim_start_matches("streamgrab://download?url=")
                    };

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
            bridge::start_local_http_bridge(app.handle().clone(), 42421);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            metadata::fetch_video_info,
            metadata::fetch_playlist_info,
            metadata::search_youtube,
            metadata::get_audio_stream_url,
            metadata::get_video_stream_url,
            download::start_download,
            download::pause_download,
            download::cancel_download,
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
            download::cleanup_orphan_parts,
            exit_app,
            engine::get_engine_info,
            engine::check_engine_update,
            engine::update_engine,
            bridge::get_installed_browsers,
            scan_local_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
