#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

// shortcut: content is read from this checkout, so the binary only works on the machine that built it.
// Step 7's packaging decides where plugins live. books/ must stay out of bundle.resources either way.
fn repo_root() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    // dunce, because std's canonicalize gives Windows a \\?\ path in which "/" isn't a separator.
    dunce::canonicalize(root).expect("the repo folder exists")
}

#[tauri::command]
fn content_root() -> String {
    repo_root().to_string_lossy().into_owned()
}

// The page can only write saves through these commands, which reach nothing but app_data_dir()/saves.
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
fn save_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let bare = !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.%".contains(c));
    if !bare {
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // The capability grants read commands with no paths, so these folders are all they can reach.
            // books/ also holds importer working files the game never reads, so only its game folders are in.
            // Keep in step with BOOK_FOLDERS in engine/platform/browser/content-path.ts.
            let root = repo_root();
            app.fs_scope().allow_directory(root.join("plugins"), true)?;
            for folder in ["adventures", "rules", "assets", "library"] {
                app.fs_scope()
                    .allow_directory(root.join("books").join(folder), true)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            content_root,
            save_read,
            save_write,
            save_list,
            save_remove
        ])
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}
