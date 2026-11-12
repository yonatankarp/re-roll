#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Manager, State};
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let content = find_roots(app).and_then(|roots| allow(app, &roots).map(|()| roots));
            app.manage::<Content>(content);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![content_roots, open_content_folder])
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}
