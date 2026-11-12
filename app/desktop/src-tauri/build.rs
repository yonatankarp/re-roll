fn main() {
    // Listing the app's commands makes them need a grant in capabilities/, like the plugins' commands.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "content_roots",
            "open_content_folder",
            "save_read",
            "save_write",
            "save_list",
            "save_remove",
        ]),
    ))
    .expect("the Tauri build step failed");
}
