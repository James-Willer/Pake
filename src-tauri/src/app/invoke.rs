use crate::util::{check_file_or_append, get_download_message_with_lang, show_toast, MessageType};
use std::fs::{self, File};
use std::io::Write;
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, Ordering};
use tauri::http::Method;
use tauri::{command, AppHandle, Manager, Url, WebviewWindow};
use tauri_plugin_http::reqwest::{ClientBuilder, Request};

#[cfg(target_os = "macos")]
use tauri::Theme;

static BADGE_COUNT: AtomicI64 = AtomicI64::new(0);
const MAX_BADGE_COUNT: i64 = 99_999;
const MAX_BADGE_LABEL_CHARS: usize = 16;

fn normalize_badge_count(count: Option<i64>) -> Option<i64> {
    count.filter(|n| (1..=MAX_BADGE_COUNT).contains(n))
}

fn normalize_badge_label(label: Option<&str>) -> Result<Option<String>, String> {
    let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) else {
        return Ok(None);
    };

    if label.chars().count() > MAX_BADGE_LABEL_CHARS {
        return Err(format!(
            "Badge label must be {MAX_BADGE_LABEL_CHARS} characters or fewer"
        ));
    }

    Ok(Some(label.to_string()))
}

fn apply_badge(app: &AppHandle, count: Option<i64>) -> Result<(), String> {
    let label = normalize_badge_count(count).map(|n| n.to_string());
    apply_badge_label(app, label.as_deref())
}

#[cfg(target_os = "macos")]
fn apply_badge_label(app: &AppHandle, label: Option<&str>) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;

    let label = label.map(str::to_owned);
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let dock_tile = NSApplication::sharedApplication(mtm).dockTile();
        let ns_label = label.as_deref().map(NSString::from_str);
        dock_tile.setBadgeLabel(ns_label.as_deref());
    })
    .map_err(|e| format!("Failed to dispatch dock badge update: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn apply_badge_label(app: &AppHandle, label: Option<&str>) -> Result<(), String> {
    let window = app
        .get_webview_window("pake")
        .ok_or("Main window not found")?;
    let count = label.and_then(|s| s.parse::<i64>().ok());
    window
        .set_badge_count(count)
        .map_err(|e| format!("Failed to set badge count: {e}"))
}

#[derive(serde::Deserialize)]
pub struct DownloadFileParams {
    url: String,
    filename: String,
    language: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct BinaryDownloadParams {
    filename: String,
    binary: Vec<u8>,
    language: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct NotificationParams {
    title: String,
    body: String,
    icon: String,
}

#[command]
pub async fn download_file(app: AppHandle, params: DownloadFileParams) -> Result<(), String> {
    let window: WebviewWindow = app.get_webview_window("pake").ok_or("Window not found")?;

    show_toast(
        &window,
        &get_download_message_with_lang(MessageType::Start, params.language.clone()),
    );

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Failed to get download dir: {}", e))?;

    let output_path = download_dir.join(&params.filename);

    let path_str = output_path.to_str().ok_or("Invalid output path")?;

    let file_path = check_file_or_append(path_str);

    let client = ClientBuilder::new()
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let url = Url::from_str(&params.url).map_err(|e| format!("Invalid URL: {}", e))?;

    let request = Request::new(Method::GET, url);

    let response = client.execute(request).await;

    match response {
        Ok(mut res) => {
            let mut file =
                File::create(file_path).map_err(|e| format!("Failed to create file: {}", e))?;

            while let Some(chunk) = res
                .chunk()
                .await
                .map_err(|e| format!("Failed to get chunk: {}", e))?
            {
                file.write_all(&chunk)
                    .map_err(|e| format!("Failed to write chunk: {}", e))?;
            }

            show_toast(
                &window,
                &get_download_message_with_lang(MessageType::Success, params.language.clone()),
            );
            Ok(())
        }
        Err(e) => {
            show_toast(
                &window,
                &get_download_message_with_lang(MessageType::Failure, params.language),
            );
            Err(e.to_string())
        }
    }
}

#[command]
pub async fn download_file_by_binary(
    app: AppHandle,
    params: BinaryDownloadParams,
) -> Result<(), String> {
    let window: WebviewWindow = app.get_webview_window("pake").ok_or("Window not found")?;

    show_toast(
        &window,
        &get_download_message_with_lang(MessageType::Start, params.language.clone()),
    );

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Failed to get download dir: {}", e))?;

    let output_path = download_dir.join(&params.filename);

    let path_str = output_path.to_str().ok_or("Invalid output path")?;

    let file_path = check_file_or_append(path_str);

    match fs::write(file_path, &params.binary) {
        Ok(_) => {
            show_toast(
                &window,
                &get_download_message_with_lang(MessageType::Success, params.language.clone()),
            );
            Ok(())
        }
        Err(e) => {
            show_toast(
                &window,
                &get_download_message_with_lang(MessageType::Failure, params.language),
            );
            Err(e.to_string())
        }
    }
}

#[command]
pub fn send_notification(app: AppHandle, params: NotificationParams) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&params.title)
        .body(&params.body)
        .icon(&params.icon)
        .show()
        .map_err(|e| format!("Failed to show notification: {}", e))?;
    Ok(())
}

#[command]
pub fn set_dock_badge(app: AppHandle, count: Option<i64>) -> Result<(), String> {
    let normalized = normalize_badge_count(count);
    BADGE_COUNT.store(normalized.unwrap_or(0), Ordering::SeqCst);
    apply_badge(&app, normalized)
}

#[command]
pub fn increment_dock_badge(app: AppHandle) -> Result<(), String> {
    let current = BADGE_COUNT.load(Ordering::SeqCst);
    let next = current.saturating_add(1).clamp(1, MAX_BADGE_COUNT);
    BADGE_COUNT.store(next, Ordering::SeqCst);
    apply_badge(&app, Some(next))
}

#[command]
pub fn clear_dock_badge(app: AppHandle) -> Result<(), String> {
    BADGE_COUNT.store(0, Ordering::SeqCst);
    apply_badge(&app, None)
}

#[command]
pub fn set_dock_badge_label(app: AppHandle, label: Option<String>) -> Result<(), String> {
    BADGE_COUNT.store(0, Ordering::SeqCst);
    let label = normalize_badge_label(label.as_deref())?;
    apply_badge_label(&app, label.as_deref())
}

#[command]
pub async fn update_theme_mode(app: AppHandle, mode: String) {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_webview_window("pake") {
            let theme = if mode == "dark" {
                Theme::Dark
            } else {
                Theme::Light
            };
            let _ = window.set_theme(Some(theme));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = mode;
    }
}

#[command]
#[allow(unreachable_code)]
pub fn clear_cache_and_restart(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pake") {
        match window.clear_all_browsing_data() {
            Ok(_) => {
                // Clear all browsing data successfully
                app.restart();
                Ok(())
            }
            Err(e) => {
                eprintln!("Failed to clear browsing data: {}", e);
                Err(format!("Failed to clear browsing data: {}", e))
            }
        }
    } else {
        Err("Main window not found".to_string())
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct UserScript {
    pub id: String,
    pub name: String,
    pub code: String,
    pub enabled: bool,
    #[serde(default)]
    pub resources: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub settings: std::collections::HashMap<String, serde_json::Value>,
}

#[command]
pub fn get_userscripts(app: AppHandle) -> Result<Vec<UserScript>, String> {
    let (_, tauri_config) = crate::util::get_pake_config();
    let package_name = tauri_config.product_name.clone().unwrap_or_else(|| "pake".to_string());
    let data_dir = crate::util::get_data_dir(&app, package_name).map_err(|e| e.to_string())?;
    let file_path = data_dir.join("userscripts.json");

    if !file_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let scripts: Vec<UserScript> = serde_json::from_str(&content).unwrap_or_else(|_| Vec::new());
    Ok(scripts)
}

#[command]
pub fn save_userscript(app: AppHandle, script: UserScript) -> Result<(), String> {
    let (_, tauri_config) = crate::util::get_pake_config();
    let package_name = tauri_config.product_name.clone().unwrap_or_else(|| "pake".to_string());
    let data_dir = crate::util::get_data_dir(&app, package_name).map_err(|e| e.to_string())?;
    let file_path = data_dir.join("userscripts.json");

    let mut scripts = get_userscripts(app.clone())?;
    if let Some(pos) = scripts.iter().position(|s| s.id == script.id) {
        scripts[pos] = script;
    } else {
        scripts.push(script);
    }

    let content = serde_json::to_string_pretty(&scripts).map_err(|e| e.to_string())?;
    fs::write(file_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub fn delete_userscript(app: AppHandle, id: String) -> Result<(), String> {
    let (_, tauri_config) = crate::util::get_pake_config();
    let package_name = tauri_config.product_name.clone().unwrap_or_else(|| "pake".to_string());
    let data_dir = crate::util::get_data_dir(&app, package_name).map_err(|e| e.to_string())?;
    let file_path = data_dir.join("userscripts.json");

    let mut scripts = get_userscripts(app.clone())?;
    scripts.retain(|s| s.id != id);

    let content = serde_json::to_string_pretty(&scripts).map_err(|e| e.to_string())?;
    fs::write(file_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub fn toggle_userscript(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let (_, tauri_config) = crate::util::get_pake_config();
    let package_name = tauri_config.product_name.clone().unwrap_or_else(|| "pake".to_string());
    let data_dir = crate::util::get_data_dir(&app, package_name).map_err(|e| e.to_string())?;
    let file_path = data_dir.join("userscripts.json");

    let mut scripts = get_userscripts(app.clone())?;
    if let Some(pos) = scripts.iter().position(|s| s.id == id) {
        scripts[pos].enabled = enabled;
    }

    let content = serde_json::to_string_pretty(&scripts).map_err(|e| e.to_string())?;
    fs::write(file_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub async fn open_userscript_manager(app: AppHandle) -> Result<(), String> {
    if let Some(existing_window) = app.get_webview_window("userscript-manager") {
        let _ = existing_window.unminimize();
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    let url_str = "http://userscript.localhost";
    #[cfg(not(target_os = "windows"))]
    let url_str = "userscript://localhost";

    let url = Url::parse(url_str).map_err(|e| e.to_string())?;

    let _window = tauri::WebviewWindowBuilder::new(&app, "userscript-manager", tauri::WebviewUrl::External(url))
        .title("Userscript Manager")
        .inner_size(800.0, 600.0)
        .resizable(true)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[command]
pub async fn fetch_remote_script(url: String) -> Result<String, String> {
    let client = ClientBuilder::new()
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let parsed_url = Url::from_str(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    let request = Request::new(Method::GET, parsed_url);

    let mut response = client.execute(request).await.map_err(|e| e.to_string())?;
    
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to get chunk: {}", e))?
    {
        body.extend_from_slice(&chunk);
    }
    
    let text = String::from_utf8(body).map_err(|e| format!("Invalid UTF-8 content: {}", e))?;
    Ok(text)
}

#[command]
pub fn save_userscript_setting(
    app: AppHandle,
    script_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut scripts = get_userscripts(app.clone())?;
    if let Some(pos) = scripts.iter().position(|s| s.id == script_id) {
        scripts[pos].settings.insert(key, value);
        
        let (_, tauri_config) = crate::util::get_pake_config();
        let package_name = tauri_config.product_name.clone().unwrap_or_else(|| "pake".to_string());
        let data_dir = crate::util::get_data_dir(&app, package_name).map_err(|e| e.to_string())?;
        let file_path = data_dir.join("userscripts.json");
        
        let content = serde_json::to_string_pretty(&scripts).map_err(|e| e.to_string())?;
        fs::write(file_path, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct HttpRequestDetails {
    pub url: String,
    pub method: String,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
}

#[derive(serde::Serialize)]
pub struct HttpResponseDetails {
    pub status: u16,
    pub status_text: String,
    pub headers: std::collections::HashMap<String, String>,
    pub response_text: String,
}

#[command]
pub async fn gm_xmlhttprequest(
    details: HttpRequestDetails
) -> Result<HttpResponseDetails, String> {
    let client = ClientBuilder::new()
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let parsed_url = Url::from_str(&details.url).map_err(|e| format!("Invalid URL: {}", e))?;
    let method = Method::from_str(&details.method.to_uppercase()).map_err(|e| format!("Invalid method: {}", e))?;
    
    let mut request = Request::new(method, parsed_url);

    if let Some(headers) = details.headers {
        let req_headers = request.headers_mut();
        for (k, v) in headers {
            if let (Ok(name), Ok(val)) = (tauri::http::header::HeaderName::from_str(&k), tauri::http::header::HeaderValue::from_str(&v)) {
                req_headers.insert(name, val);
            }
        }
    }

    if let Some(body) = details.body {
        *request.body_mut() = Some(body.into_bytes().into());
    }

    let mut response = client.execute(request).await.map_err(|e| e.to_string())?;
    
    let status = response.status().as_u16();
    let status_text = response.status().canonical_reason().unwrap_or("").to_string();
    
    let mut resp_headers = std::collections::HashMap::new();
    for (name, val) in response.headers().iter() {
        if let Ok(val_str) = val.to_str() {
            resp_headers.insert(name.to_string(), val_str.to_string());
        }
    }

    let mut body_bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to get chunk: {}", e))?
    {
        body_bytes.extend_from_slice(&chunk);
    }
    
    let response_text = String::from_utf8_lossy(&body_bytes).into_owned();

    Ok(HttpResponseDetails {
        status,
        status_text,
        headers: resp_headers,
        response_text,
    })
}

