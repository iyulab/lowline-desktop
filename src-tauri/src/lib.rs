mod credentials;
mod host;
mod navigation;
mod report;
mod update;
mod vault;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_kit_watch::{ChangeKind, Notice, Watch, Watcher};

use host::{HostState, HostStatus};
use vault::{
    Entry, Vault, VaultError, DOCUMENTS_DIR, DOCUMENT_SUFFIX, TEMPLATES_DIR, TEMPLATE_SUFFIX,
};

/// The open vault and the watch on it. The shell is the only place that touches files.
#[derive(Default)]
struct AppState {
    vault: Mutex<Option<Vault>>,
    watcher: Mutex<Option<Watcher>>,
    /// Held while a vault is opened, so opening the last vault on launch never crosses one opened otherwise.
    opening: Mutex<()>,
}

/// What a command failure looks like to the UI.
#[derive(Debug, Serialize)]
struct CommandError {
    kind: &'static str,
    message: String,
}

impl From<VaultError> for CommandError {
    fn from(e: VaultError) -> Self {
        CommandError {
            kind: e.kind(),
            message: e.to_string(),
        }
    }
}

type CommandResult<T> = Result<T, CommandError>;

fn no_vault() -> CommandError {
    CommandError {
        kind: "no-vault",
        message: "no vault is open".into(),
    }
}

fn with_vault<T>(
    state: &State<AppState>,
    f: impl FnOnce(&Vault) -> vault::Result<T>,
) -> CommandResult<T> {
    let guard = state.vault.lock().expect("vault state poisoned");
    let vault = guard.as_ref().ok_or_else(no_vault)?;
    Ok(f(vault)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultInfo {
    root: String,
    name: String,
    templates_dir: &'static str,
    documents_dir: &'static str,
}

#[tauri::command]
fn open_vault(path: String, app: AppHandle, state: State<AppState>) -> CommandResult<VaultInfo> {
    let _opening = state.opening.lock().expect("opening state poisoned");
    open_into(&path, &app, &state)
}

/// Where the app was last used — its vault and the place showing, as the UI wrote them. Kept on this
/// device, outside any vault: the next launch opens where the person left off.
fn session_file(app: &AppHandle) -> std::io::Result<PathBuf> {
    let dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn write_session(session: String, app: AppHandle) -> CommandResult<()> {
    let file = session_file(&app).map_err(io_error)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(io_error)?;
    }
    tauri_kit_fs::write_atomic(&file, session.as_bytes()).map_err(io_error)
}

/// How Lowline is set up on this device, as the UI wrote it — kept with the session, outside any vault.
fn settings_file(app: &AppHandle) -> std::io::Result<PathBuf> {
    let dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    Ok(dir.join("settings.json"))
}

/// This device's settings; none before any was written.
#[tauri::command]
fn read_settings(app: AppHandle) -> CommandResult<Option<String>> {
    match std::fs::read_to_string(settings_file(&app).map_err(io_error)?) {
        Ok(settings) => Ok(Some(settings)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}

#[tauri::command]
fn write_settings(settings: String, app: AppHandle) -> CommandResult<()> {
    let file = settings_file(&app).map_err(io_error)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(io_error)?;
    }
    tauri_kit_fs::write_atomic(&file, settings.as_bytes()).map_err(io_error)
}

#[derive(Serialize)]
struct Resumed {
    vault: VaultInfo,
    /// The session as the UI wrote it.
    session: String,
}

/// Opens the vault the app was last using, while no vault is open: nothing when there is no session,
/// its vault cannot be opened (moved, a share out of reach), or a vault was opened first.
#[tauri::command]
fn resume_vault(app: AppHandle, state: State<AppState>) -> CommandResult<Option<Resumed>> {
    let Ok(session) = std::fs::read_to_string(session_file(&app).map_err(io_error)?) else {
        return Ok(None);
    };
    let path = serde_json::from_str::<serde_json::Value>(&session)
        .ok()
        .and_then(|v| v.get("vault")?.as_str().map(str::to_owned));
    let Some(path) = path else { return Ok(None) };
    let _opening = state.opening.lock().expect("opening state poisoned");
    if state.vault.lock().expect("vault state poisoned").is_some() {
        return Ok(None);
    }
    Ok(open_into(&path, &app, &state)
        .ok()
        .map(|vault| Resumed { vault, session }))
}

fn open_into(path: &str, app: &AppHandle, state: &State<AppState>) -> CommandResult<VaultInfo> {
    let vault = Vault::open(&PathBuf::from(path))?;
    let root = vault.root();
    let info = VaultInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        templates_dir: TEMPLATES_DIR,
        documents_dir: DOCUMENTS_DIR,
    };
    // The previous vault's watch stops before the next one starts.
    state.watcher.lock().expect("watch state poisoned").take();
    let watcher = watch_vault(app, &vault)
        .inspect_err(|e| {
            eprintln!("the vault is not watched, outside edits show on the next read: {e}")
        })
        .ok();
    *state.vault.lock().expect("vault state poisoned") = Some(vault);
    *state.watcher.lock().expect("watch state poisoned") = watcher;
    Ok(info)
}

/// Whether a folder holds nothing: a new vault is made only in an empty one, so nobody's files end up
/// beside the sample the app puts there.
#[tauri::command]
fn folder_is_empty(path: String) -> CommandResult<bool> {
    Ok(std::fs::read_dir(&path)
        .map_err(VaultError::from)?
        .next()
        .is_none())
}

/// Where the app keeps files of its own in a vault that are not the user's: probe files of the
/// watch. Nothing in it is reported.
const TMP_DIR: &str = ".lowline/tmp";

/// How often the watch checks that it still hears the vault.
const PROBE_EVERY: Duration = Duration::from_secs(300);

/// What changed in the vault, as the UI is told: paths relative to the vault, `/`-separated.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VaultChanged {
    /// Changes were lost: everything shown may be stale and is read again.
    rescan: bool,
    written: Vec<String>,
    removed: Vec<String>,
}

impl From<Notice> for VaultChanged {
    fn from(notice: Notice) -> Self {
        let mut changed = VaultChanged {
            rescan: false,
            written: Vec::new(),
            removed: Vec::new(),
        };
        match notice {
            Notice::Rescan => changed.rescan = true,
            Notice::Changed(changes) => {
                for change in changes {
                    let path = slashed(&change.path);
                    match change.kind {
                        ChangeKind::Written => changed.written.push(path),
                        ChangeKind::Removed => changed.removed.push(path),
                    }
                }
            }
        }
        changed
    }
}

fn slashed(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether a change at `rel` is none of the app's business. The vault folder may be shared with
/// other programs — another notes app keeps its own files there, a sync client its state — and
/// only the places the app reads count: templates, documents and other devices' event files. This
/// device's event file is appended to by this app alone, and its temporary files are its own.
fn ignored(rel: &Path, own_events: Option<&Path>) -> bool {
    let read = [TEMPLATES_DIR, DOCUMENTS_DIR, EVENTS_DIR];
    !read.iter().any(|dir| rel.starts_with(dir)) || own_events == Some(rel)
}

/// Watches the vault for edits made outside the app — another editor, a sync client, another
/// device — and tells the UI. This app's own writes are left out, and so is this device's event
/// file, which only this app appends to.
fn watch_vault(app: &AppHandle, vault: &Vault) -> std::io::Result<Watcher> {
    let _ = tauri_kit_fs::sweep_staging(&vault.root().join(TMP_DIR), Duration::from_secs(3600));
    let own_events = device_id(app)
        .ok()
        .map(|d| PathBuf::from(format!("{EVENTS_DIR}/{d}.jsonl")));
    let app = app.clone();
    Watch::new(vault.root())
        .own_writes(vault.own_writes())
        .ignore(move |rel| ignored(rel, own_events.as_deref()))
        .probe_liveness(TMP_DIR, PROBE_EVERY)
        .start(move |notice| {
            let _ = app.emit("vault-changed", VaultChanged::from(notice));
        })
}

#[tauri::command]
fn list_templates(state: State<AppState>) -> CommandResult<Vec<Entry>> {
    with_vault(&state, |v| v.list(TEMPLATES_DIR, TEMPLATE_SUFFIX))
}

#[tauri::command]
fn list_documents(state: State<AppState>) -> CommandResult<Vec<Entry>> {
    with_vault(&state, |v| v.list(DOCUMENTS_DIR, DOCUMENT_SUFFIX))
}

#[tauri::command]
fn read_file(path: String, state: State<AppState>) -> CommandResult<String> {
    with_vault(&state, |v| v.read(&path))
}

/// Reads several files in one call: a full read of the vault would otherwise cross into the shell
/// once per file. A file removed since it was listed comes back as `null`.
#[tauri::command]
fn read_files(paths: Vec<String>, state: State<AppState>) -> CommandResult<Vec<Option<String>>> {
    with_vault(&state, |v| v.read_many(&paths))
}

/// Replaces a file atomically.
#[tauri::command]
fn write_file(path: String, content: String, state: State<AppState>) -> CommandResult<()> {
    with_vault(&state, |v| v.write(&path, &content))
}

/// Replaces a file atomically while it still holds `expected`; fails with `changed-outside` otherwise.
#[tauri::command]
fn write_file_if_unchanged(
    path: String,
    expected: String,
    content: String,
    state: State<AppState>,
) -> CommandResult<()> {
    with_vault(&state, |v| v.write_if_unchanged(&path, &expected, &content))
}

/// Creates a file named `name` in `dir`, numbering the name when it is taken; never replaces one.
/// Returns the path it was created at.
#[tauri::command]
fn create_file(
    dir: String,
    name: String,
    content: String,
    state: State<AppState>,
) -> CommandResult<String> {
    with_vault(&state, |v| v.create(&dir, &name, &content))
}

/// Gives a file another name in its folder; fails with `already-exists` rather than replace one.
#[tauri::command]
fn rename_file(from: String, to: String, state: State<AppState>) -> CommandResult<()> {
    with_vault(&state, |v| v.rename(&from, &to))
}

/// Moves a file to the system's trash; fails with `not-trashed`, leaving it, where there is none.
#[tauri::command]
fn trash_file(path: String, state: State<AppState>) -> CommandResult<()> {
    with_vault(&state, |v| v.trash(&path))
}

/// Deletes a file for good — once the person has chosen that for a file the trash would not take.
/// In a debug build, `LOWLINE_EXPORT_TO` names a folder exports go to without the save dialog —
/// the end-to-end scenarios cannot answer a system dialog. Release builds always ask.
fn export_folder_for_tests() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("LOWLINE_EXPORT_TO").map(PathBuf::from)
    } else {
        None
    }
}

/// Saves `content` (an export — a table as CSV) where the person picks, offering `name` in the
/// system's save dialog. The file is chosen here, in the shell, so the page never names a path
/// outside the vault. Returns the chosen file's name, or `None` when the dialog was closed.
#[tauri::command]
async fn export_file(
    name: String,
    content: String,
    filter: String,
    extension: String,
    app: AppHandle,
) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let path = match export_folder_for_tests() {
        Some(folder) => folder.join(&name),
        None => {
            // An async command runs off the main thread, where the blocking dialog may wait.
            let Some(chosen) = app
                .dialog()
                .file()
                .set_file_name(&name)
                .add_filter(&filter, &[extension.as_str()])
                .blocking_save_file()
            else {
                return Ok(None);
            };
            chosen.into_path().map_err(|e| CommandError {
                kind: "export-failed",
                message: e.to_string(),
            })?
        }
    };
    tauri_kit_fs::write_atomic(&path, content.as_bytes()).map_err(|e| CommandError {
        kind: "export-failed",
        message: e.to_string(),
    })?;
    Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()))
}

#[tauri::command]
fn remove_file(path: String, state: State<AppState>) -> CommandResult<()> {
    with_vault(&state, |v| v.remove(&path))
}

/// Where this install's events go: one append-only file per device, so vaults shared through a
/// sync service never have two devices writing the same file.
const EVENTS_DIR: &str = ".lowline/events";

/// Appends one suggestion event (accept, correct or reject) to this device's event file in the vault.
#[tauri::command]
fn record_event(
    event: serde_json::Value,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> CommandResult<()> {
    if !event.is_object() {
        return Err(CommandError {
            kind: "io",
            message: "an event is a JSON object".into(),
        });
    }
    let device = device_id(&app).map_err(|e| CommandError {
        kind: "io",
        message: e.to_string(),
    })?;
    let line = event.to_string();
    with_vault(&state, |v| {
        v.append_line(&format!("{EVENTS_DIR}/{device}.jsonl"), &line)
    })
}

/// Every device's event file in the vault: what suggestions have learned was wrong.
#[tauri::command]
fn list_events(state: State<AppState>) -> CommandResult<Vec<Entry>> {
    with_vault(&state, |v| v.list(EVENTS_DIR, ".jsonl"))
}

/// Where this device keeps the suggestions it has shown, one file per vault. Outside the vault: they
/// are counted, never learned from, and a draft let go leaves nothing of itself in a shared vault.
fn presentations_file(app: &tauri::AppHandle, root: &Path) -> std::io::Result<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(std::io::Error::other)?;
    let name = format!("{:016x}.jsonl", fnv1a(root.to_string_lossy().as_bytes()));
    Ok(dir.join("presentations").join(name))
}

/// FNV-1a: a name for a vault that stays the same from one build to the next, which std's hasher
/// does not promise.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn io_error(e: std::io::Error) -> CommandError {
    CommandError {
        kind: "io",
        message: e.to_string(),
    }
}

/// Appends one suggestion shown to this device's record of them for the open vault.
#[tauri::command]
fn record_presentation(
    presentation: serde_json::Value,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> CommandResult<()> {
    if !presentation.is_object() {
        return Err(CommandError {
            kind: "io",
            message: "a presentation is a JSON object".into(),
        });
    }
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf()))?;
    let file = presentations_file(&app, &root).map_err(io_error)?;
    append_line(&file, &presentation.to_string()).map_err(io_error)
}

fn append_line(file: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    f.write_all(
        format!(
            "{line}
"
        )
        .as_bytes(),
    )
}

/// This device's record of the suggestions it has shown for the open vault; empty before the first.
#[tauri::command]
fn read_presentations(app: tauri::AppHandle, state: State<AppState>) -> CommandResult<String> {
    let root = with_vault(&state, |v| Ok(v.root().to_path_buf()))?;
    let file = presentations_file(&app, &root).map_err(io_error)?;
    match std::fs::read_to_string(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        other => other.map_err(io_error),
    }
}

/// This install's id, made on first use and kept outside any vault.
fn device_id(app: &tauri::AppHandle) -> std::io::Result<String> {
    let dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
    let path = dir.join("device-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim();
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let id = format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    );
    std::fs::create_dir_all(&dir)?;
    tauri_kit_fs::write_atomic_new(&path, id.as_bytes()).or_else(|e| match e.kind() {
        // Another window made it first: use theirs.
        std::io::ErrorKind::AlreadyExists => Ok(()),
        _ => Err(e),
    })?;
    Ok(std::fs::read_to_string(&path)?.trim().to_string())
}

/// Whether the sidecar is starting, ready, or failed to start. Async, so off the main thread: the window asks it
/// often, and a status that ever had to wait on the sidecar's state would hold the whole window with it.
#[tauri::command]
async fn host_status(state: State<'_, HostState>) -> Result<HostStatus, String> {
    Ok(state.status())
}

/// Hands the sidecar a snapshot of the open vault, as the UI parsed it. Returns what it changed.
#[tauri::command]
async fn host_ingest(
    snapshot: serde_json::Value,
    vault: State<'_, AppState>,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let path = {
        let guard = vault.vault.lock().expect("vault state poisoned");
        ingest_path(guard.as_ref().ok_or("no vault is open")?.root())
    };
    let client = state.client()?;
    let body = snapshot.to_string();
    host_json(
        blocking(move || {
            // What the last ingest's background work failed at is reported before the next one.
            report_host_failures(client.take_failures());
            client.post_json(&path, &body)
        })
        .await?,
    )
}

/// The ingest request for the vault at `root`: the sidecar keeps one projection cache per vault.
fn ingest_path(root: &Path) -> String {
    format!(
        "/vault/ingest?vault={}",
        encode_segment(&root.to_string_lossy())
    )
}

/// A template's documents as a table.
#[tauri::command]
async fn host_projection(
    template: String,
    filters: Option<serde_json::Value>,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = serde_json::json!({ "template": template, "filters": filters }).to_string();
    host_json(blocking(move || client.post_json("/projection", &body)).await?)
}

/// Counts of a template's documents per value of some fields, each with the documents it is made of.
#[tauri::command]
async fn host_aggregate(
    request: serde_json::Value,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = request.to_string();
    host_json(blocking(move || client.post_json("/aggregate", &body)).await?)
}

/// How the suggestions of each judgment field have fared, from the vault's event files.
#[tauri::command]
async fn host_curves(state: State<'_, HostState>) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    host_json(blocking(move || client.get("/curves")).await?)
}

/// Runs a request to the sidecar off the async runtime.
async fn blocking(
    request: impl FnOnce() -> Result<String, host::CallError> + Send + 'static,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(request)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            if let Some(failure) = call_failure(&e) {
                report(failure);
            }
            e.to_string()
        })
}

/// The report a failed call to the sidecar makes: what the sidecar said failed; or, when it said
/// nothing, its status or that it could not be reached. A 404 is an answer — there is nothing
/// there, such as a table of a template the sidecar does not hold — not a failure.
fn call_failure(error: &host::CallError) -> Option<report::Report> {
    match error {
        host::CallError::Failed(failure) => Some(report::new(
            report::Layer::Host,
            &failure.kind,
            &failure.frames.join("\n"),
        )),
        host::CallError::Status(404) => None,
        host::CallError::Status(status) => Some(report::with(
            report::Layer::Host,
            "HostAnswered",
            "",
            &[("status", &status.to_string())],
        )),
        host::CallError::Transport(_) => {
            Some(report::new(report::Layer::Host, "HostUnreachable", ""))
        }
    }
}

/// A suggestion for one judgment field of a document being filled in.
#[tauri::command]
async fn host_suggest(
    request: serde_json::Value,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = request.to_string();
    host_json(blocking(move || client.post_json("/suggest", &body)).await?)
}

/// What the sidecar is asked to check a model endpoint with (`ModelProbe`): the key, if one is kept, goes with it.
fn model_probe_body(preset: &str, base_url: Option<&str>, key: Option<&str>) -> String {
    serde_json::json!({ "preset": preset, "baseUrl": base_url, "apiKey": key }).to_string()
}

/// Whether a model endpoint the person named answers. `provider` names the key kept for it (`credentials.rs`):
/// the shell reads it from the credential store and hands it on with this one request; the window never sees it.
#[tauri::command]
async fn host_model_probe(
    app: AppHandle,
    preset: String,
    base_url: Option<String>,
    provider: String,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let key = credentials::model_key(&app, &provider).map_err(|e| e.to_string())?;
    let client = state.client()?;
    let body = model_probe_body(&preset, base_url.as_deref(), key.as_deref());
    host_json(blocking(move || client.post_json("/model/probe", &body)).await?)
}

/// The models Lowline can run on this computer for the chat, and where getting one ready stands.
#[tauri::command]
async fn host_local_models(state: State<'_, HostState>) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    host_json(blocking(move || client.get("/model/local")).await?)
}

/// Starts getting a model ready on this computer — fetching it, and the runtime that runs it, when they are not here.
/// The sidecar answers at once; `host_local_models` follows it.
#[tauri::command]
async fn host_local_prepare(
    model: String,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = serde_json::json!({ "model": model }).to_string();
    host_json(blocking(move || client.post_json("/model/local/prepare", &body)).await?)
}

/// What the chat beside a template asks the sidecar (`ChatAuthorRequest`): the model set up, the template's source,
/// the conversation — and the key, if one is kept, read here and handed on with this one request.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAuthor {
    preset: String,
    base_url: Option<String>,
    model: String,
    template: String,
    turns: Vec<serde_json::Value>,
    /// The blank form the person handed the chat to start from (`ChatSource`), when there is one.
    #[serde(default)]
    source: Option<serde_json::Value>,
}

fn chat_author_body(request: &ChatAuthor, key: Option<&str>) -> String {
    serde_json::json!({
        "preset": request.preset,
        "baseUrl": request.base_url,
        "apiKey": key,
        "model": request.model,
        "template": request.template,
        "turns": request.turns,
        "source": request.source,
    })
    .to_string()
}

/// A blank form the person picked — an HWP, HWPX or PDF file — read into Markdown by the sidecar, for the chat that
/// writes templates to start from (`SourceFileReply`). The file is read on this computer and sent nowhere.
#[tauri::command]
async fn host_source_file(
    path: String,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = serde_json::json!({ "path": path }).to_string();
    host_json(blocking(move || client.post_json("/files/markdown", &body)).await?)
}

/// A reply of the chat that writes templates. The key kept for the preset goes to the sidecar with this request only;
/// the window never sees it.
#[tauri::command]
async fn host_chat_author(
    app: AppHandle,
    request: ChatAuthor,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let key = credentials::model_key(&app, &request.preset).map_err(|e| e.to_string())?;
    let client = state.client()?;
    let body = chat_author_body(&request, key.as_deref());
    host_json(blocking(move || client.post_json("/chat/author", &body)).await?)
}

/// What the sidecar is asked to turn a question about a template's documents into a count with (`ChatQueryRequest`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatQuery {
    preset: String,
    base_url: Option<String>,
    model: String,
    template: String,
    question: String,
    /// The fields of the documents the template's fields refer to, as columns to count by (`ReferredColumn`).
    #[serde(default)]
    referred: Vec<serde_json::Value>,
    /// The templates whose documents refer to the template's own, as a question may count them (`ReferringTemplate`).
    #[serde(default)]
    referring: Vec<serde_json::Value>,
}

fn chat_query_body(request: &ChatQuery, key: Option<&str>) -> String {
    serde_json::json!({
        "preset": request.preset,
        "baseUrl": request.base_url,
        "apiKey": key,
        "model": request.model,
        "template": request.template,
        "question": request.question,
        "referred": request.referred,
        "referring": request.referring,
    })
    .to_string()
}

/// What the model set up says to count for a question about a template's documents — never the counts. The key kept
/// for the preset goes to the sidecar with this request only; the window never sees it.
#[tauri::command]
async fn host_chat_query(
    app: AppHandle,
    request: ChatQuery,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let key = credentials::model_key(&app, &request.preset).map_err(|e| e.to_string())?;
    let client = state.client()?;
    let body = chat_query_body(&request, key.as_deref());
    host_json(blocking(move || client.post_json("/chat/query", &body)).await?)
}

/// What the sidecar is asked to read records out of pasted text with (`ChatExtractRequest`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatExtract {
    preset: String,
    base_url: Option<String>,
    model: String,
    template: String,
    text: String,
}

fn chat_extract_body(request: &ChatExtract, key: Option<&str>) -> String {
    serde_json::json!({
        "preset": request.preset,
        "baseUrl": request.base_url,
        "apiKey": key,
        "model": request.model,
        "template": request.template,
        "text": request.text,
    })
    .to_string()
}

/// The records the model set up reads out of text pasted to bring them in. The key kept for the preset goes to the
/// sidecar with this request only; the window never sees it.
#[tauri::command]
async fn host_chat_extract(
    app: AppHandle,
    request: ChatExtract,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let key = credentials::model_key(&app, &request.preset).map_err(|e| e.to_string())?;
    let client = state.client()?;
    let body = chat_extract_body(&request, key.as_deref());
    host_json(blocking(move || client.post_json("/chat/extract", &body)).await?)
}

/// Documents whose values hold some words, from the sidecar's text index — of one template when named.
#[tauri::command]
async fn host_search(
    request: serde_json::Value,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = request.to_string();
    host_json(blocking(move || client.post_json("/search", &body)).await?)
}

/// The documents of the same template most like one, from the sidecar's text index.
#[tauri::command]
async fn host_similar(
    request: serde_json::Value,
    state: State<'_, HostState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let body = request.to_string();
    host_json(blocking(move || client.post_json("/similar", &body)).await?)
}

fn host_json(body: String) -> Result<serde_json::Value, String> {
    serde_json::from_str(&body)
        .map_err(|e| format!("the sidecar answered with something else than JSON: {e}"))
}

/// Percent-encodes everything outside the unreserved set (and `@`), so a template id is one segment.
fn encode_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'@' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Starts the sidecar off the main thread, so the window opens while it starts, and keeps it running:
/// a sidecar that ends is started again (see [`host`]) and, once it is back, told to the UI — it has
/// nothing of the vault, which the UI hands it again.
fn start_host(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let launcher = app.clone();
        let launch = move || {
            let path = launcher.path();
            let exe = host::executable(&path.resource_dir().map_err(|e| e.to_string())?);
            let log = path
                .app_log_dir()
                .map_err(|e| e.to_string())?
                .join("host.stderr.log");
            // Projection caches are this device's, outside any vault, and can always be rebuilt.
            let cache = path
                .app_local_data_dir()
                .map_err(|e| e.to_string())?
                .join("projections");
            host::launch(&exe, log, &cache)
        };
        let told = app.clone();
        let on_event = move |event| match event {
            host::Supervised::Restarted => {
                report(report::new(report::Layer::Host, "HostEnded", ""));
                let _ = told.emit(HOST_RESTARTED, ());
            }
            // Why it failed is a message, and messages do not leave the device: the kind says enough.
            host::Supervised::RestartFailed => {
                report(report::new(report::Layer::Host, "HostStartFailed", ""))
            }
            host::Supervised::Down => report(report::new(report::Layer::Host, "HostDown", "")),
        };
        if app.state::<HostState>().start(launch, on_event).is_err() {
            report(report::new(report::Layer::Host, "HostStartFailed", ""));
        }
    });
}

/// What the UI is told when the sidecar is back after it ended.
const HOST_RESTARTED: &str = "host-restarted";

/// This launch's error reports. Set once the log folder is known; a failure before that is not
/// reported.
static REPORTER: std::sync::OnceLock<report::Reporter> = std::sync::OnceLock::new();
static SEGMENT: std::sync::OnceLock<report::Segment> = std::sync::OnceLock::new();

/// Writes an error report to `reports.jsonl` in the log folder — what is sent, for anyone to read.
/// A build made with a sink sends it on the next launch.
fn report(report: report::Report) {
    if let Some(reporter) = REPORTER.get() {
        let _ = reporter.record(report);
    }
}

/// Stops the sidecar, reporting what it failed at on its own first — when the app ends, and before an
/// update's installer replaces it.
fn stop_host(app: &AppHandle) {
    let host = app.state::<HostState>();
    if let Ok(client) = host.client() {
        report_host_failures(client.take_failures());
    }
    host.stop();
}

/// Reports what the sidecar failed at away from any request.
fn report_host_failures(failures: Vec<tauri_kit_sidecar::loopback::Fault>) {
    for failure in failures {
        report(report::new(
            report::Layer::Host,
            &failure.kind,
            &failure.frames.join("\n"),
        ));
    }
}

/// The notices of the third-party packages shipped with the app, as the installer laid them beside
/// it — what the about dialog shows.
#[tauri::command]
fn third_party_notices(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    std::fs::read_to_string(dir.join("THIRD-PARTY-NOTICES.txt")).map_err(|e| e.to_string())
}

/// A failure the UI caught: its kind (an error's class name or an app-owned code) and stack. Only
/// what the report keeps of them is written.
#[tauri::command]
fn report_error(kind: String, stack: String) {
    report(report::new(report::Layer::Ui, &kind, &stack));
}

/// Starts writing error reports, and reports a panic of the shell — to disk only, from the panic
/// itself: a panicking process is no place to send anything.
/// Opens a link the person clicked in a template or document body in the system's own app for it
/// — the browser, the mail app — and says whether it did: a link to anything but the web or mail
/// is not opened (see [`navigation::opens_outside`]). An e2e build, which must not open a browser
/// on the machine it runs on, says it did without opening anything.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<bool, String> {
    let to = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !navigation::opens_outside(&to) {
        return Ok(false);
    }
    if app.config().identifier.ends_with(".e2e") {
        return Ok(true);
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(to.as_str(), None::<&str>)
        .map(|()| true)
        .map_err(|e| e.to_string())
}

/// Opens the app's window as configured, kept to the app's own pages (see [`navigation`]).
fn open_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("the window is configured");
    let dev_url = if cfg!(dev) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let navigating = app.clone();
    let dev = dev_url.clone();
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |to| navigation::allow(&navigating, to, dev.as_ref()));
    // On Windows the web view's own lock refuses new windows and says so; a handler here would
    // take them before it.
    #[cfg(not(windows))]
    let builder = {
        let (opening, dev) = (app.clone(), dev_url.clone());
        builder.on_new_window(move |to, _| {
            navigation::allow(&opening, &to, dev.as_ref());
            tauri::webview::NewWindowResponse::Deny
        })
    };
    let window = builder.build()?;
    #[cfg(windows)]
    navigation::lock(&window, dev_url.as_ref())?;
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

fn start_reports(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    // One folder, a segment per process that writes it — a second window of the app keeps its own.
    let stream = dir.join("reports");
    // Before this launch writes or sends anything: the single file earlier versions kept joins the
    // folder once, and the folder is evidence, not an archive.
    let _ = report::adopt(
        &stream,
        &dir.join("reports.jsonl"),
        &dir.join("reports.sent"),
    );
    let _ = report::tidy(&stream, report::MAX_STREAM_BYTES);
    let Ok(segment) = report::Segment::open(&stream) else {
        return;
    };
    if REPORTER
        .set(report::Reporter::new(segment.file().to_path_buf()))
        .is_err()
    {
        return;
    }
    // Held for as long as the process runs: its lock tells `tidy` the segment is still written.
    let _ = SEGMENT.set(segment);
    // What earlier launches wrote goes out now, away from startup; what fails stays for the next.
    if let Some(sink) = report::sink_of_build() {
        std::thread::spawn(move || {
            let _ = sink.send_pending(&report::Sink::agent(), report::registry(), &stream);
        });
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        report(report::new(report::Layer::Shell, "Panic", &at));
        previous(info);
    }));
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The page decides which clicks open a link (`open_link`); the plugin's own script, which takes
        // clicks on links that open a new window, is left out — it would ask for a permission the page
        // does not have, and the link would open nowhere.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(update::UpdateState::default())
        .manage(HostState::default())
        .setup(|app| {
            open_window(app.handle())?;
            start_reports(app.handle());
            start_host(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_link,
            open_vault,
            resume_vault,
            write_session,
            read_settings,
            write_settings,
            update::check_update,
            update::install_update,
            folder_is_empty,
            list_templates,
            list_documents,
            read_file,
            read_files,
            write_file,
            write_file_if_unchanged,
            create_file,
            rename_file,
            trash_file,
            remove_file,
            export_file,
            host_status,
            host_ingest,
            host_projection,
            host_curves,
            host_suggest,
            host_search,
            host_similar,
            host_aggregate,
            report_error,
            record_event,
            list_events,
            record_presentation,
            read_presentations,
            third_party_notices,
            host_model_probe,
            host_local_models,
            host_local_prepare,
            host_chat_author,
            host_source_file,
            host_chat_extract,
            host_chat_query,
            credentials::model_key_kept,
            credentials::keep_model_key,
            credentials::forget_model_key
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lowline")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_host(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_the_sidecar_a_model_endpoint_by_the_names_it_reads() {
        let body: serde_json::Value = serde_json::from_str(&model_probe_body(
            "custom",
            Some("http://127.0.0.1:1234/v1"),
            Some("k"),
        ))
        .unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "preset": "custom", "baseUrl": "http://127.0.0.1:1234/v1", "apiKey": "k" })
        );
        let none: serde_json::Value =
            serde_json::from_str(&model_probe_body("ollama", None, None)).unwrap();
        assert_eq!(
            none,
            serde_json::json!({ "preset": "ollama", "baseUrl": null, "apiKey": null })
        );
    }

    #[test]
    fn hands_the_sidecar_a_chat_with_the_key_read_here() {
        let request: ChatAuthor = serde_json::from_value(serde_json::json!({
            "preset": "custom", "baseUrl": "http://127.0.0.1:1234/v1", "model": "m",
            "template": "---
id: t
---
", "turns": [{ "role": "user", "text": "안녕" }]
        }))
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&chat_author_body(&request, Some("k"))).unwrap();
        assert_eq!(body["apiKey"], "k");
        assert_eq!(body["baseUrl"], "http://127.0.0.1:1234/v1");
        assert_eq!(body["turns"][0]["text"], "안녕");
        let none: serde_json::Value =
            serde_json::from_str(&chat_author_body(&request, None)).unwrap();
        assert!(none["apiKey"].is_null());
    }

    #[test]
    fn hands_the_sidecar_a_question_with_the_key_read_here() {
        let request: ChatQuery = serde_json::from_value(serde_json::json!({
            "preset": "local", "baseUrl": null, "model": "gguf:qwen3-default",
            "template": "@원인: [select options=\"부품,설정\"]", "question": "지난달 원인 상위 2개?"
        }))
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&chat_query_body(&request, None)).unwrap();
        assert!(body["apiKey"].is_null());
        assert_eq!(body["question"], "지난달 원인 상위 2개?");
        assert_eq!(body["model"], "gguf:qwen3-default");
        assert_eq!(body["referred"], serde_json::json!([])); // no field refers to another template's documents

        let referring: ChatQuery = serde_json::from_value(serde_json::json!({
            "preset": "local", "baseUrl": null, "model": "gguf:qwen3-default",
            "template": "@고객 -> customer: [select]", "question": "서울 고객 문의 수?",
            "referred": [{ "name": "고객.지역", "type": "select", "options": ["서울", "부산"] }]
        }))
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&chat_query_body(&referring, None)).unwrap();
        assert_eq!(body["referred"][0]["name"], "고객.지역");
        assert_eq!(body["referring"], serde_json::json!([])); // no template's documents refer to this one's

        let referred_to: ChatQuery = serde_json::from_value(serde_json::json!({
            "preset": "local", "baseUrl": null, "model": "gguf:qwen3-default",
            "template": "상호: ___@상호", "question": "문의가 많은 고객?",
            "referring": [{ "name": "문의", "via": ["고객"], "columns": [{ "name": "고객", "type": "select", "options": [] }] }]
        }))
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&chat_query_body(&referred_to, None)).unwrap();
        assert_eq!(body["referring"][0]["via"], serde_json::json!(["고객"]));
    }

    #[test]
    fn hands_the_sidecar_text_to_read_records_from_with_the_key_read_here() {
        let request: ChatExtract = serde_json::from_value(serde_json::json!({
            "preset": "local", "baseUrl": null, "model": "gguf:qwen3-default",
            "template": "@요청자: [text]", "text": "김민수 님 요청"
        }))
        .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&chat_extract_body(&request, Some("k"))).unwrap();
        assert_eq!(body["apiKey"], "k");
        assert!(body["baseUrl"].is_null());
        assert_eq!(body["model"], "gguf:qwen3-default");
        assert_eq!(body["text"], "김민수 님 요청");
        assert_eq!(body["template"], "@요청자: [text]");
    }

    /// Every kind a command failure can name, as the UI's `VAULT_FAILURE_KINDS` lists them too.
    const FAILURE_KINDS: [&str; 7] = [
        "outside-vault",
        "already-exists",
        "not-found",
        "not-trashed",
        "changed-outside",
        "io",
        "no-vault",
    ];

    /// The kinds a command failure names, held to the list the UI reads: a kind added or renamed here is a
    /// kind the UI must hear of. `LOWLINE_UPDATE_CONTRACT=1` writes the list for the UI's own test.
    #[test]
    fn every_failure_kind_is_one_the_ui_knows() {
        let named = [
            VaultError::OutsideVault(String::new()),
            VaultError::AlreadyExists(String::new()),
            VaultError::NotFound(String::new()),
            VaultError::NotTrashed(String::new()),
            VaultError::Changed(String::new()),
            VaultError::Io(std::io::Error::other("x")),
        ]
        .map(|e| CommandError::from(e).kind);
        let mut kinds: Vec<&str> = named.into_iter().chain([no_vault().kind]).collect();
        kinds.sort_unstable();
        let mut listed = FAILURE_KINDS.to_vec();
        listed.sort_unstable();
        assert_eq!(kinds, listed);

        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/__tests__/shell-failure-kinds.json");
        let json = serde_json::to_string_pretty(&FAILURE_KINDS).unwrap() + "\n";
        if std::env::var("LOWLINE_UPDATE_CONTRACT").as_deref() == Ok("1") {
            std::fs::write(&path, &json).unwrap();
        }
        let file = std::fs::read_to_string(&path)
            .expect("shell-failure-kinds.json; write it with LOWLINE_UPDATE_CONTRACT=1");
        assert_eq!(
            file.replace("\r\n", "\n"),
            json,
            "the UI's list is out of date; write it with LOWLINE_UPDATE_CONTRACT=1"
        );
    }
    use tauri_kit_watch::Change;

    #[test]
    fn a_failed_call_reports_what_the_sidecar_said_or_its_status_and_a_404_reports_nothing() {
        let said = call_failure(&host::CallError::Failed(
            tauri_kit_sidecar::loopback::Fault {
                kind: "System.IO.IOException".into(),
                at: None,
                frames: vec!["Lowline.Host.VaultProjection.IngestAsync".into()],
            },
        ))
        .unwrap();
        assert_eq!(
            (said.layer.as_str(), said.kind.as_str()),
            ("host", "System.IO.IOException")
        );

        let status = call_failure(&host::CallError::Status(400)).unwrap();
        assert_eq!(status.kind, "HostAnswered");
        assert_eq!(
            status.details.get("status").map(String::as_str),
            Some("400")
        );

        assert!(call_failure(&host::CallError::Status(404)).is_none());
    }

    #[test]
    fn watches_only_the_places_the_app_reads() {
        let own = Path::new(".lowline/events/this-device.jsonl");
        for rel in [
            "서식/버그 리포트.fd.md",
            "문서/2026-09-29 제목.md",
            ".lowline/events/other-device.jsonl",
        ] {
            assert!(
                !ignored(Path::new(rel), Some(own)),
                "{rel} is read by the app"
            );
        }
        for rel in [
            ".lowline/events/this-device.jsonl",
            ".lowline/tmp/.tauri-kit-tmp-1",
            ".textree/tmp/.watcher-canary-3",
            ".textree/favorites.json",
            "메모.md",
            "assets/Pasted-1.png",
            "문서철/a.md",
        ] {
            assert!(
                ignored(Path::new(rel), Some(own)),
                "{rel} is not the app's to read"
            );
        }
    }

    #[test]
    fn a_template_id_stays_one_path_segment() {
        assert_eq!(encode_segment("bug-report@1"), "bug-report@1");
        assert_eq!(
            encode_segment("상담/기록 1"),
            "%EC%83%81%EB%8B%B4%2F%EA%B8%B0%EB%A1%9D%201"
        );
    }

    #[test]
    fn an_ingest_names_the_vault_it_is_for() {
        assert_eq!(
            ingest_path(Path::new("D:/볼트 1")),
            "/vault/ingest?vault=D%3A%2F%EB%B3%BC%ED%8A%B8%201"
        );
    }

    #[test]
    fn a_change_reaches_the_ui_with_vault_paths() {
        let changed = VaultChanged::from(Notice::Changed(vec![
            Change {
                path: Path::new("문서").join("a.md"),
                kind: ChangeKind::Written,
            },
            Change {
                path: PathBuf::from("서식/b.fd.md"),
                kind: ChangeKind::Removed,
            },
        ]));
        assert_eq!(changed.written, vec!["문서/a.md"]);
        assert_eq!(changed.removed, vec!["서식/b.fd.md"]);
        assert!(!changed.rescan);
        assert!(VaultChanged::from(Notice::Rescan).rescan);
    }

    #[test]
    fn names_a_vault_the_same_way_every_build() {
        // FNV-1a's published test vectors: a changed name would orphan every device's record.
        assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn appends_presentations_line_by_line() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("presentations").join("v.jsonl");
        append_line(&file, r#"{"a":1}"#).unwrap();
        append_line(&file, r#"{"a":2}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\"a\":1}
{\"a\":2}
"
        );
    }
}
