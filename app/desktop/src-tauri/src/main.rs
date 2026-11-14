#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::FsExt;

// The page's two content roots: "plugins" ships with the game, "books" holds the player's own plugins.
#[derive(Clone)]
struct Roots {
    plugins: PathBuf,
    books: PathBuf,
}

// Kept as a Result so a missing folder reaches the page as a message instead of stopping the app.
type Content = Result<Roots, String>;

// books/ also holds importer working files the game never reads, so only its game folders are in.
// Keep in step with BOOK_FOLDERS in engine/platform/browser/content-path.ts.
const BOOK_FOLDERS: [&str; 4] = ["adventures", "rules", "assets", "library"];

// dunce, because std's canonicalize gives Windows a \\?\ path in which "/" isn't a separator.
fn canonical(path: PathBuf, what: &str) -> Result<PathBuf, String> {
    dunce::canonicalize(&path)
        .map_err(|error| format!("Couldn't find {what} at {}: {error}", path.display()))
}

// `npm run desktop` reads this checkout, so content edits show without a build.
#[cfg(dev)]
fn find_roots(_app: &tauri::App) -> Content {
    let repo = canonical(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."),
        "the checkout",
    )?;
    Ok(Roots {
        plugins: repo.join("plugins"),
        books: repo.join("books"),
    })
}

// A built app reads the plugins it ships with, and the player's own from the content folder.
#[cfg(not(dev))]
fn find_roots(app: &tauri::App) -> Content {
    let paths = app.path();
    let resources = paths.resource_dir().map_err(|error| error.to_string())?;
    let books = paths
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("plugins");
    // Made with its folders, so a player who opens it sees where adventures and rules go.
    for folder in BOOK_FOLDERS {
        std::fs::create_dir_all(books.join(folder)).map_err(|error| {
            format!(
                "Couldn't make the content folder {}: {error}",
                books.display()
            )
        })?;
    }
    Ok(Roots {
        plugins: canonical(resources.join("plugins"), "the game's own content")?,
        books: canonical(books, "the content folder")?,
    })
}

// The capability grants read commands with no paths, so these folders are all they can reach.
fn allow(app: &tauri::App, roots: &Roots) -> Result<(), String> {
    let scope = app.fs_scope();
    scope
        .allow_directory(&roots.plugins, true)
        .map_err(|error| error.to_string())?;
    for folder in BOOK_FOLDERS {
        scope
            .allow_directory(roots.books.join(folder), true)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn content_roots(content: State<Content>) -> Result<HashMap<&'static str, String>, String> {
    let roots = content.inner().clone()?;
    Ok(HashMap::from([
        ("plugins", roots.plugins.to_string_lossy().into_owned()),
        ("books", roots.books.to_string_lossy().into_owned()),
    ]))
}

// Shows the player's content folder in the OS's file manager. It takes no path, so the page can't open anything else.
#[tauri::command]
fn open_content_folder(content: State<Content>) -> Result<(), String> {
    let folder = content.inner().clone()?.books;
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(not(any(target_os = "macos", windows)))]
    let program = "xdg-open";
    // Not waited on for its status, since explorer exits with 1 even when it opens the folder.
    let mut child = std::process::Command::new(program)
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("Couldn't open {}: {error}", folder.display()))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

// The page writes saves only through these commands, which reach nothing but app_data_dir()/saves,
// and content only through the content_install_* commands below.
// The fs plugin's write commands stay ungranted: its global scope holds the content folders,
// so a write grant would let the page write there too.
fn saves_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("saves");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

// One bare file name, as the page encodes it (engine/platform/tauri/saves.ts), so no path can climb out.
fn is_save_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.%".contains(c))
}

fn save_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !is_save_name(name) {
        return Err(format!("{name} isn't a save file name"));
    }
    Ok(saves_dir(app)?.join(name))
}

// Empty for a missing save, since a real one is never empty.
#[tauri::command]
fn save_read(app: AppHandle, name: String) -> Result<Response, String> {
    match fs::read(save_path(&app, &name)?) {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Response::new(Vec::new())),
        Err(error) => Err(error.to_string()),
    }
}

// The bytes come as the raw request body, with the name in a header, so they aren't sent as JSON numbers.
// Written to a temporary file and renamed over the save, so a crash never leaves half a save.
#[tauri::command]
fn save_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let name = request
        .headers()
        .get("name")
        .and_then(|value| value.to_str().ok())
        .ok_or("the save has no name")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("the save isn't raw bytes".into());
    };
    let path = save_path(&app, name)?;
    let temporary = path.with_file_name(format!(".{name}.tmp"));
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_list(app: AppHandle) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(saves_dir(&app)?).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with('.') && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            names.push(name);
        }
    }
    Ok(names)
}

#[tauri::command]
fn save_remove(app: AppHandle, name: String) -> Result<(), String> {
    match fs::remove_file(save_path(&app, &name)?) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    }
}

// Installing content from a zip (engine/platform/tauri/install.ts), which unzips and checks it first.
// These write only inside the content folder's game folders, and check every path again here.
// Each part is a folder, such as rules/phb or assets/phb, or one of SHARED_FILES.
// Keep the file types in step with FILE_TYPES there: data only, so nothing installed can run.
const PART_FILE_TYPES: [(&str, &[&str]); 4] = [
    ("adventures", &PLUGIN_FILE_TYPES),
    ("rules", &PLUGIN_FILE_TYPES),
    ("assets", &["png", "jpg", "jpeg", "webp", "gif", "json"]),
    ("library", &["md", "json"]),
];
// The loader's ALLOWED_EXTENSIONS in engine/run/loader.ts.
const PLUGIN_FILE_TYPES: [&str; 10] = [
    "yaml", "md", "txt", "png", "jpg", "jpeg", "webp", "mp3", "ogg", "wav",
];
const SHARED_FILES: [&str; 1] = ["library/glossary.json"];

// PLUGIN_ID_PATTERN in engine/kernel/manifest.ts, which book folder names follow too.
fn is_part_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

fn file_types(folder: &str) -> Option<&'static [&'static str]> {
    PART_FILE_TYPES
        .iter()
        .find(|(name, _)| *name == folder)
        .map(|(_, types)| *types)
}

// A relative path of plain names with a file type its folder may hold, so nothing lands outside the part.
// ":" is out too, as Windows reads it as a drive or a stream.
fn is_part_file(folder: &str, path: &str) -> bool {
    let Some(types) = file_types(folder) else {
        return false;
    };
    let typed = path.rsplit_once('.').is_some_and(|(stem, kind)| {
        !stem.is_empty()
            && !stem.ends_with('/')
            && types.contains(&kind.to_ascii_lowercase().as_str())
    });
    typed
        && path.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.contains(['\\', ':', '\0', '\n'])
        })
}

// The part and the hidden name it is written to first, which the loader passes by.
fn part_paths(content: &Content, folder: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    if file_types(folder).is_none() || !is_part_name(name) {
        return Err(format!("{folder}/{name} isn't a content folder"));
    }
    let parent = content.clone()?.books.join(folder);
    Ok((
        parent.join(name),
        parent.join(format!(".{name}.installing")),
    ))
}

fn is_shared(folder: &str, name: &str) -> bool {
    SHARED_FILES.contains(&format!("{folder}/{name}").as_str())
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

// Async, so a big install runs off the main thread and the window keeps drawing.
#[tauri::command]
async fn content_install_begin(
    content: State<'_, Content>,
    folder: String,
    name: String,
) -> Result<(), String> {
    let (_, staging) = part_paths(content.inner(), &folder, &name)?;
    remove_any(&staging).map_err(|error| error.to_string())?;
    if is_shared(&folder, &name) {
        return Ok(());
    }
    fs::create_dir_all(&staging).map_err(|error| error.to_string())
}

// The body is "<folder>/<name>/<path>\n", or "<folder>/<name>\n" for a shared file, and then the file's bytes, raw.
#[tauri::command]
async fn content_install_file(
    content: State<'_, Content>,
    request: Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("the file isn't raw bytes".into());
    };
    let line = body
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or("the file has no path")?;
    let head = std::str::from_utf8(&body[..line]).map_err(|error| error.to_string())?;
    let mut parts = head.splitn(3, '/');
    let (Some(folder), Some(name)) = (parts.next(), parts.next()) else {
        return Err(format!("{head} isn't a content file"));
    };
    let (_, staging) = part_paths(content.inner(), folder, name)?;
    let file = match parts.next() {
        None if is_shared(folder, name) => staging,
        Some(path) if !is_shared(folder, name) && is_part_file(folder, path) => {
            if !staging.is_dir() {
                return Err(format!("{folder}/{name} isn't being installed"));
            }
            staging.join(path)
        }
        _ => return Err(format!("{head} isn't a file {folder}/ may hold")),
    };
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&file, &body[line + 1..]).map_err(|error| error.to_string())
}

#[tauri::command]
async fn content_install_commit(
    content: State<'_, Content>,
    folder: String,
    name: String,
) -> Result<bool, String> {
    let (target, staging) = part_paths(content.inner(), &folder, &name)?;
    swap_in(&staging, &target)
}

// Swaps the new copy in, and says whether there was one to replace. A folder can't be renamed onto
// another on Windows, so the old copy moves aside first, to a hidden name the loader never reads.
fn swap_in(staging: &Path, target: &Path) -> Result<bool, String> {
    if !staging.exists() {
        return Err(format!("nothing was written for {}", target.display()));
    }
    let name = target.file_name().ok_or("the part has no name")?;
    let old = target.with_file_name(format!(".{}.old", name.to_string_lossy()));
    let _ = remove_any(&old);
    let replacing = target.exists();
    if replacing {
        fs::rename(target, &old).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(staging, target) {
        if replacing {
            let _ = fs::rename(&old, target);
        }
        return Err(error.to_string());
    }
    let _ = remove_any(&old);
    Ok(replacing)
}

// The Store (engine/shell/store.ts) reads a GitHub repo's "store" release: store.json and a zip
// per package. The page names the repo and the file, and these build the URLs, so they can't be sent anywhere else.
const STORE_TAG: &str = "store";
const STORE_INDEX: &str = "store.json";
const KEYCHAIN: &str = "app.re-roll.desktop.store";
// install.ts refuses a zip that unpacks to more than 4 GB, so a bigger download is refused before that.
const MAX_DOWNLOAD: u64 = 4 * 1024 * 1024 * 1024;

// Tokens kept only while the app is open, when the OS has no keychain to keep them in.
#[derive(Default)]
struct SessionTokens(Mutex<HashMap<String, String>>);

// GitHub's own rules for an owner and a repository name.
fn is_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    (1..=39).contains(&owner.len())
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !owner.starts_with('-')
        && (1..=100).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && name != "."
        && name != ".."
}

fn is_store_file(file: &str) -> bool {
    file == STORE_INDEX || file.strip_suffix(".zip").is_some_and(is_part_name)
}

fn keychain_entry(repo: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN, repo)
}

fn session_token(session: &SessionTokens, repo: &str) -> Option<String> {
    session.0.lock().ok()?.get(repo).cloned()
}

fn keychain_token(repo: &str) -> Option<String> {
    keychain_entry(repo)
        .and_then(|entry| entry.get_password())
        .ok()
}

// The keychain and the network block, and on Linux the keychain runs its own async runtime,
// so both run on a thread of their own rather than on the app's async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())
}

fn status_message(error: ureq::Error, repo: &str, file: &str) -> String {
    match error {
        ureq::Error::StatusCode(401) => format!("GitHub refused the token for {repo}."),
        ureq::Error::StatusCode(403) => {
            format!("GitHub won't let this app read {repo} right now. Try again later, or add a token.")
        }
        ureq::Error::StatusCode(404) => format!(
            "{repo} has no {file} in a \"{STORE_TAG}\" release. If it's a private repo, add a token that can read it."
        ),
        other => format!("Couldn't download {file} from {repo}: {other}"),
    }
}

// A public repo's file comes from its download link, which isn't held to the API's hourly limit.
// A private one needs the API, with the token. ureq drops the token on the redirect to the file's host.
// No timeout on the whole download, since a big book on a slow line takes a while, but a host that
// never answers fails rather than leaving the game waiting.
fn download(repo: &str, file: &str, token: Option<&str>) -> Result<Vec<u8>, ureq::Error> {
    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .new_agent();
    let mut response = match token {
        None => agent
            .get(format!(
                "https://github.com/{repo}/releases/download/{STORE_TAG}/{file}"
            ))
            .call()?,
        Some(token) => {
            let bearer = format!("Bearer {token}");
            let release = agent
                .get(format!(
                    "https://api.github.com/repos/{repo}/releases/tags/{STORE_TAG}"
                ))
                .header("Accept", "application/vnd.github+json")
                .header("Authorization", &bearer)
                .call()?
                .body_mut()
                .read_to_string()?;
            let release: serde_json::Value = serde_json::from_str(&release)
                .map_err(|error| ureq::Error::Io(std::io::Error::other(error)))?;
            let asset = release["assets"]
                .as_array()
                .and_then(|assets| assets.iter().find(|asset| asset["name"] == file))
                .and_then(|asset| asset["id"].as_u64())
                .ok_or(ureq::Error::StatusCode(404))?;
            agent
                .get(format!(
                    "https://api.github.com/repos/{repo}/releases/assets/{asset}"
                ))
                .header("Accept", "application/octet-stream")
                .header("Authorization", &bearer)
                .call()?
        }
    };
    response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD)
        .read_to_vec()
}

#[tauri::command]
async fn store_fetch(
    session: State<'_, SessionTokens>,
    repo: String,
    file: String,
) -> Result<Response, String> {
    if !is_repo(&repo) || !is_store_file(&file) {
        return Err(format!("{repo}/{file} isn't a store file"));
    }
    let session = session_token(&session, &repo);
    let bytes = blocking(move || {
        let token = session.or_else(|| keychain_token(&repo));
        download(&repo, &file, token.as_deref())
            .map_err(|error| status_message(error, &repo, &file))
    })
    .await??;
    Ok(Response::new(bytes))
}

// Says whether the OS keychain kept it. If it can't, the token lasts until the app closes.
// The page never reads a token back.
#[tauri::command]
async fn store_token_set(
    session: State<'_, SessionTokens>,
    repo: String,
    token: String,
) -> Result<bool, String> {
    let token = token.trim().to_owned();
    if !is_repo(&repo)
        || token.is_empty()
        || token.len() > 255
        || !token.chars().all(|c| c.is_ascii_graphic())
    {
        return Err("That isn't a GitHub token.".into());
    }
    let (key, secret) = (repo.clone(), token.clone());
    let saved = blocking(move || {
        keychain_entry(&key)
            .and_then(|entry| entry.set_password(&secret))
            .is_ok()
    })
    .await?;
    let mut kept = session.0.lock().map_err(|error| error.to_string())?;
    if saved {
        kept.remove(&repo);
    } else {
        kept.insert(repo, token);
    }
    Ok(saved)
}

#[tauri::command]
async fn store_token_forget(session: State<'_, SessionTokens>, repo: String) -> Result<(), String> {
    if !is_repo(&repo) {
        return Err(format!("{repo} isn't a GitHub repo"));
    }
    session
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&repo);
    match blocking(move || keychain_entry(&repo).and_then(|entry| entry.delete_credential()))
        .await?
    {
        Ok(()) | Err(keyring::Error::NoEntry) | Err(keyring::Error::NoDefaultStore) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn store_token_has(session: State<'_, SessionTokens>, repo: String) -> Result<bool, String> {
    if !is_repo(&repo) {
        return Ok(false);
    }
    if session_token(&session, &repo).is_some() {
        return Ok(true);
    }
    blocking(move || keychain_token(&repo).is_some()).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let content = find_roots(app).and_then(|roots| allow(app, &roots).map(|()| roots));
            app.manage::<Content>(content);
            app.manage(SessionTokens::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            content_roots,
            open_content_folder,
            save_read,
            save_write,
            save_list,
            save_remove,
            content_install_begin,
            content_install_file,
            content_install_commit,
            store_fetch,
            store_token_set,
            store_token_forget,
            store_token_has
        ])
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}

#[cfg(test)]
mod tests {
    use super::{is_part_file, is_part_name, is_repo, is_save_name, is_store_file, swap_in};

    #[test]
    fn store_requests_name_only_a_repo_and_a_store_file() {
        for repo in ["owner/repo", "a-b/c.d_e", "yonatankarp/re-roll-books"] {
            assert!(is_repo(repo), "{repo:?} should pass");
        }
        for repo in [
            "",
            "owner",
            "owner/",
            "/repo",
            "a/b/c",
            "-a/b",
            "a/..",
            "a/.",
            "a b/c",
            "a/b?x",
            "a/b#c",
            "a@evil.com/b",
        ] {
            assert!(!is_repo(repo), "{repo:?} should be refused");
        }
        assert!(is_store_file("store.json"));
        assert!(is_store_file("phb.zip"));
        for file in [
            "",
            ".zip",
            "phb",
            "../phb.zip",
            "a/b.zip",
            "Phb.zip",
            "store.yaml",
            "phb.zip?x",
        ] {
            assert!(!is_store_file(file), "{file:?} should be refused");
        }
    }
    use std::fs;

    #[test]
    fn a_new_copy_replaces_the_old_one() {
        let parent = std::env::temp_dir().join(format!("re-roll-swap-{}", std::process::id()));
        let (target, staging) = (parent.join("x"), parent.join(".x.installing"));
        fs::create_dir_all(target.join("art")).unwrap();
        fs::write(target.join("art/old.png"), "old").unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("plugin.yaml"), "new").unwrap();
        assert!(swap_in(&staging, &target).unwrap());
        assert_eq!(
            fs::read_to_string(target.join("plugin.yaml")).unwrap(),
            "new"
        );
        assert!(!target.join("art").exists());
        assert!(!staging.exists());
        assert_eq!(
            fs::read_dir(&parent).unwrap().count(),
            1,
            "the old copy is gone"
        );
        // Nothing staged keeps the plugin that is there.
        assert!(swap_in(&staging, &target).is_err());
        assert!(target.join("plugin.yaml").exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn installed_files_stay_in_their_folder() {
        assert!(is_part_name("goblin-ambush"));
        assert!(is_part_name("srd5.2"));
        for name in ["", ".", "..", "-x", "Goblin", "a/b", "a\\b", "a b"] {
            assert!(!is_part_name(name), "{name:?} should be refused");
        }
        assert!(is_part_file("adventures", "plugin.yaml"));
        assert!(is_part_file("rules", "monsters/goblin.yaml"));
        assert!(is_part_file("adventures", "art/Scene 1.PNG"));
        assert!(is_part_file("assets", "index.json"));
        assert!(is_part_file("library", "0001-introduction.md"));
        for (folder, path) in [
            ("adventures", ""),
            ("adventures", "/plugin.yaml"),
            ("adventures", "../plugin.yaml"),
            ("adventures", "a/../../x.yaml"),
            ("adventures", "a//b.yaml"),
            ("adventures", ".hidden.yaml"),
            ("adventures", "a/.git/config.yaml"),
            ("adventures", "a\\b.yaml"),
            ("adventures", "c:x.yaml"),
            ("adventures", "run.sh"),
            ("adventures", "page.svg"),
            ("adventures", "script.mjs"),
            ("adventures", "yaml"),
            ("adventures", "a/.yaml"),
            ("adventures", "plugin"),
            ("adventures", "data.json"),
            ("assets", "notes.md"),
            ("library", "cover.webp"),
            ("sources", "book.md"),
            ("saves", "x.json"),
        ] {
            assert!(
                !is_part_file(folder, path),
                "{folder}/{path:?} should be refused"
            );
        }
    }

    #[test]
    fn save_names_stay_in_the_saves_folder() {
        assert!(is_save_name("goblin-ambush-run-autosave.json.gz"));
        assert!(is_save_name("details.gz"));
        assert!(is_save_name("%2E%2E%2Fescape.json.gz"));
        for name in [
            "",
            ".",
            "..",
            "../x",
            "a/b",
            "a\\b",
            ".hidden.tmp",
            "c:x",
            "a b",
            "ü",
        ] {
            assert!(!is_save_name(name), "{name:?} should be refused");
        }
    }
}
