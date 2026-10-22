//! The vault: a folder of plain files that is the only source of truth.
//!
//! Every file the app reads or writes goes through [`Vault`], which takes paths relative to the
//! vault root and refuses any that would leave it — `..`, absolute paths, drive prefixes, and
//! links that point outside. Writes are atomic (the old content or the new, never a torn file).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri_kit_fs::{
    claim_free_path, conflict_copy_of, conflict_copy_of_on, has_trash, is_changed, is_outside,
    Expect, NameKind, Root,
};
use tauri_kit_watch::OwnWrites;

/// Folder for form templates.
pub const TEMPLATES_DIR: &str = "서식";
/// Folder for documents filled in from templates.
pub const DOCUMENTS_DIR: &str = "문서";
/// File name suffix that marks a template.
pub const TEMPLATE_SUFFIX: &str = ".fd.md";
/// File name suffix of a document.
pub const DOCUMENT_SUFFIX: &str = ".md";

#[derive(Debug)]
pub enum VaultError {
    /// The path is not a plain relative path inside the vault.
    OutsideVault(String),
    /// A create-only write found a file already there.
    AlreadyExists(String),
    NotFound(String),
    /// The file could not go to the trash — the location may have none — and is still there.
    NotTrashed(String),
    /// A conditional write found the file holding something else than the app last read there.
    Changed(String),
    Io(io::Error),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::OutsideVault(p) => write!(f, "path is outside the vault: {p}"),
            VaultError::AlreadyExists(p) => write!(f, "file already exists: {p}"),
            VaultError::NotFound(p) => write!(f, "not found: {p}"),
            VaultError::NotTrashed(reason) => write!(f, "not moved to the trash: {reason}"),
            VaultError::Changed(p) => write!(f, "changed since it was read: {p}"),
            VaultError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<io::Error> for VaultError {
    fn from(e: io::Error) -> Self {
        VaultError::Io(e)
    }
}

impl VaultError {
    /// A stable code the UI can branch on.
    pub fn kind(&self) -> &'static str {
        match self {
            VaultError::OutsideVault(_) => "outside-vault",
            VaultError::AlreadyExists(_) => "already-exists",
            VaultError::NotFound(_) => "not-found",
            VaultError::NotTrashed(_) => "not-trashed",
            VaultError::Changed(_) => "changed-outside",
            VaultError::Io(_) => "io",
        }
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

/// One file in a vault listing. `path` is relative to the vault root and uses `/`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub modified_ms: u64,
    /// For a copy a sync client made when the file changed on two devices, the path of the file it
    /// is a copy of. Which of the two to keep is the person's to decide.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_of: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Vault {
    root: Root,
    /// What this app wrote, so the vault watch does not report it back as an outside edit.
    own: OwnWrites,
    /// The devices whose names mark a sync client's conflict copy (`a-<device>.md`): this one.
    devices: Vec<String>,
}

impl Vault {
    /// Opens an existing folder as a vault.
    pub fn open(path: &Path) -> Result<Self> {
        let root = Root::open(path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound(path.display().to_string()),
            _ => VaultError::Io(e),
        })?;
        Ok(Vault {
            root,
            own: OwnWrites::new(),
            devices: this_device().into_iter().collect(),
        })
    }

    pub fn root(&self) -> &Path {
        self.root.path()
    }

    /// The record of this app's own writes, for the vault watch.
    pub fn own_writes(&self) -> &OwnWrites {
        &self.own
    }

    /// Maps a vault-relative path to a location inside the vault, or refuses it.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        self.root.resolve(rel).map_err(|e| outside_or_io(rel, e))
    }

    /// Lists the files directly inside `dir` whose names end with `suffix`, sorted by path, and the
    /// sync clients' conflict copies of such files — a copy's marker goes before the last extension,
    /// so its own name may not end with `suffix`. A missing folder is an empty listing.
    pub fn list(&self, dir: &str, suffix: &str) -> Result<Vec<Entry>> {
        let abs = self.resolve(dir)?;
        let read = match fs::read_dir(&abs) {
            Ok(read) => read,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut entries = Vec::new();
        for item in read {
            let item = item?;
            let meta = item.metadata()?;
            if !meta.is_file() {
                continue;
            }
            let Some(name) = item.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let conflict_of = match self.conflict_copy_of(&abs, &name) {
                Some(original) if original.ends_with(suffix) => Some(format!("{dir}/{original}")),
                Some(_) => continue,
                None if name.ends_with(suffix) => None,
                None => continue,
            };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            entries.push(Entry {
                path: format!("{dir}/{name}"),
                name,
                modified_ms,
                conflict_of,
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// The file `name` in folder `abs` copies, if it is a sync client's conflict copy. A copy named
    /// after a device (OneDrive's `a-<device>.md`) counts only beside its original: by name alone it
    /// could be a name a person chose.
    fn conflict_copy_of(&self, abs: &Path, name: &str) -> Option<String> {
        conflict_copy_of(name).or_else(|| {
            let devices: Vec<&str> = self.devices.iter().map(String::as_str).collect();
            conflict_copy_of_on(name, &devices).filter(|original| abs.join(original).is_file())
        })
    }

    pub fn read(&self, rel: &str) -> Result<String> {
        let abs = self.resolve(rel)?;
        fs::read_to_string(&abs).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound(rel.to_string()),
            _ => VaultError::Io(e),
        })
    }

    /// Reads several files in one go, in order. A file that is gone by the time it is read — removed
    /// between listing and reading — is `None`; any other failure fails the whole read.
    pub fn read_many(&self, rels: &[String]) -> Result<Vec<Option<String>>> {
        rels.iter()
            .map(|rel| match self.read(rel) {
                Ok(content) => Ok(Some(content)),
                Err(VaultError::NotFound(_)) => Ok(None),
                Err(e) => Err(e),
            })
            .collect()
    }

    /// Replaces (or creates) a file atomically.
    pub fn write(&self, rel: &str, content: &str) -> Result<()> {
        let abs = self.prepare(rel)?;
        self.own.record(&abs, content.as_bytes());
        tauri_kit_fs::write_atomic(&abs, content.as_bytes())
            .inspect_err(|_| self.own.forget(&abs))?;
        Ok(())
    }

    /// Replaces a file atomically, but only while it still holds `expected` — what the app last read
    /// or wrote there — so an edit made elsewhere since is not overwritten unseen; otherwise this fails
    /// with [`VaultError::Changed`] and the file is left as it is. A file that is gone is written again:
    /// making it loses nothing. The content is checked again right before the
    /// new content lands, so a lost update is narrowed to that moment; it is not a lock.
    pub fn write_if_unchanged(&self, rel: &str, expected: &str, content: &str) -> Result<()> {
        let abs = self.prepare(rel)?;
        self.own.record(&abs, content.as_bytes());
        let expect = Expect::HoldsOrMissing(expected.as_bytes());
        tauri_kit_fs::replace_if(&abs, expect, content.as_bytes()).map_err(|e| {
            self.own.forget(&abs);
            if is_changed(&e) {
                VaultError::Changed(rel.to_string())
            } else {
                VaultError::Io(e)
            }
        })
    }

    /// Creates a file named `name` in the folder `dir` atomically — or, when something is there
    /// already, under that name numbered: `name (1)`, `name (2)`, …, before the template ending for a
    /// template (`새 서식 (1).fd.md`), before the extension otherwise. It never replaces a file.
    /// Returns the path the file was created at.
    pub fn create(&self, dir: &str, name: &str, content: &str) -> Result<String> {
        if name.contains(['/', '\\']) {
            return Err(VaultError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a file name, not a path",
            )));
        }
        let rel = format!("{dir}/{name}");
        let abs = self.prepare(&rel)?;
        let folder = abs.parent().expect("a file's path has its folder");
        let kind = if name.ends_with(TEMPLATE_SUFFIX) {
            NameKind::Suffix(TEMPLATE_SUFFIX)
        } else {
            NameKind::File
        };
        let (path, ()) = claim_free_path(folder, name, kind, |path| {
            self.own.record(path, content.as_bytes());
            tauri_kit_fs::write_atomic_new(path, content.as_bytes())
                .inspect_err(|_| self.own.forget(path))
        })
        .map_err(|e| match e.kind() {
            io::ErrorKind::AlreadyExists => VaultError::AlreadyExists(rel.clone()),
            _ => VaultError::Io(e),
        })?;
        let created = path.file_name().expect("a claimed path names a file");
        Ok(format!("{dir}/{}", created.to_string_lossy()))
    }

    /// Gives a file another name in the same folder, refusing to replace one that is already there.
    ///
    /// It is a rename, not a copy: the file keeps its creation time and a sync client sees a move.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if src.parent() != dst.parent() {
            return Err(VaultError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a file is renamed within its folder",
            )));
        }
        // The file under its new name is this app's write: the watch does not report it back.
        let content = fs::read(&src).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound(from.to_string()),
            _ => VaultError::Io(e),
        })?;
        self.own.record(&dst, &content);
        tauri_kit_fs::rename_new(&src, &dst).map_err(|e| {
            self.own.forget(&dst);
            match e.kind() {
                io::ErrorKind::AlreadyExists => VaultError::AlreadyExists(to.to_string()),
                io::ErrorKind::NotFound => VaultError::NotFound(from.to_string()),
                _ => VaultError::Io(e),
            }
        })
    }

    /// Moves a file to the operating system's trash, where the person can restore it from.
    ///
    /// A location with no trash (a network share, a removable drive) is not deleted from quietly:
    /// this fails with [`VaultError::NotTrashed`] and the file stays. [`remove`](Self::remove)
    /// deletes for good once the person has chosen that.
    pub fn trash(&self, rel: &str) -> Result<()> {
        let abs = self.existing_file(rel)?;
        // Told to recycle there, Windows deletes for good without asking.
        if !has_trash(&abs) {
            return Err(VaultError::NotTrashed("this location has no trash".into()));
        }
        trash::delete(&abs).map_err(|e| VaultError::NotTrashed(e.to_string()))?;
        if abs.exists() {
            // Declined when the system asked whether to delete for good: nothing was deleted.
            return Err(VaultError::NotTrashed("the file is still there".into()));
        }
        Ok(())
    }

    /// Deletes a file for good. For a file [`trash`](Self::trash) could not move, once the person
    /// has chosen to delete it anyway.
    pub fn remove(&self, rel: &str) -> Result<()> {
        let abs = self.existing_file(rel)?;
        tauri_kit_fs::patiently(|| fs::remove_file(&abs)).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound(rel.to_string()),
            _ => VaultError::Io(e),
        })
    }

    /// The location of a file that is there — not a folder, which the app never deletes.
    fn existing_file(&self, rel: &str) -> Result<PathBuf> {
        let abs = self.resolve(rel)?;
        match fs::symlink_metadata(&abs) {
            Ok(meta) if meta.is_file() => Ok(abs),
            Ok(_) => Err(VaultError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "only a file is deleted",
            ))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Err(VaultError::NotFound(rel.to_string()))
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Appends one line to a file, creating it (and its folders) if needed.
    ///
    /// The line and its newline go out in one write and are flushed to disk before this returns.
    /// A crash can still leave a partial last line; readers skip a line they cannot parse.
    pub fn append_line(&self, rel: &str, line: &str) -> Result<()> {
        let abs = self.prepare(rel)?;
        tauri_kit_fs::append_line(&abs, line)?;
        Ok(())
    }

    fn prepare(&self, rel: &str) -> Result<PathBuf> {
        self.root.prepare(rel).map_err(|e| outside_or_io(rel, e))
    }
}

fn outside_or_io(rel: &str, e: io::Error) -> VaultError {
    if is_outside(&e) {
        VaultError::OutsideVault(rel.to_string())
    } else {
        VaultError::Io(e)
    }
}

/// This computer's name, which OneDrive puts on the conflict copies of changes made here that lost.
/// Windows only: elsewhere the sync clients' names for a device are not this one.
fn this_device() -> Option<String> {
    if cfg!(windows) {
        std::env::var("COMPUTERNAME").ok().filter(|n| !n.is_empty())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_only_what_it_last_read_unless_the_file_is_gone() {
        let (_dir, v) = vault();
        v.write("문서/a.md", "opened").unwrap();
        v.write_if_unchanged("문서/a.md", "opened", "mine").unwrap();
        assert_eq!(v.read("문서/a.md").unwrap(), "mine");

        // Someone else's edit since: left as it is.
        fs::write(v.resolve("문서/a.md").unwrap(), "theirs").unwrap();
        let refused = v.write_if_unchanged("문서/a.md", "mine", "mine again");
        assert!(matches!(refused, Err(VaultError::Changed(_))));
        assert_eq!(refused.unwrap_err().kind(), "changed-outside");
        assert_eq!(v.read("문서/a.md").unwrap(), "theirs");

        // Removed since: made again.
        fs::remove_file(v.resolve("문서/a.md").unwrap()).unwrap();
        v.write_if_unchanged("문서/a.md", "theirs", "made again")
            .unwrap();
        assert_eq!(v.read("문서/a.md").unwrap(), "made again");
    }

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        (dir, vault)
    }

    #[test]
    fn reads_many_files_in_order_and_skips_ones_that_are_gone() {
        let (_dir, v) = vault();
        v.write("문서/a.md", "A").unwrap();
        v.write("문서/b.md", "B").unwrap();
        let read = v
            .read_many(&[
                "문서/b.md".into(),
                "문서/gone.md".into(),
                "문서/a.md".into(),
            ])
            .unwrap();
        assert_eq!(read, [Some("B".into()), None, Some("A".into())]);
        assert!(matches!(
            v.read_many(&["../x.md".into()]),
            Err(VaultError::OutsideVault(_))
        ));
    }

    #[test]
    fn resolves_plain_relative_paths() {
        let (_dir, v) = vault();
        let p = v.resolve("서식/버그 리포트.fd.md").unwrap();
        assert!(p.starts_with(v.root()));
    }

    #[test]
    fn refuses_parent_components() {
        let (_dir, v) = vault();
        for rel in ["..", "../x.md", "서식/../../x.md", "a/../b.md", "./a.md"] {
            assert!(
                matches!(v.resolve(rel), Err(VaultError::OutsideVault(_))),
                "{rel} should be refused"
            );
        }
    }

    #[test]
    fn refuses_absolute_and_empty_paths() {
        let (dir, v) = vault();
        let abs = dir.path().join("a.md");
        for rel in ["", "/a.md", abs.to_str().unwrap()] {
            assert!(
                matches!(v.resolve(rel), Err(VaultError::OutsideVault(_))),
                "{rel:?} should be refused"
            );
        }
        #[cfg(windows)]
        for rel in ["C:\\a.md", "C:a.md", "\\\\server\\share\\a.md"] {
            assert!(
                matches!(v.resolve(rel), Err(VaultError::OutsideVault(_))),
                "{rel:?} should be refused"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_that_leave_the_vault() {
        let (_dir, v) = vault();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), v.root().join("escape")).unwrap();
        assert!(matches!(
            v.resolve("escape/a.md"),
            Err(VaultError::OutsideVault(_))
        ));
        assert!(matches!(
            v.write("escape/a.md", "x"),
            Err(VaultError::OutsideVault(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn refuses_junctions_that_leave_the_vault() {
        let (_dir, v) = vault();
        let outside = tempfile::tempdir().unwrap();
        let link = v.root().join("escape");
        // A directory junction needs no privilege, unlike a symbolic link.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(status.status.success(), "mklink /J failed");
        assert!(matches!(
            v.resolve("escape/a.md"),
            Err(VaultError::OutsideVault(_))
        ));
        assert!(matches!(
            v.write("escape/a.md", "x"),
            Err(VaultError::OutsideVault(_))
        ));
        assert!(!outside.path().join("a.md").exists());
    }

    #[test]
    fn write_then_read_round_trips_and_creates_folders() {
        let (_dir, v) = vault();
        v.write("서식/a.fd.md", "# A\n\n___@title\n").unwrap();
        assert_eq!(v.read("서식/a.fd.md").unwrap(), "# A\n\n___@title\n");
        v.write("서식/a.fd.md", "# A2\n").unwrap();
        assert_eq!(v.read("서식/a.fd.md").unwrap(), "# A2\n");
    }

    #[test]
    fn create_numbers_a_taken_name_and_never_replaces() {
        let (_dir, v) = vault();
        assert_eq!(v.create("문서", "a.md", "first").unwrap(), "문서/a.md");
        assert_eq!(v.create("문서", "a.md", "second").unwrap(), "문서/a (1).md");
        assert_eq!(v.create("문서", "a.md", "third").unwrap(), "문서/a (2).md");
        assert_eq!(v.read("문서/a.md").unwrap(), "first");
        assert_eq!(v.read("문서/a (1).md").unwrap(), "second");

        // A template keeps its whole ending, so it is still read as a template.
        assert_eq!(
            v.create("서식", "새 서식.fd.md", "x").unwrap(),
            "서식/새 서식.fd.md"
        );
        assert_eq!(
            v.create("서식", "새 서식.fd.md", "y").unwrap(),
            "서식/새 서식 (1).fd.md"
        );

        assert!(matches!(
            v.create("문서", "sub/a.md", "z"),
            Err(VaultError::Io(_))
        ));
        assert!(matches!(
            v.create("..", "a.md", "z"),
            Err(VaultError::OutsideVault(_))
        ));
    }

    #[test]
    fn renames_within_a_folder_and_never_replaces() {
        let (_dir, v) = vault();
        v.write("문서/a.md", "first").unwrap();
        v.write("문서/b.md", "second").unwrap();
        assert!(matches!(
            v.rename("문서/a.md", "문서/b.md"),
            Err(VaultError::AlreadyExists(_))
        ));
        assert_eq!(v.read("문서/a.md").unwrap(), "first");
        assert_eq!(v.read("문서/b.md").unwrap(), "second");

        v.rename("문서/a.md", "문서/c.md").unwrap();
        assert_eq!(v.read("문서/c.md").unwrap(), "first");
        assert!(matches!(v.read("문서/a.md"), Err(VaultError::NotFound(_))));
        assert!(matches!(
            v.rename("문서/a.md", "문서/d.md"),
            Err(VaultError::NotFound(_))
        ));
    }

    #[test]
    fn refuses_to_rename_into_another_folder_or_out_of_the_vault() {
        let (_dir, v) = vault();
        v.write("문서/a.md", "first").unwrap();
        assert!(v.rename("문서/a.md", "서식/a.md").is_err());
        assert!(v.rename("문서/a.md", "../a.md").is_err());
        assert_eq!(v.read("문서/a.md").unwrap(), "first");
    }

    /// The file goes to the trash — found there, not deleted — and is purged from it again so the
    /// test leaves nothing behind. The trash is not listable on macOS.
    #[cfg(any(windows, all(unix, not(target_os = "macos"))))]
    #[test]
    fn trashes_a_file_into_the_system_trash() {
        let (_dir, v) = vault();
        v.write("문서/지울 문서.md", "gone").unwrap();
        v.write("문서/남을 문서.md", "stays").unwrap();
        v.trash("문서/지울 문서.md").unwrap();
        assert!(matches!(
            v.read("문서/지울 문서.md"),
            Err(VaultError::NotFound(_))
        ));
        assert_eq!(v.read("문서/남을 문서.md").unwrap(), "stays");

        let folder = v.root().join("문서");
        let trashed: Vec<_> = trash::os_limited::list()
            .unwrap()
            .into_iter()
            .filter(|item| dunce::simplified(&item.original_parent) == folder)
            .collect();
        assert_eq!(trashed.len(), 1, "the file is in the trash");
        assert_eq!(trashed[0].name, "지울 문서.md");
        trash::os_limited::purge_all(trashed).unwrap();
    }

    #[test]
    fn removes_files_only() {
        let (_dir, v) = vault();
        v.write("문서/a.md", "a").unwrap();
        v.remove("문서/a.md").unwrap();
        assert!(matches!(v.read("문서/a.md"), Err(VaultError::NotFound(_))));
        assert!(matches!(
            v.remove("문서/a.md"),
            Err(VaultError::NotFound(_))
        ));
        assert!(matches!(v.trash("문서/a.md"), Err(VaultError::NotFound(_))));
        // A folder is never deleted, and nothing outside the vault is.
        assert!(v.remove("문서").is_err());
        assert!(v.trash("문서").is_err());
        assert!(v.root().join("문서").is_dir());
        assert!(matches!(
            v.trash("../a.md"),
            Err(VaultError::OutsideVault(_))
        ));
    }

    #[test]
    fn read_of_missing_file_is_not_found() {
        let (_dir, v) = vault();
        assert!(matches!(
            v.read("문서/none.md"),
            Err(VaultError::NotFound(_))
        ));
    }

    #[test]
    fn list_filters_by_suffix_and_skips_folders() {
        let (_dir, v) = vault();
        assert!(v.list(TEMPLATES_DIR, TEMPLATE_SUFFIX).unwrap().is_empty());
        v.write("서식/b.fd.md", "b").unwrap();
        v.write("서식/a.fd.md", "a").unwrap();
        v.write("서식/notes.md", "n").unwrap();
        fs::create_dir_all(v.root().join("서식/sub.fd.md")).unwrap();
        let names: Vec<_> = v
            .list(TEMPLATES_DIR, TEMPLATE_SUFFIX)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(names, ["서식/a.fd.md", "서식/b.fd.md"]);
    }

    #[test]
    fn lists_conflict_copies_with_the_file_they_copy() {
        let (_dir, v) = vault();
        v.write("서식/회의.fd.md", "a").unwrap();
        // The marker goes before the last extension: the copy no longer ends in `.fd.md`.
        v.write("서식/회의.fd (김의 충돌된 사본 2026-09-29).md", "b")
            .unwrap();
        v.write("서식/회의.fd.sync-conflict-20260929-143015-ABCDEFG.md", "c")
            .unwrap();
        v.write("서식/메모 (conflicted copy 2026-09-29 143015).md", "d")
            .unwrap();
        let listed: Vec<_> = v
            .list(TEMPLATES_DIR, TEMPLATE_SUFFIX)
            .unwrap()
            .into_iter()
            .map(|e| (e.path, e.conflict_of))
            .collect();
        let original = Some("서식/회의.fd.md".to_string());
        assert_eq!(
            listed,
            [
                (
                    "서식/회의.fd (김의 충돌된 사본 2026-09-29).md".to_string(),
                    original.clone()
                ),
                ("서식/회의.fd.md".to_string(), None),
                (
                    "서식/회의.fd.sync-conflict-20260929-143015-ABCDEFG.md".to_string(),
                    original
                ),
            ]
        );
    }

    #[test]
    fn lists_a_copy_named_after_this_device_only_beside_its_original() {
        let (_dir, mut v) = vault();
        v.devices = vec!["DESK-02".to_string()];
        v.write("문서/접수-1.md", "a").unwrap();
        v.write("문서/접수-1-desk-02.md", "b").unwrap();
        // A person's own name with a dash, and a device's name with no original beside it.
        v.write("문서/회의-서울.md", "c").unwrap();
        v.write("문서/없음-desk-02.md", "d").unwrap();
        let listed: Vec<_> = v
            .list(DOCUMENTS_DIR, DOCUMENT_SUFFIX)
            .unwrap()
            .into_iter()
            .map(|e| (e.path, e.conflict_of))
            .collect();
        assert_eq!(
            listed,
            [
                ("문서/없음-desk-02.md".to_string(), None),
                (
                    "문서/접수-1-desk-02.md".to_string(),
                    Some("문서/접수-1.md".to_string())
                ),
                ("문서/접수-1.md".to_string(), None),
                ("문서/회의-서울.md".to_string(), None),
            ]
        );
    }

    #[test]
    fn appends_lines_creating_the_file_and_its_folders() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        vault
            .append_line(".lowline/events/a.jsonl", r#"{"n":1}"#)
            .unwrap();
        vault
            .append_line(".lowline/events/a.jsonl", r#"{"n":2}"#)
            .unwrap();
        let text = fs::read_to_string(dir.path().join(".lowline/events/a.jsonl")).unwrap();
        assert_eq!(text, "{\"n\":1}\n{\"n\":2}\n");
    }

    #[test]
    fn refuses_a_line_with_a_line_break_or_outside_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        assert!(vault.append_line("log.jsonl", "a\nb").is_err());
        assert!(matches!(
            vault.append_line("../log.jsonl", "a"),
            Err(VaultError::OutsideVault(_))
        ));
    }
}
