use std::io::{Read, Write};
use tauri::{Emitter, Manager};

/// Detects installed web browsers on the user's PC for one-click session authentication
#[tauri::command]
pub fn get_installed_browsers() -> Vec<String> {
    let mut browsers = Vec::new();
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let app_data = std::env::var("APPDATA").unwrap_or_default();

    if !local_app_data.is_empty() {
        let p = std::path::Path::new(&local_app_data);
        if p.join("Google").join("Chrome").join("User Data").exists() {
            browsers.push("chrome".to_string());
        }
        if p.join("Microsoft").join("Edge").join("User Data").exists() {
            browsers.push("edge".to_string());
        }
        if p.join("BraveSoftware").join("Brave-Browser").join("User Data").exists() {
            browsers.push("brave".to_string());
        }
        if p.join("Vivaldi").join("User Data").exists() {
            browsers.push("vivaldi".to_string());
        }
    }

    if !app_data.is_empty() {
        let p = std::path::Path::new(&app_data);
        if p.join("Mozilla").join("Firefox").join("Profiles").exists() {
            browsers.push("firefox".to_string());
        }
        if p.join("Opera Software").join("Opera Stable").exists() {
            browsers.push("opera".to_string());
        }
    }

    browsers
}

/// Spawns a lightweight local HTTP server bound exclusively to 127.0.0.1:42421.
/// Allows the Devizee browser extension to communicate seamlessly with zero configuration.
pub fn start_local_http_bridge(app_handle: tauri::AppHandle, port: u16) {
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
        Some(o) => o.starts_with("chrome-extension://") || o.starts_with("moz-extension://") || o == "null",
        None => true, // Direct loopback service worker or extension call without Origin
    };

    let is_authenticated_token = match token_header.as_deref() {
        Some(t) => t == expected_token,
        None => false,
    };

    // If an external web page attempts cross-origin access, reject immediately with 403 Forbidden!
    if let Some(ref o) = origin {
        if !o.starts_with("chrome-extension://") && !o.starts_with("moz-extension://") && o != "null" {
            let resp = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Cross-origin web requests are blocked.";
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
            return;
        }
    }

    let allowed_origin = origin.unwrap_or_else(|| "*".to_string());
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
        let app_version = app.package_info().version.to_string();
        let body = serde_json::json!({
            "status": "ok",
            "app": "Devizee Lite",
            "port": 42421,
            "version": app_version
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

    if path == "/history" {
        if let Some(state) = app.try_state::<crate::AppState>() {
            if let Ok(conn) = state.db_conn.lock() {
                if let Ok(recs) = crate::db::get_all_downloads(&conn) {
                    let body = serde_json::to_string(&recs).unwrap_or_else(|_| "[]".to_string());
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
        }
        let body = "[]";
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

    if method == "POST" && path == "/open-file" {
        if let Some(body_start) = req.find("\r\n\r\n") {
            let body = &req[body_start + 4..];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app.opener().open_path(p, None::<&str>);
                }
            }
        }
        let body = serde_json::json!({"success": true}).to_string();
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

    if method == "POST" && path == "/open-folder" {
        if let Some(body_start) = req.find("\r\n\r\n") {
            let body = &req[body_start + 4..];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(p) = v.get("path").and_then(|x| x.as_str()) {
                    use tauri_plugin_opener::OpenerExt;
                    let path_obj = std::path::Path::new(p);
                    if path_obj.is_file() {
                        let _ = app.opener().reveal_item_in_dir(p);
                    } else {
                        let _ = app.opener().open_path(p, None::<&str>);
                    }
                }
            }
        }
        let body = serde_json::json!({"success": true}).to_string();
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
                if crate::is_known_drm_service(&clean_url) {
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

    if method == "POST" && (path == "/batch-download" || path == "/batch") {
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

        let mut target_urls: Vec<String> = Vec::new();

        if let Some(body_start) = req.find("\r\n\r\n") {
            let body = &req[body_start + 4..];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                if let Some(arr) = v.get("urls").and_then(|x| x.as_array()) {
                    for u in arr {
                        if let Some(s) = u.as_str() {
                            let clean = s.trim().to_string();
                            if (clean.starts_with("http://") || clean.starts_with("https://"))
                                && !crate::is_known_drm_service(&clean)
                            {
                                target_urls.push(clean);
                            }
                        }
                    }
                }
            }
        }

        if !target_urls.is_empty() {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let count = target_urls.len();
            let _ = app.emit("open-batch-urls", target_urls);

            let body = serde_json::json!({"status": "queued", "count": count}).to_string();
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

        let body = serde_json::json!({"error": "no valid urls provided"}).to_string();
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
