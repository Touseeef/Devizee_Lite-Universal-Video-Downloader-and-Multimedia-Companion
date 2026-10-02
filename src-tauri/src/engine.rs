use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// SC-3: SHA-256 fingerprint of a file. Used for TOFU (trust-on-first-use)
/// tamper detection on sidecar binaries. Returns None if the file can't be
/// read — caller treats that as "verification skipped."
pub fn compute_file_sha256(path: &Path) -> Option<String> {
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
pub fn get_yt_dlp_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

    // 5. Check installed user directory in %LOCALAPPDATA%\Devizee Lite
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let install_dir = local_app_data.join("Devizee Lite");
        let candidates = [
            install_dir.join("yt-dlp.exe"),
            install_dir.join("bin").join("yt-dlp.exe"),
            install_dir.join("yt-dlp-x86_64-pc-windows-msvc.exe"),
            install_dir.join("bin").join("yt-dlp-x86_64-pc-windows-msvc.exe"),
        ];
        for path in candidates {
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // SC-3: refuse to fall back to system PATH.
    Err("Could not locate yt-dlp.exe in any trusted location. \
         Please reinstall Devizee."
        .to_string())
}

/// Helper function to locate the ffmpeg binary (Absolute Paths)
pub fn get_ffmpeg_path(app: &tauri::AppHandle) -> Option<PathBuf> {
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
    if let Some(path) = dev_candidates.into_iter().find(|path| path.exists()) {
        return Some(path);
    }

    // 4. Check installed user directory in %LOCALAPPDATA%\Devizee Lite
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let install_dir = local_app_data.join("Devizee Lite");
        let candidates = [
            install_dir.join("ffmpeg.exe"),
            install_dir.join("bin").join("ffmpeg.exe"),
            install_dir.join("ffmpeg-x86_64-pc-windows-msvc.exe"),
            install_dir.join("bin").join("ffmpeg-x86_64-pc-windows-msvc.exe"),
        ];
        for path in candidates {
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
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
pub async fn get_engine_info(app: tauri::AppHandle) -> Result<EngineInfo, String> {
    let yt_dlp_path = get_yt_dlp_path(&app)?;
    let mut cmd = Command::new(&yt_dlp_path);
    cmd.arg("--version");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let output = crate::run_command_with_timeout(cmd, 10, "yt-dlp version check")?;
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
pub async fn check_engine_update(app: tauri::AppHandle) -> Result<EngineUpdateCheck, String> {
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
pub async fn update_engine(app: tauri::AppHandle) -> Result<EngineUpdateResult, String> {
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

    let verify_output = crate::run_command_with_timeout(verify_cmd, 10, "verify new yt-dlp binary")
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
