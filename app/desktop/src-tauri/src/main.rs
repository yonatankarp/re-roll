#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use tauri_plugin_fs::FsExt;

// shortcut: content is read from this checkout, so the binary only works on the machine that built it.
// Step 7's packaging decides where plugins live. books/ must stay out of bundle.resources either way.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("the repo folder exists")
}

#[tauri::command]
fn content_root() -> String {
    repo_root().to_string_lossy().into_owned()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // The capability grants read commands with no paths, so these two folders are all they can reach.
            let root = repo_root();
            for folder in ["plugins", "books"] {
                app.fs_scope().allow_directory(root.join(folder), true)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![content_root])
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}
