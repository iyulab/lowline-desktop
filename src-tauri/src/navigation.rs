//! The app's window shows the app's own pages and nothing else.
//!
//! Template and document bodies come from the vault, and a vault is written by other people and
//! other programs: a link in a template's instructions is an ordinary thing to find there. Followed
//! inside the app's window, it would replace the app — and whatever was typed and not yet saved —
//! with a page the window has no way back from. So the window refuses to leave the app's pages and
//! to open windows of its own, and tells the screen what it refused, so the person is not left
//! with a click that did nothing. A link the person clicks is opened outside instead — in the
//! system's browser or mail app — when it is to the web or to mail ([`opens_outside`]).
//!
//! On Windows the web view itself is held to the same pages as well ([`lock`]): a frame, the
//! request a refused navigation would have sent, a new window and another program's scheme are
//! stopped there, below the window's own navigation handler.

use tauri::{AppHandle, Emitter, Url};

/// What the screen is told when the window refuses to go to an address.
pub const REFUSED: &str = "navigation-refused";

/// Whether `to` is one of the app's own pages: the bundled pages the app is served from, or the
/// development server while the app runs from it.
pub fn is_app_page(to: &Url, dev_url: Option<&Url>) -> bool {
    match to.scheme() {
        // macOS and Linux serve the bundled pages under the app's own scheme.
        "tauri" => to.host_str() == Some("localhost"),
        // Windows serves them from a host of its own, over http or https.
        "http" | "https" => {
            to.host_str() == Some("tauri.localhost")
                || dev_url.is_some_and(|dev| dev.origin() == to.origin())
        }
        _ => false,
    }
}

/// Whether a link to `to` may be opened in the system's own app for it: the web and mail. A link
/// to anything else — a file, a program, another app's scheme — is not opened from a body someone
/// else wrote.
pub fn opens_outside(to: &Url) -> bool {
    matches!(to.scheme(), "http" | "https" | "mailto")
}

/// Lets the window go to `to` when it is one of the app's own pages; otherwise refuses and tells
/// the screen which address was refused.
pub fn allow(app: &AppHandle, to: &Url, dev_url: Option<&Url>) -> bool {
    if is_app_page(to, dev_url) {
        return true;
    }
    let _ = app.emit(REFUSED, to.as_str());
    false
}

/// The origins the window's pages are served from on Windows — the bundled pages, over http or
/// https, and the development server while the app runs from it: what [`is_app_page`] allows there.
#[cfg(windows)]
pub fn app_origins(dev_url: Option<&Url>) -> tauri_kit_webview::NavigationLock {
    use tauri_kit_webview::{NavigationLock, Origin};
    let bundled = ["http://tauri.localhost", "https://tauri.localhost"]
        .into_iter()
        .map(|o| Origin::parse(o).expect("the bundled pages' origin"));
    let dev = dev_url.and_then(|dev| Origin::parse(&dev.origin().ascii_serialization()).ok());
    NavigationLock::new(bundled.chain(dev))
}

/// Holds `window`'s web view to the app's pages ([`app_origins`]) for as long as it lives. The
/// window's navigation handler says what it refuses itself; what only the web view sees — a frame,
/// a new window, another program's scheme, a page shown that should not be — is told the screen
/// the same way. Nothing is opened from here: a link the person clicks goes through
/// [`opens_outside`].
#[cfg(windows)]
pub fn lock(window: &tauri::WebviewWindow, dev_url: Option<&Url>) -> tauri::Result<()> {
    use tauri::Manager;
    use tauri_kit_webview::Kind;
    let (app, lock) = (window.app_handle().clone(), app_origins(dev_url));
    window.with_webview(move |webview| {
        let _ = tauri_kit_webview::lock_navigation(&webview.controller(), lock, move |attempt| {
            if attempt.kind != Kind::Navigation {
                let _ = app.emit(REFUSED, attempt.uri.as_str());
            }
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_bundled_pages_are_the_apps_own() {
        assert!(is_app_page(&url("tauri://localhost/index.html"), None));
        assert!(is_app_page(&url("http://tauri.localhost/"), None));
        assert!(is_app_page(
            &url("https://tauri.localhost/#documents"),
            None
        ));
    }

    #[test]
    fn the_development_server_is_the_apps_own_only_while_the_app_runs_from_it() {
        let dev = url("http://localhost:1420");
        assert!(is_app_page(
            &url("http://localhost:1420/src/main.ts"),
            Some(&dev)
        ));
        assert!(!is_app_page(&url("http://localhost:1420/"), None));
        assert!(!is_app_page(&url("http://localhost:8080/"), Some(&dev)));
    }

    #[test]
    fn any_other_address_is_not() {
        for to in [
            "https://example.com/",
            "http://localhost/",
            "https://tauri.localhost.example.com/",
            "tauri://example.com/",
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "mailto:someone@example.com",
            "about:blank",
        ] {
            assert!(!is_app_page(&url(to), None), "{to}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_web_view_is_held_to_the_pages_the_window_allows() {
        use tauri_kit_webview::Decision;
        let dev = url("http://localhost:1420");
        let lock = app_origins(Some(&dev));
        for to in [
            "http://tauri.localhost/",
            "https://tauri.localhost/#documents",
            "http://localhost:1420/src/main.ts",
        ] {
            assert_eq!(lock.decide(to), Decision::Allow, "{to}");
            assert!(is_app_page(&url(to), Some(&dev)), "{to}");
        }
        for to in [
            "https://example.com/",
            "http://localhost/",
            "http://localhost:8080/",
            "https://tauri.localhost.example.com/",
            "file:///C:/Windows/notepad.exe",
            "mailto:someone@example.com",
            "about:blank",
        ] {
            assert_ne!(lock.decide(to), Decision::Allow, "{to}");
        }
        assert_ne!(
            app_origins(None).decide("http://localhost:1420/"),
            Decision::Allow
        );
    }

    #[test]
    fn only_the_web_and_mail_are_opened_outside() {
        for to in [
            "https://example.com/",
            "http://example.com/a?b=c",
            "mailto:someone@example.com",
        ] {
            assert!(opens_outside(&url(to)), "{to}");
        }
        for to in [
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "ms-settings:privacy",
            "tauri://localhost/",
            "about:blank",
        ] {
            assert!(!opens_outside(&url(to)), "{to}");
        }
    }
}
