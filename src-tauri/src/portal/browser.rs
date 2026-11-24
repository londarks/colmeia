// Descoberta e lançamento do Chromium do sistema para os portais.
//
// - Procura Edge/Chrome/Chromium/Brave nos caminhos padrão de cada SO (ou o
//   executável em `COLMEIA_BROWSER`).
// - Sobe em `--headless=new` com `--user-data-dir` próprio (perfil isolado do
//   navegador do usuário) e `--remote-debugging-port=0`: o Chromium escolhe uma
//   porta livre, escuta só em 127.0.0.1 e grava a porta em `DevToolsActivePort`
//   dentro do user-data-dir.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Navegador lançado: processo + porta do DevTools (sempre em 127.0.0.1).
pub struct Launched {
    pub child: Child,
    pub port: u16,
}

/// Executável do Chromium a usar (None = nenhum encontrado).
pub fn find_browser() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("COLMEIA_BROWSER") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    candidates().into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ];
    let roots: Vec<String> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .collect();
    for root in &roots {
        let r = PathBuf::from(root);
        out.push(r.join(r"Microsoft\Edge\Application\msedge.exe"));
        out.push(r.join(r"Google\Chrome\Application\chrome.exe"));
        out.push(r.join(r"Chromium\Application\chrome.exe"));
        out.push(r.join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
    }
    out
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Ok(home) = std::env::var("HOME") {
        out.push(PathBuf::from(home).join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
    }
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates() -> Vec<PathBuf> {
    let names = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "brave-browser",
    ];
    let mut out = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for n in names {
                out.push(dir.join(n));
            }
        }
    }
    out.push(PathBuf::from("/snap/bin/chromium"));
    out
}

/// Lê a porta (1ª linha) e o caminho do endpoint do navegador (2ª linha) do
/// `DevToolsActivePort`.
fn read_active_port(profile: &Path) -> Option<(u16, String)> {
    let s = fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = s.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    if port == 0 {
        return None;
    }
    let path = lines.next().unwrap_or("").trim().to_string();
    Some((port, path))
}

/// Se um navegador órfão (app anterior que caiu) ainda usa este perfil, pede
/// para ele fechar — senão o novo processo só repassaria a URL para o antigo
/// e sairia (o Chromium permite uma instância por user-data-dir).
fn close_orphan(profile: &Path) {
    let Some((port, path)) = read_active_port(profile) else {
        return;
    };
    if !path.starts_with("/devtools/browser/") {
        return;
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return;
    };
    let url = format!("ws://127.0.0.1:{port}{path}");
    if let Ok((mut ws, _)) = tungstenite::client(url.as_str(), stream) {
        let _ = ws.send(tungstenite::Message::text(
            r#"{"id":1,"method":"Browser.close"}"#.to_string(),
        ));
        std::thread::sleep(Duration::from_millis(1200));
    }
}

/// Sobe o navegador headless com o perfil `profile` e espera a porta do DevTools.
pub fn launch(exe: &Path, profile: &Path, width: u32, height: u32) -> Result<Launched, String> {
    fs::create_dir_all(profile)
        .map_err(|e| format!("não consegui criar o perfil do portal ({}): {e}", profile.display()))?;
    close_orphan(profile);
    let marker = profile.join("DevToolsActivePort");
    let _ = fs::remove_file(&marker);

    let mut cmd = Command::new(exe);
    cmd.arg("--headless=new")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--window-size={width},{height}"))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg("--disable-sync")
        .arg("--disable-default-apps")
        .arg("--disable-component-update")
        .arg("--mute-audio")
        .arg("--password-store=basic")
        .arg("--use-mock-keychain")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: nada de console piscando.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("não consegui abrir {}: {e}", exe.display()))?;

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some((port, _)) = read_active_port(profile) {
            return Ok(Launched { child, port });
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "o navegador ({}) encerrou logo ao abrir ({status}). Se houver um processo dele \
preso usando o perfil {}, feche-o e tente de novo.",
                exe.display(),
                profile.display()
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("o navegador não abriu a porta do DevTools em 20 s.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// GET em `http://127.0.0.1:<porta><path>` do DevTools (JSON).
fn devtools_json(port: u16, path: &str, put: bool) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let req = if put { ureq::put(&url) } else { ureq::get(&url) };
    let resp = req
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|e| e.to_string())?;
    resp.into_json::<Value>().map_err(|e| e.to_string())
}

/// Id do alvo "page" (aba) do navegador; cria uma aba se não houver.
pub fn page_target(port: u16) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last_err = String::new();
    while Instant::now() < deadline {
        match devtools_json(port, "/json/list", false) {
            Ok(Value::Array(list)) => {
                let page = list.iter().find(|t| {
                    t.get("type").and_then(Value::as_str) == Some("page")
                });
                if let Some(id) = page.and_then(|t| t.get("id")).and_then(Value::as_str) {
                    return Ok(id.to_string());
                }
                // Sem aba: pede uma nova (o Chromium exige PUT).
                if let Ok(t) = devtools_json(port, "/json/new?about:blank", true) {
                    if let Some(id) = t.get("id").and_then(Value::as_str) {
                        return Ok(id.to_string());
                    }
                }
            }
            Ok(_) => last_err = "resposta inesperada de /json/list".into(),
            Err(e) => last_err = e,
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("não achei a aba do navegador: {last_err}"))
}

/// User-Agent do navegador sem o "Headless" (alguns sites bloqueiam).
pub fn user_agent(port: u16) -> Option<String> {
    let v = devtools_json(port, "/json/version", false).ok()?;
    let ua = v.get("User-Agent").and_then(Value::as_str)?;
    Some(ua.replace("HeadlessChrome", "Chrome").replace("Headless", ""))
}
