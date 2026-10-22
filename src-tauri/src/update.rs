//! Updates: looking for a newer release, downloading it in the background, and installing it once
//! the person says so.
//!
//! The schedule, the once-only announcement, the background download and what is kept between
//! launches are `tauri-kit-update`'s; the releases come from Tauri's updater plugin, which reads one
//! public file (the release's `latest.json`) and accepts an installer only with a valid update
//! signature. Nothing of the vault goes with either request. Installing waits for the person: the app
//! never installs on its own, not even as it closes. A development build looks only where
//! `LOWLINE_UPDATE_ENDPOINT` points, and keeps no state between launches, so it looks at each one.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_kit_update::{Channel, Event, Found, Source, Stage, Status, UpdateOptions, Updates};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Where a development build looks for updates; it looks nowhere without it.
const DEV_ENDPOINT: &str = "LOWLINE_UPDATE_ENDPOINT";

/// How often a running app looks again.
const EVERY: Duration = Duration::from_secs(12 * 60 * 60);

/// The event the window hears whenever where updating stands changes.
const CHANGED: &str = "update-changed";

/// Releases as Tauri's updater plugin finds, downloads and installs them.
struct Plugin {
    app: AppHandle,
    /// A development build's endpoint, in place of the configured one.
    endpoint: Option<Url>,
}

impl Plugin {
    fn updater(&self) -> Result<tauri_plugin_updater::Updater, String> {
        let mut builder = self.app.updater_builder();
        if let Some(endpoint) = &self.endpoint {
            builder = builder
                .endpoints(vec![endpoint.clone()])
                .map_err(|e| e.to_string())?;
        }
        builder.build().map_err(|e| e.to_string())
    }
}

impl Source for Plugin {
    type Update = Update;
    type Installer = Vec<u8>;

    /// The releases have one manifest, so every channel looks at it.
    fn check(&self, _channel: Channel) -> Result<Option<Found<Update>>, String> {
        let updater = self.updater()?;
        let update = tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())?;
        Ok(update.map(|u| Found {
            version: u.version.clone(),
            update: u,
        }))
    }

    fn download(&self, found: &Found<Update>) -> Result<Vec<u8>, String> {
        tauri::async_runtime::block_on(found.update.download(|_, _| {}, || {}))
            .map_err(|e| e.to_string())
    }

    fn install(
        &self,
        found: Found<Update>,
        installer: Vec<u8>,
        restart: bool,
    ) -> Result<(), String> {
        found.update.install(installer).map_err(|e| e.to_string())?;
        if restart {
            self.app.restart();
        }
        Ok(())
    }
}

/// Updating once the window has said whether to look: none before, and none for a development build
/// given no place to look.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Arc<Updates<Plugin>>>>);

/// Where updating stands, as the window shows it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    /// The newer release found, if any.
    pub available: Option<String>,
    /// Its installer is downloaded and checked: installing starts at once.
    pub ready: bool,
    /// Its download failed; it is tried again later — the release page has it meanwhile.
    pub failed: bool,
}

impl From<Status> for UpdateView {
    fn from(status: Status) -> Self {
        let ready = status.ready.is_some() && status.ready == status.available;
        let failed = status.failed.is_some() && status.failed == status.available;
        UpdateView {
            available: status.available,
            ready,
            failed,
        }
    }
}

/// What a failed install looks like to the window.
#[derive(Debug, Serialize)]
pub struct UpdateError {
    kind: &'static str,
    message: String,
}

/// The endpoint a development build looks at, or `Err` when it looks nowhere. A release build looks
/// where its configuration says.
fn endpoint() -> Result<Option<Url>, ()> {
    if !cfg!(debug_assertions) {
        return Ok(None);
    }
    std::env::var(DEV_ENDPOINT)
        .ok()
        .filter(|e| !e.is_empty())
        .and_then(|e| e.parse::<Url>().ok())
        .map(Some)
        .ok_or(())
}

/// Starts updating, or turns looking on or off, as the device's setting says — and answers where it
/// stands. Called by the window once its settings are read, and again whenever the setting changes.
#[tauri::command]
pub fn watch_updates(
    look: bool,
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Option<UpdateView> {
    let mut updates = state.0.lock().expect("update state poisoned");
    if let Some(updates) = updates.as_ref() {
        updates.set_enabled(look);
        return Some(updates.status().into());
    }
    let endpoint = endpoint().ok()?;
    let mut options = UpdateOptions::new(app.package_info().version.to_string());
    options.every = EVERY;
    options.enabled = look;
    // A release build remembers when it last looked and what it found and downloaded; a development
    // build starts afresh each launch.
    options.state_file = (!cfg!(debug_assertions))
        .then(|| app.path().app_data_dir().ok())
        .flatten()
        .map(|dir| dir.join("updates.json"));
    let tell = app.clone();
    let started = Updates::start(
        Plugin {
            app: app.clone(),
            endpoint,
        },
        options,
        move |event| {
            // Told from the updater's own thread: the window asks for the status itself.
            match event {
                Event::Found { .. } | Event::Ready { .. } => {}
                Event::Failed {
                    stage: Stage::Check,
                    ..
                } => return, // no network is the common case, and changes nothing shown
                Event::Failed { .. } => {}
            }
            let _ = tell.emit(CHANGED, ());
        },
    );
    let view = started.status().into();
    *updates = Some(Arc::new(started));
    Some(view)
}

/// Where updating stands now.
#[tauri::command]
pub fn update_status(state: State<'_, UpdateState>) -> Option<UpdateView> {
    let updates = state.0.lock().expect("update state poisoned");
    updates.as_ref().map(|u| u.status().into())
}

/// Installs the newer release — downloading it first if it is not yet — and starts it. The sidecar
/// is stopped before the installer runs: the installer replaces its program, which a running sidecar
/// holds open. On Windows the installer ends the app itself.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), UpdateError> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Held outside the lock: downloading first can take a while, and the window keeps asking.
        let updates = handle
            .state::<UpdateState>()
            .0
            .lock()
            .expect("update state poisoned")
            .clone();
        let Some(updates) = updates else {
            return Err(UpdateError {
                kind: "no-update",
                message: "no update to install".into(),
            });
        };
        let stop = handle.clone();
        updates
            .install_now(move || crate::stop_host(&stop))
            .map_err(|message| UpdateError {
                kind: "update",
                message,
            })
    })
    .await
    .map_err(|e| UpdateError {
        kind: "update",
        message: e.to_string(),
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(available: Option<&str>, ready: Option<&str>, failed: Option<&str>) -> Status {
        Status {
            enabled: true,
            available: available.map(str::to_owned),
            kind: None,
            channel: Channel::Stable,
            ready: ready.map(str::to_owned),
            downloading: false,
            failed: failed.map(str::to_owned),
            last_checked: None,
            last_answered: None,
        }
    }

    #[test]
    fn ready_and_failed_are_told_of_the_release_found_only() {
        let view = |s| UpdateView::from(s);
        assert_eq!(
            view(status(Some("0.4.0"), None, None)),
            UpdateView {
                available: Some("0.4.0".into()),
                ready: false,
                failed: false
            }
        );
        assert!(view(status(Some("0.4.0"), Some("0.4.0"), None)).ready);
        assert!(view(status(Some("0.4.0"), None, Some("0.4.0"))).failed);
        // An installer or a failure of an older release than the one found says nothing of it.
        let newer = view(status(Some("0.4.1"), Some("0.4.0"), Some("0.4.0")));
        assert!(!newer.ready && !newer.failed);
        assert_eq!(view(status(None, None, None)).available, None);
    }
}
