//! Error reports: the parts of this app that fail on their own, and where their reports go.
//!
//! What a report holds — the layer, the kind, the frames of the app's own code, never a message —
//! is `tauri-kit-diagnostics`'s promise; this module names the layers and the build's sink.

use std::sync::LazyLock;

pub use tauri_kit_diagnostics::{adopt, tidy, Report, Reporter, Segment, Sink, MAX_STREAM_BYTES};
use tauri_kit_diagnostics::{FrameRule, Registry};

/// Where a failure happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    /// The web UI, served from the app's bundle.
    Ui,
    /// The .NET sidecar: method names only — file names in .NET stacks are the build machine's.
    Host,
    /// This crate's Rust code.
    Shell,
}

/// The details a report may carry beside its kind and frames, by layer — and nothing else: the
/// sender checks every line against it on the way back.
static REGISTRY: LazyLock<Registry> = LazyLock::new(|| {
    Registry::from_json(include_str!("../diagnostics.json"))
        .expect("diagnostics.json is a registry")
});
static UI: LazyLock<tauri_kit_diagnostics::Layer> =
    LazyLock::new(|| REGISTRY.layer("ui", FrameRule::web_bundle()));
static HOST: LazyLock<tauri_kit_diagnostics::Layer> =
    LazyLock::new(|| REGISTRY.layer("host", FrameRule::dotnet_method()));
static SHELL: LazyLock<tauri_kit_diagnostics::Layer> =
    LazyLock::new(|| REGISTRY.layer("shell", FrameRule::rust_source()));

/// What the reports of this app may carry, for the sender to check them against.
pub fn registry() -> &'static Registry {
    &REGISTRY
}

impl Layer {
    fn rules(self) -> &'static tauri_kit_diagnostics::Layer {
        match self {
            Layer::Ui => &UI,
            Layer::Host => &HOST,
            Layer::Shell => &SHELL,
        }
    }
}

/// A report from what a layer says about a failure. `kind` and `stack` are untrusted: whatever is
/// not a plain identifier or a frame of the app's own code is dropped.
pub fn new(layer: Layer, kind: &str, stack: &str) -> Report {
    with(layer, kind, stack, &[])
}

/// A report with details: each is kept only when `diagnostics.json` declares it for the layer and
/// its value is of the declared kind.
pub fn with(layer: Layer, kind: &str, stack: &str, details: &[(&str, &str)]) -> Report {
    layer
        .rules()
        .report(kind, stack, env!("CARGO_PKG_VERSION"), details)
}

/// The sink this build was made with. A build made without one — every development and test
/// build — sends nothing.
pub fn sink_of_build() -> Option<Sink> {
    option_env!("LOWLINE_APPINSIGHTS_CONNECTION_STRING").and_then(Sink::parse)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layers_keep_the_names_earlier_reports_were_written_with() {
        for (layer, name) in [
            (Layer::Ui, "ui"),
            (Layer::Host, "host"),
            (Layer::Shell, "shell"),
        ] {
            assert_eq!(new(layer, "Panic", "").layer, name);
        }
    }

    #[test]
    fn each_layer_keeps_only_its_own_frames() {
        let ui = new(
            Layer::Ui,
            "TypeError",
            "TypeError: C:\\Users\\someone\\a.md\n    at save (http://tauri.localhost/assets/index-a1.js:3:120)",
        );
        assert_eq!(ui.frames, ["save index-a1.js:3:120"]);
        let shell = new(Layer::Shell, "Panic", "src/vault.rs:42:9");
        assert_eq!(shell.frames, ["vault.rs:42:9"]);
        let host = new(
            Layer::Host,
            "IOException",
            "at Lowline.Host.Vault.Read(String path) in D:\\build\\Vault.cs:line 12",
        );
        assert_eq!(host.frames, ["Lowline.Host.Vault.Read"]);
        assert_eq!(ui.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn a_report_carries_only_the_details_the_registry_declares() {
        let answered = with(
            Layer::Host,
            "HostAnswered",
            "",
            &[("status", "500"), ("path", "C:/vault")],
        );
        assert_eq!(
            answered.details.get("status").map(String::as_str),
            Some("500")
        );
        assert_eq!(answered.details.len(), 1);
        let not_a_status = with(Layer::Host, "HostAnswered", "", &[("status", "회의록")]);
        assert!(not_a_status.details.is_empty());
        assert!(with(Layer::Ui, "TypeError", "", &[("status", "500")])
            .details
            .is_empty());
    }
}
