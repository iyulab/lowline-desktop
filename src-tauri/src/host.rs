//! The .NET sidecar: started with the app, stopped with it.
//!
//! The shell starts `host/Lowline.Host` from its resources as a loopback sidecar
//! (`tauri_kit_sidecar::loopback`): a fresh token in `LOWLINE_HOST_TOKEN`, the directory for its
//! projection caches in `LOWLINE_HOST_CACHE`. The host listens on a loopback port the OS picks and
//! prints one line with it; every request carries the token. The sidecar never touches vault files —
//! the shell hands it what it needs.
//!
//! A sidecar that ends during the session is started again by a supervisor
//! (`tauri_kit_sidecar::supervise`), a few times within a few minutes at most; after that it stays
//! down and is said to have failed. What the sidecar held is the vault the UI handed it, so the UI
//! hands it over again once it is back. The sidecar also watches the shell's process
//! (`PARENT_VARIABLE`), and quits when the shell is gone without having stopped it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri_kit_sidecar::loopback::{
    Client, Fault, Loopback, LoopbackOptions, Response, TransportError,
};
use tauri_kit_sidecar::supervise::{
    Event, RestartPolicy, Started, State, SuperviseOptions, Supervisor,
};
use tauri_kit_sidecar::Sink;

/// Must match `HostAuth.TokenVariable` in `src-host/Lowline.Host`.
pub const TOKEN_VARIABLE: &str = "LOWLINE_HOST_TOKEN";
/// Must match `VaultProjection.CacheVariable` in `src-host/Lowline.Host`.
pub const CACHE_VARIABLE: &str = "LOWLINE_HOST_CACHE";
/// Must match `HostLifecycle.ParentVariable` in `src-host/Lowline.Host`.
pub const PARENT_VARIABLE: &str = "LOWLINE_HOST_PARENT";
/// Must match `ReadyLine.Prefix` in `src-host/Lowline.Host`.
const READY_PREFIX: &str = "lowline-host port=";
const START_DEADLINE: Duration = Duration::from_secs(30);
/// How often a sidecar that ended is started again before it is said to have failed: so many starts
/// within so long.
const RESTARTS: RestartPolicy = RestartPolicy {
    limit: 3,
    window: Duration::from_secs(300),
};
const STOP_GRACE: Duration = Duration::from_secs(3);

/// How to reach the host: its port and this launch's token. Cheap to clone into a worker thread.
#[derive(Clone)]
pub struct HostClient {
    client: Client,
}

/// Why a request to the host did not come back with an answer.
#[derive(Debug)]
pub enum CallError {
    /// The host failed the request and said what failed.
    Failed(Fault),
    /// The host answered with this status and nothing more to go on.
    Status(u16),
    /// The request did not reach the host, or its answer could not be read.
    Transport(TransportError),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Failed(failure) => write!(f, "the sidecar failed: {}", failure.kind),
            CallError::Status(status) => write!(f, "the sidecar answered {status}"),
            CallError::Transport(e) => write!(f, "{e}"),
        }
    }
}

impl From<TransportError> for CallError {
    fn from(e: TransportError) -> Self {
        CallError::Transport(e)
    }
}

/// An answer by its status: the body when it succeeded; otherwise what failed, if the host said.
pub fn answer(response: Response) -> Result<String, CallError> {
    if response.is_success() {
        return Ok(response.body);
    }
    Err(response
        .fault()
        .map_or(CallError::Status(response.status), CallError::Failed))
}

/// Starts the host at `exe`, keeping its projection caches in `cache`, and waits until it has said
/// where it listens and answered `/health`: one start, for the supervisor to make again.
pub fn launch(
    exe: &Path,
    stderr_log: PathBuf,
    cache: &Path,
) -> Result<Started<HostClient>, String> {
    let mut cmd = Command::new(exe);
    cmd.env(CACHE_VARIABLE, cache)
        .env(PARENT_VARIABLE, std::process::id().to_string());
    let mut options = LoopbackOptions::new(TOKEN_VARIABLE, READY_PREFIX);
    options.ready_timeout = START_DEADLINE;
    options.stderr = Sink::File(stderr_log);
    let sidecar =
        Loopback::start(cmd, &options).map_err(|e| format!("the host did not start: {e}"))?;
    let client = HostClient {
        client: sidecar.client().clone(),
    };
    // Dropped on the error below, the process is stopped with it.
    let (sidecar, _) = sidecar.into_parts();
    client
        .get("/health")
        .map_err(|e| format!("the host does not answer: {e}"))?;
    Ok(Started {
        sidecar,
        value: client,
    })
}

impl HostClient {
    /// A GET request to the host, returning the response body.
    pub fn get(&self, path: &str) -> Result<String, CallError> {
        let response = self.client.get(path)?;
        answer(response)
    }

    /// A POST request with a JSON body, returning the response body.
    pub fn post_json(&self, path: &str, body: &str) -> Result<String, CallError> {
        let response = self.client.post_json(path, body)?;
        answer(response)
    }

    /// The host's failures of work no request waited on, since the last time they were taken.
    pub fn take_failures(&self) -> Vec<Fault> {
        self.post_json("/failures/take", "")
            .ok()
            .and_then(|body| serde_json::from_str(&body).ok())
            .unwrap_or_default()
    }
}

/// Where the host stands, as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HostStatus {
    Starting,
    Ready,
    Failed { message: String },
}

/// What the supervisor did, for the shell to report and tell the UI.
pub enum Supervised {
    /// The host ended and is running again.
    Restarted,
    /// The host ended and a start after it failed.
    RestartFailed,
    /// The host ended too often and stays down.
    Down,
}

/// The host, once started, and its status.
#[derive(Default)]
pub struct HostState {
    supervisor: Mutex<Option<Supervisor<HostClient>>>,
    /// Why the first start failed, when it did.
    failed: Mutex<Option<String>>,
    /// Stopped for good — the app ends, or an update is about to replace the sidecar: never started again.
    stopped: AtomicBool,
}

impl HostState {
    /// Starts the host with `launch` and keeps it running with it, telling `on_event` what the
    /// supervisor did. Waits for the first start: call it off the main thread.
    pub fn start(
        &self,
        launch: impl Fn() -> Result<Started<HostClient>, String> + Send + Sync + 'static,
        mut on_event: impl FnMut(Supervised) + Send + 'static,
    ) -> Result<(), String> {
        let options = SuperviseOptions {
            restart: RESTARTS,
            ..SuperviseOptions::default()
        };
        let started = Supervisor::start(launch, options, move |event| {
            on_event(match event {
                Event::Restarted { .. } => Supervised::Restarted,
                Event::RestartFailed { .. } => Supervised::RestartFailed,
                Event::Down { .. } => Supervised::Down,
            })
        });
        match started {
            // Started while the app was stopping it for good: it does not stay.
            Ok(supervisor) if self.stopped.load(Ordering::SeqCst) => {
                stop(&supervisor);
                Ok(())
            }
            Ok(supervisor) => {
                *self.supervisor.lock().expect("host poisoned") = Some(supervisor);
                Ok(())
            }
            Err(message) => {
                *self.failed.lock().expect("host poisoned") = Some(message.clone());
                Err(message)
            }
        }
    }

    pub fn status(&self) -> HostStatus {
        match self.client() {
            Ok(_) => HostStatus::Ready,
            Err(_) if self.is_starting() => HostStatus::Starting,
            Err(message) => HostStatus::Failed { message },
        }
    }

    /// Whether the host is on its way: its first start under way, or a start after it ended.
    fn is_starting(&self) -> bool {
        match self.supervisor.lock().expect("host poisoned").as_ref() {
            Some(supervisor) => supervisor.state() == State::Restarting,
            None => self.failed.lock().expect("host poisoned").is_none(),
        }
    }

    /// A client for the running host, or why there is none.
    pub fn client(&self) -> Result<HostClient, String> {
        // Each lock is let go before the next is taken: no caller ever holds two.
        let state = self
            .supervisor
            .lock()
            .expect("host poisoned")
            .as_ref()
            .map(|supervisor| (supervisor.state(), supervisor.current()));
        let Some((state, client)) = state else {
            return Err(self
                .failed
                .lock()
                .expect("host poisoned")
                .clone()
                .unwrap_or_else(|| "the sidecar is still starting".into()));
        };
        match state {
            State::Running => Ok(client),
            State::Restarting => Err("the sidecar is still starting".into()),
            State::Down => Err(format!(
                "the sidecar ended {} times within {} minutes",
                RESTARTS.limit + 1,
                RESTARTS.window.as_secs() / 60
            )),
            State::Stopped => Err("the sidecar was stopped".into()),
        }
    }

    /// Stops the host if it runs, for good. Called when the app exits, and before an update replaces it.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let supervisor = self.supervisor.lock().expect("host poisoned").take();
        if let Some(supervisor) = supervisor {
            stop(&supervisor);
        }
    }

    /// A first start that failed — what the UI is then told.
    #[cfg(test)]
    fn fail(&self, message: &str) {
        *self.failed.lock().expect("host poisoned") = Some(message.into());
    }
}

/// Asks the host to stop, then stops whatever is left of it.
fn stop(supervisor: &Supervisor<HostClient>) {
    supervisor.stop(STOP_GRACE, |client| {
        let _ = client.post_json("/shutdown", "");
    });
}

/// The host executable inside the app's resources.
pub fn executable(resource_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "Lowline.Host.exe"
    } else {
        "Lowline.Host"
    };
    resource_dir.join("host").join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, body: &str) -> Response {
        Response {
            status,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    #[test]
    fn an_answer_is_its_body_when_the_request_succeeded() {
        assert_eq!(answer(reply(200, "{}")).unwrap(), "{}");
    }

    #[test]
    fn a_failed_request_says_what_failed_when_the_host_said() {
        let failed = answer(reply(
            500,
            r#"{"fault":{"type":"System.ArgumentException","at":"Lowline.Host.VaultProjection.IngestAsync","frames":["Lowline.Host.VaultProjection.IngestAsync"]}}"#,
        ));
        match failed {
            Err(CallError::Failed(f)) => {
                assert_eq!(f.kind, "System.ArgumentException");
                assert_eq!(f.frames, ["Lowline.Host.VaultProjection.IngestAsync"]);
            }
            other => panic!("{other:?}"),
        }
    }

    /// `f` on its own thread, failing the test should it not have returned within a few seconds.
    fn returns_soon<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, answer) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(f());
        });
        answer
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("it waited on itself")
    }

    #[test]
    fn a_request_while_the_sidecar_starts_says_so_and_leaves_the_state_usable() {
        let state = std::sync::Arc::new(HostState::default());
        let starting = state.clone();
        let said = returns_soon(move || starting.client().err());
        assert_eq!(said.as_deref(), Some("the sidecar is still starting"));
        // Nothing stays held: the status, asked on another thread as the window asks it, still answers.
        let asked = state.clone();
        assert!(matches!(
            returns_soon(move || asked.status()),
            HostStatus::Starting
        ));
    }

    #[test]
    fn a_request_once_starting_failed_says_why() {
        let state = std::sync::Arc::new(HostState::default());
        state.fail("the host did not start");
        let failed = state.clone();
        assert_eq!(
            returns_soon(move || failed.client().err()).as_deref(),
            Some("the host did not start")
        );
    }

    #[test]
    fn any_other_failure_is_only_its_status() {
        assert!(matches!(
            answer(reply(500, "")),
            Err(CallError::Status(500))
        ));
        assert!(matches!(
            answer(reply(404, "")),
            Err(CallError::Status(404))
        ));
    }
}
