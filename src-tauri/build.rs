fn main() {
    // Windows/MSVC: o manifesto (Common Controls v6) é embutido pelo linker em
    // TODOS os executáveis — inclusive o binário de `cargo test`, que sem ele
    // aborta com STATUS_ENTRYPOINT_NOT_FOUND. Por isso o tauri-build não gera o
    // manifesto padrão (seria duplicado no app). Conteúdo idêntico ao padrão.
    let msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("tauri-build falhou");
    } else {
        tauri_build::build()
    }
}
