// Ações de alto nível de um portal (o que a CLI e o nó do canvas pedem).
// Rodam na thread de quem chamou, falando com a página por `Session::call`.
// Respostas: Ok(texto) — se começar com "aviso:", o servidor marca como aviso;
// Err(Fail) — código HTTP + mensagem com o próximo passo.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use base64::Engine;
use serde_json::{json, Value};

use super::cdp::Session;

const SNAPSHOT_JS: &str = include_str!("snapshot.js");
const TARGET_JS: &str = include_str!("target.js");

/// Faz links `target=_blank` e `window.open` abrirem na própria aba: o portal
/// tem uma aba só (popups/OAuth em outra aba ainda não são suportados).
const SAME_TAB_JS: &str = r#"(function () {
  try {
    window.open = function (u) {
      if (u) location.href = new URL(String(u), location.href).href;
      return window;
    };
    document.addEventListener("click", function (e) {
      var t = e.target;
      var a = t && t.closest ? t.closest("a[target]") : null;
      if (a && ["_self", "_parent", "_top"].indexOf(a.target) < 0) a.target = "_self";
    }, true);
  } catch (e) {}
})();"#;

const T_CALL: Duration = Duration::from_secs(10);
const T_EVAL: Duration = Duration::from_secs(15);

pub const PASSWORD_REFUSAL: &str = "Recusado: esse campo é de senha. O colmeia não deixa agentes \
digitarem senhas — peça ao usuário para preenchê-la direto no portal (clicando no quadro do navegador \
no canvas e digitando).";

pub struct Fail {
    pub code: u16,
    pub msg: String,
}

impl Fail {
    pub fn new(code: u16, msg: impl Into<String>) -> Self {
        Fail {
            code,
            msg: msg.into(),
        }
    }
}

impl From<String> for Fail {
    fn from(msg: String) -> Self {
        Fail { code: 502, msg }
    }
}

pub type Res = Result<String, Fail>;

// ── Alvos ────────────────────────────────────────────────────────────────

/// Alvo de uma ação: ref do snapshot, seletor CSS (compat) ou ponto x,y (px CSS).
pub enum Target {
    Ref(String),
    Css(String),
    Point(f64, f64),
}

impl Target {
    pub fn parse(s: &str) -> Option<Target> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let bare = t.strip_prefix('@').unwrap_or(t);
        if bare.len() > 1
            && bare.starts_with('e')
            && bare[1..].chars().all(|c| c.is_ascii_digit())
        {
            return Some(Target::Ref(bare.to_string()));
        }
        if let Some((a, b)) = t.split_once(',') {
            if let (Ok(x), Ok(y)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                return Some(Target::Point(x, y));
            }
        }
        if t.starts_with('@') {
            return None;
        }
        Some(Target::Css(t.to_string()))
    }

    fn describe(&self) -> String {
        match self {
            Target::Ref(r) => format!("@{r}"),
            Target::Css(c) => format!("\"{c}\""),
            Target::Point(x, y) => format!("{x},{y}"),
        }
    }

    fn spec(&self, op: &str, value: Option<&str>) -> Value {
        match self {
            Target::Ref(r) => json!({ "ref": r, "op": op, "value": value }),
            Target::Css(c) => json!({ "css": c, "op": op, "value": value }),
            Target::Point(_, _) => json!({ "op": op }),
        }
    }
}

fn missing(t: &Target) -> Fail {
    match t {
        Target::Ref(r) => Fail::new(
            404,
            format!(
                "Não achei @{r} na página atual — ela mudou desde o último snapshot. Rode \
`colmeia portal snapshot` e use os refs novos."
            ),
        ),
        Target::Css(c) => Fail::new(
            404,
            format!(
                "Nenhum elemento casa com o seletor \"{c}\". Rode `colmeia portal snapshot` e use um ref @eN."
            ),
        ),
        Target::Point(_, _) => Fail::new(400, "Ponto inválido."),
    }
}

/// Roda `target.js` com `op` sobre o alvo. Erro "missing" vira mensagem clara.
fn run_target(s: &Session, t: &Target, op: &str, value: Option<&str>) -> Result<Value, Fail> {
    let expr = format!("({})({})", TARGET_JS, t.spec(op, value));
    let v = s.eval(&expr, T_EVAL)?;
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        if err == "missing" {
            return Err(missing(t));
        }
        if err.starts_with("seletor CSS inválido") {
            return Err(Fail::new(400, err.to_string()));
        }
    }
    Ok(v)
}

struct Located {
    x: f64,
    y: f64,
    desc: String,
    editable: bool,
    select: bool,
    password: bool,
    disabled: bool,
    covered: String,
    type_: String,
}

fn locate(s: &Session, t: &Target) -> Result<Located, Fail> {
    if let Target::Point(x, y) = t {
        return Ok(Located {
            x: *x,
            y: *y,
            desc: format!("{x},{y}"),
            editable: false,
            select: false,
            password: false,
            disabled: false,
            covered: String::new(),
            type_: String::new(),
        });
    }
    let v = run_target(s, t, "locate", None)?;
    let str_of = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let bool_of = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let tag = str_of("tag");
    let type_ = str_of("type");
    let label = str_of("label");
    let kind = if type_.is_empty() {
        tag.clone()
    } else {
        format!("{tag}[{type_}]")
    };
    let desc = if label.is_empty() {
        format!("{} {kind}", t.describe())
    } else {
        format!("{} {kind} \"{label}\"", t.describe())
    };
    Ok(Located {
        x: v.get("x").and_then(Value::as_f64).unwrap_or(0.0),
        y: v.get("y").and_then(Value::as_f64).unwrap_or(0.0),
        desc,
        editable: bool_of("editable"),
        select: bool_of("select"),
        password: bool_of("password"),
        disabled: bool_of("disabled"),
        covered: str_of("covered"),
        type_,
    })
}

// ── Preparação e navegação ───────────────────────────────────────────────

/// Liga os domínios e ajustes da aba recém-conectada.
pub fn setup(s: &Session, user_agent: Option<String>) -> Result<(), String> {
    s.call("Page.enable", json!({}), T_CALL)?;
    if let Ok(tree) = s.call("Page.getFrameTree", json!({}), T_CALL) {
        let mut st = s.state.lock().unwrap();
        if let Some(id) = tree.pointer("/frameTree/frame/id").and_then(Value::as_str) {
            st.main_frame = id.to_string();
        }
        if let Some(u) = tree.pointer("/frameTree/frame/url").and_then(Value::as_str) {
            st.url = u.to_string();
        }
    }
    s.call(
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": SAME_TAB_JS }),
        T_CALL,
    )?;
    if let Some(ua) = user_agent {
        let _ = s.call(
            "Emulation.setUserAgentOverride",
            json!({ "userAgent": ua }),
            T_CALL,
        );
    }
    // A página se comporta como focada mesmo com o app em segundo plano.
    let _ = s.call(
        "Emulation.setFocusEmulationEnabled",
        json!({ "enabled": true }),
        T_CALL,
    );
    let (w, h) = *s.viewport.lock().unwrap();
    s.resize(w, h);
    Ok(())
}

/// Normaliza o que o usuário/agente digitou numa URL http(s).
pub fn normalize_url(raw: &str) -> Option<String> {
    let u = raw.trim();
    if u.is_empty() {
        return None;
    }
    let lower = u.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower == "about:blank" {
        return Some(u.to_string());
    }
    if lower.contains("://") || lower.starts_with("javascript:") || lower.starts_with("data:") {
        return None;
    }
    let local = lower.starts_with("localhost")
        || lower.starts_with("127.")
        || lower.starts_with("0.0.0.0")
        || lower.starts_with("[::1]");
    Some(if local {
        format!("http://{u}")
    } else {
        format!("https://{u}")
    })
}

/// Navega e espera o load. Ok(true) = carregou; Ok(false) = ainda carregando.
pub fn navigate(s: &Session, url: &str) -> Result<bool, String> {
    let seq = s.load_seq();
    s.mark_active();
    let r = s.call(
        "Page.navigate",
        json!({ "url": url }),
        Duration::from_secs(30),
    )?;
    if let Some(e) = r.get("errorText").and_then(Value::as_str) {
        if !e.is_empty() {
            return Err(format!("não consegui abrir {url}: {e}"));
        }
    }
    if r.get("loaderId").is_none() {
        // Navegação dentro do mesmo documento (âncora/pushState).
        return Ok(true);
    }
    Ok(s.wait_load_after(seq, Duration::from_secs(25)))
}

/// Depois de uma ação: dá um respiro e, se a página começou a carregar, espera.
fn settle(s: &Session) {
    std::thread::sleep(Duration::from_millis(300));
    if s.is_loading() {
        s.wait_not_loading(Duration::from_secs(12));
    }
}

fn page_moved(before: &str, s: &Session) -> String {
    let after = s.url();
    if after != before {
        format!(" A página foi para {after}.")
    } else {
        String::new()
    }
}

// ── Leitura ──────────────────────────────────────────────────────────────

pub fn snapshot(s: &Session, portal: &str, max_text: usize) -> Res {
    let mut notes: Vec<String> = Vec::new();
    if s.is_loading() && !s.wait_not_loading(Duration::from_secs(3)) {
        notes.push(
            "aviso: a página ainda está carregando — o snapshot pode estar incompleto. Rode de novo em instantes."
                .into(),
        );
    }
    let expr = format!(
        "({})({})",
        SNAPSHOT_JS,
        json!({ "maxText": max_text, "maxEls": 200 })
    );
    let v = s.eval(&expr, T_EVAL)?;
    let str_of = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let num = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    let lines: Vec<String> = v
        .get("lines")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let count = num("count");

    let mut out = Vec::new();
    out.extend(notes);
    out.push(format!("Portal \"{portal}\" — {}", str_of("title")));
    out.push(format!("URL: {}", str_of("url")));
    out.push(format!(
        "Viewport {}x{} · rolagem {} de {} px",
        num("w"),
        num("h"),
        num("sy"),
        num("sh")
    ));
    if let Some(d) = s.take_dialog() {
        out.push(format!("Diálogo da página aceito automaticamente — {d}"));
    }
    out.push(String::new());
    if lines.is_empty() {
        out.push("Elementos interativos: (nenhum visível)".into());
    } else {
        let shown = lines.len() as i64;
        if count > shown {
            out.push(format!(
                "Elementos interativos ({count}, mostrando {shown}; ↓/↑ = fora da tela):"
            ));
        } else {
            out.push(format!("Elementos interativos ({count}; ↓/↑ = fora da tela):"));
        }
        out.extend(lines);
    }
    out.push(String::new());
    out.push("Texto da página:".into());
    let text = str_of("text");
    out.push(if text.is_empty() {
        "(vazio)".into()
    } else {
        text
    });
    let body = out.join("\n");
    Ok(body)
}

pub fn eval_js(s: &Session, code: &str) -> Res {
    let v = s.eval(code, T_EVAL).map_err(|e| Fail::new(400, e))?;
    let mut text = match v {
        Value::String(t) => t,
        Value::Null => "(undefined/null)".into(),
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    if text.chars().count() > 10000 {
        text = text.chars().take(10000).collect::<String>() + "\n…(cortado)";
    }
    Ok(text)
}

// ── Interação ────────────────────────────────────────────────────────────

fn mouse_click(s: &Session, x: f64, y: f64) -> Result<(), String> {
    s.mark_active();
    s.call(
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0 }),
        T_CALL,
    )?;
    s.call(
        "Input.dispatchMouseEvent",
        json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1 }),
        T_CALL,
    )?;
    s.call(
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1 }),
        T_CALL,
    )?;
    Ok(())
}

pub fn click(s: &Session, t: &Target) -> Res {
    let l = locate(s, t)?;
    let mut warn = Vec::new();
    if l.disabled {
        warn.push("o elemento está desabilitado".to_string());
    }
    if !l.covered.is_empty() {
        warn.push(format!(
            "havia outro elemento por cima ({}) — o clique foi nele",
            l.covered
        ));
    }
    let before = s.url();
    mouse_click(s, l.x, l.y)?;
    settle(s);
    let moved = page_moved(&before, s);
    if warn.is_empty() {
        Ok(format!("Clicou em {}.{moved}", l.desc))
    } else {
        Ok(format!(
            "aviso: clicou em {}, mas {}.{moved} Confira com `colmeia portal snapshot`.",
            l.desc,
            warn.join("; ")
        ))
    }
}

pub fn fill(s: &Session, t: &Target, text: &str) -> Res {
    if let Target::Point(_, _) = t {
        return Err(Fail::new(
            400,
            "fill precisa de um elemento (@eN do snapshot), não de um ponto. Para um ponto: \
`colmeia portal click x,y` e depois `colmeia portal type \"texto\"`.",
        ));
    }
    let l = locate(s, t)?;
    if l.password {
        return Err(Fail::new(403, PASSWORD_REFUSAL));
    }
    if l.disabled {
        return Err(Fail::new(409, format!("{} está desabilitado.", l.desc)));
    }
    if l.select {
        let v = run_target(s, t, "select", Some(text))?;
        if v.get("error").and_then(Value::as_str) == Some("no-option") {
            let opts: Vec<String> = v
                .get("options")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|o| o.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            return Err(Fail::new(
                404,
                format!(
                    "{} não tem a opção \"{text}\". Opções: {}",
                    l.desc,
                    opts.join(" | ")
                ),
            ));
        }
        settle(s);
        let chosen = v.get("value").and_then(Value::as_str).unwrap_or(text);
        return Ok(format!("Selecionou \"{chosen}\" em {}.", l.desc));
    }
    if !l.editable {
        let hint = if l.type_ == "checkbox" || l.type_ == "radio" {
            "é uma caixa de marcar — use `colmeia portal click` nela"
        } else {
            "não é um campo de texto — use `colmeia portal click`"
        };
        return Err(Fail::new(400, format!("{} {hint}.", l.desc)));
    }
    let f = run_target(s, t, "focus", None)?;
    match f.get("error").and_then(Value::as_str) {
        Some("password") => return Err(Fail::new(403, PASSWORD_REFUSAL)),
        Some(e) => return Err(Fail::new(400, format!("não consegui focar {}: {e}", l.desc))),
        None => {}
    }
    s.mark_active();
    if text.is_empty() {
        press_key(s, "Delete")?;
    } else {
        s.call("Input.insertText", json!({ "text": text }), T_CALL)?;
    }
    std::thread::sleep(Duration::from_millis(120));
    let now = run_target(s, t, "value", None)
        .ok()
        .and_then(|v| v.get("value").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let shown: String = now.chars().take(120).collect();
    if now.trim() == text.trim() {
        Ok(format!("Preencheu {} = \"{shown}\".", l.desc))
    } else {
        Ok(format!(
            "aviso: preencheu {}, mas o campo mostra \"{shown}\" (máscara, autocompletar ou limite de \
tamanho?). Confira com `colmeia portal snapshot`.",
            l.desc
        ))
    }
}

/// Info do elemento com foco (atravessando shadow roots).
fn focused(s: &Session) -> Result<Value, String> {
    s.eval(
        r#"(function () {
  var a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { none: true };
  var t = (a.getAttribute("type") || "").toLowerCase();
  return {
    none: false,
    password: a.tagName === "INPUT" && (t === "password" || (a.getAttribute("autocomplete") || "").indexOf("password") >= 0),
    tag: a.tagName.toLowerCase(),
    ref: a.getAttribute("data-colmeia-ref") || ""
  };
})()"#,
        T_EVAL,
    )
}

pub fn type_text(s: &Session, text: &str) -> Res {
    if text.is_empty() {
        return Err(Fail::new(400, "Uso: colmeia portal type \"<texto>\""));
    }
    let f = focused(s)?;
    if f.get("none").and_then(Value::as_bool).unwrap_or(true) {
        return Ok(
            "aviso: nada digitado — nenhum campo está com foco. Use `colmeia portal fill @eN \"texto\"` \
ou clique num campo antes (`colmeia portal click @eN`)."
                .into(),
        );
    }
    if f.get("password").and_then(Value::as_bool).unwrap_or(false) {
        return Err(Fail::new(403, PASSWORD_REFUSAL));
    }
    s.mark_active();
    s.call("Input.insertText", json!({ "text": text }), T_CALL)?;
    let tag = f.get("tag").and_then(Value::as_str).unwrap_or("?");
    let r = f.get("ref").and_then(Value::as_str).unwrap_or("");
    let at = if r.is_empty() {
        tag.to_string()
    } else {
        format!("@{r} ({tag})")
    };
    Ok(format!(
        "Digitou {} caractere(s) em {at}.",
        text.chars().count()
    ))
}

struct KeyDef {
    key: String,
    code: String,
    vk: u32,
    text: String,
}

fn key_def(name: &str) -> Option<KeyDef> {
    let lower = name.to_lowercase();
    let named = |key: &str, code: &str, vk: u32, text: &str| {
        Some(KeyDef {
            key: key.into(),
            code: code.into(),
            vk,
            text: text.into(),
        })
    };
    match lower.as_str() {
        "enter" | "return" => named("Enter", "Enter", 13, "\r"),
        "tab" => named("Tab", "Tab", 9, ""),
        "escape" | "esc" => named("Escape", "Escape", 27, ""),
        "backspace" => named("Backspace", "Backspace", 8, ""),
        "delete" | "del" => named("Delete", "Delete", 46, ""),
        "space" => named(" ", "Space", 32, " "),
        "arrowup" | "up" => named("ArrowUp", "ArrowUp", 38, ""),
        "arrowdown" | "down" => named("ArrowDown", "ArrowDown", 40, ""),
        "arrowleft" | "left" => named("ArrowLeft", "ArrowLeft", 37, ""),
        "arrowright" | "right" => named("ArrowRight", "ArrowRight", 39, ""),
        "home" => named("Home", "Home", 36, ""),
        "end" => named("End", "End", 35, ""),
        "pageup" => named("PageUp", "PageUp", 33, ""),
        "pagedown" => named("PageDown", "PageDown", 34, ""),
        _ => {
            if let Some(n) = lower.strip_prefix('f').and_then(|d| d.parse::<u32>().ok()) {
                if (1..=12).contains(&n) {
                    let k = format!("F{n}");
                    return Some(KeyDef {
                        key: k.clone(),
                        code: k,
                        vk: 111 + n,
                        text: String::new(),
                    });
                }
            }
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            let up = c.to_ascii_uppercase();
            let (code, vk) = if c.is_ascii_alphabetic() {
                (format!("Key{up}"), up as u32)
            } else if c.is_ascii_digit() {
                (format!("Digit{c}"), c as u32)
            } else {
                (String::new(), 0)
            };
            Some(KeyDef {
                key: c.to_string(),
                code,
                vk,
                text: c.to_string(),
            })
        }
    }
}

/// Atalhos de edição que o Chromium headless só executa via `commands`.
fn editing_command(key: &str) -> Option<&'static str> {
    match key.to_lowercase().as_str() {
        "a" => Some("selectAll"),
        "c" => Some("copy"),
        "x" => Some("cut"),
        "v" => Some("paste"),
        "z" => Some("undo"),
        "y" => Some("redo"),
        _ => None,
    }
}

/// Envia uma tecla (com modificadores "Ctrl+Shift+Tab"). Não checa senha.
fn press_key(s: &Session, spec: &str) -> Result<KeyDef, Fail> {
    let parts: Vec<&str> = spec.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    // "+" sozinho (ou "Ctrl++") é a própria tecla "+".
    let (mods_parts, key_name) = if spec.trim().ends_with('+') && spec.trim() != "+" {
        (parts.clone(), "+")
    } else if spec.trim() == "+" {
        (Vec::new(), "+")
    } else {
        match parts.split_last() {
            Some((last, rest)) => (rest.to_vec(), *last),
            None => return Err(Fail::new(400, "Uso: colmeia portal press \"Enter\"")),
        }
    };
    let mut mods: u32 = 0;
    for m in mods_parts {
        match m.to_lowercase().as_str() {
            "alt" | "option" => mods |= 1,
            "ctrl" | "control" => mods |= 2,
            "meta" | "cmd" | "command" | "win" | "super" => mods |= 4,
            "shift" => mods |= 8,
            other => {
                return Err(Fail::new(
                    400,
                    format!("Modificador desconhecido: \"{other}\" (use Ctrl, Alt, Shift, Meta)."),
                ))
            }
        }
    }
    let mut kd = key_def(key_name).ok_or_else(|| {
        Fail::new(
            400,
            format!(
                "Tecla desconhecida: \"{key_name}\". Use Enter, Tab, Escape, Backspace, Delete, Space, \
ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1–F12 ou um caractere."
            ),
        )
    })?;
    if mods & 8 != 0 && kd.text.chars().all(|c| c.is_ascii_alphabetic()) {
        kd.text = kd.text.to_uppercase();
    }
    let has_text = !kd.text.is_empty() && mods & (1 | 2 | 4) == 0;
    let mut down = json!({
        "type": if has_text { "keyDown" } else { "rawKeyDown" },
        "key": kd.key,
        "code": kd.code,
        "windowsVirtualKeyCode": kd.vk,
        "nativeVirtualKeyCode": kd.vk,
        "modifiers": mods,
    });
    if has_text {
        down["text"] = json!(kd.text);
        down["unmodifiedText"] = json!(kd.text);
    }
    if mods & (2 | 4) != 0 {
        if let Some(cmd) = editing_command(&kd.key) {
            down["commands"] = json!([cmd]);
        }
    }
    s.mark_active();
    s.call("Input.dispatchKeyEvent", down, T_CALL)?;
    s.call(
        "Input.dispatchKeyEvent",
        json!({
            "type": "keyUp",
            "key": kd.key,
            "code": kd.code,
            "windowsVirtualKeyCode": kd.vk,
            "nativeVirtualKeyCode": kd.vk,
            "modifiers": mods,
        }),
        T_CALL,
    )?;
    Ok(kd)
}

pub fn press(s: &Session, spec: &str) -> Res {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(Fail::new(400, "Uso: colmeia portal press \"Enter\"|\"Tab\"|\"Ctrl+A\"|…"));
    }
    // Um caractere imprimível num campo de senha é digitar a senha: recusa.
    let single = spec.chars().count() == 1;
    if single {
        if let Ok(f) = focused(s) {
            if f.get("password").and_then(Value::as_bool).unwrap_or(false) {
                return Err(Fail::new(403, PASSWORD_REFUSAL));
            }
        }
    }
    let before = s.url();
    let kd = press_key(s, spec)?;
    settle(s);
    let label = if kd.key == " " { "Space".to_string() } else { spec.to_string() };
    Ok(format!("Tecla {label} enviada.{}", page_moved(&before, s)))
}

fn scroll_pos(s: &Session) -> String {
    match s.eval(
        "(function(){var e=document.scrollingElement||document.documentElement;return [Math.round(e.scrollTop),Math.round(e.scrollHeight),innerHeight];})()",
        T_EVAL,
    ) {
        Ok(Value::Array(a)) if a.len() == 3 => format!(
            "Posição: {} de {} px (viewport {} px).",
            a[0], a[1], a[2]
        ),
        _ => String::new(),
    }
}

pub fn scroll(s: &Session, arg: &str, px: Option<f64>) -> Res {
    let a = arg.trim().to_lowercase();
    match a.as_str() {
        "" | "down" | "up" | "baixo" | "cima" => {
            let (w, h) = *s.viewport.lock().unwrap();
            let amount = px.unwrap_or(h as f64 * 0.8);
            let dy = if a == "up" || a == "cima" { -amount } else { amount };
            s.mark_active();
            s.call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": w as f64 / 2.0,
                    "y": h as f64 / 2.0,
                    "deltaX": 0,
                    "deltaY": dy,
                }),
                T_CALL,
            )?;
            std::thread::sleep(Duration::from_millis(400));
            let dir = if dy < 0.0 { "para cima" } else { "para baixo" };
            Ok(format!("Rolou {dir}. {}", scroll_pos(s)))
        }
        "top" | "topo" | "bottom" | "fim" => {
            let top = a == "top" || a == "topo";
            let js = if top {
                "window.scrollTo(0,0)"
            } else {
                "window.scrollTo(0,(document.scrollingElement||document.documentElement).scrollHeight)"
            };
            s.mark_active();
            s.eval(js, T_EVAL)?;
            std::thread::sleep(Duration::from_millis(250));
            Ok(format!(
                "Rolou {}. {}",
                if top { "até o topo" } else { "até o fim" },
                scroll_pos(s)
            ))
        }
        _ => {
            let t = Target::parse(arg).ok_or_else(|| {
                Fail::new(400, "Uso: colmeia portal scroll down|up|top|bottom|@eN [--px N]")
            })?;
            if let Target::Point(_, _) = t {
                return Err(Fail::new(400, "Para rolar, use down|up|top|bottom ou @eN."));
            }
            s.mark_active();
            let v = run_target(s, &t, "scroll", None)?;
            std::thread::sleep(Duration::from_millis(250));
            let label = v.get("label").and_then(Value::as_str).unwrap_or("");
            Ok(format!(
                "Rolou até {} \"{label}\". {}",
                t.describe(),
                scroll_pos(s)
            ))
        }
    }
}

/// Volta (-1) ou avança (+1) no histórico.
pub fn history(s: &Session, delta: i64) -> Res {
    let h = s.call("Page.getNavigationHistory", json!({}), T_CALL)?;
    let idx = h.get("currentIndex").and_then(Value::as_i64).unwrap_or(0);
    let entries = h
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let want = idx + delta;
    if want < 0 || want as usize >= entries.len() {
        return Ok(if delta < 0 {
            "aviso: não há página anterior no histórico deste portal.".into()
        } else {
            "aviso: não há página seguinte no histórico deste portal.".into()
        });
    }
    let entry = &entries[want as usize];
    let entry_id = entry.get("id").cloned().unwrap_or(Value::Null);
    s.mark_active();
    s.call(
        "Page.navigateToHistoryEntry",
        json!({ "entryId": entry_id }),
        T_CALL,
    )?;
    settle(s);
    let url = s.url();
    Ok(format!(
        "{} {url}",
        if delta < 0 { "Voltou para" } else { "Avançou para" }
    ))
}

pub fn reload(s: &Session) -> Res {
    let seq = s.load_seq();
    s.mark_active();
    s.call("Page.reload", json!({}), T_CALL)?;
    if s.wait_load_after(seq, Duration::from_secs(25)) {
        Ok(format!("Recarregou {}", s.url()))
    } else {
        Ok(format!(
            "aviso: recarreguei {}, mas ela ainda está carregando.",
            s.url()
        ))
    }
}

/// Diretório dos screenshots (temporário, limpo de arquivos com mais de 1 dia).
fn shots_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("colmeia").join("portal-shots");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let day = Duration::from_secs(24 * 3600);
        for e in rd.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .map(|age| age > day)
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    dir
}

fn safe_name(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(40)
        .collect();
    if out.trim_matches('-').is_empty() {
        "portal".into()
    } else {
        out
    }
}

pub fn screenshot(s: &Session, portal: &str, full: bool, png: bool) -> Res {
    let fmt = if png { "png" } else { "jpeg" };
    let mut params = json!({ "format": fmt });
    if !png {
        params["quality"] = json!(85);
    }
    let (mut w, mut h) = {
        let (w, h) = *s.viewport.lock().unwrap();
        (w as f64, h as f64)
    };
    if full {
        let m = s.call("Page.getLayoutMetrics", json!({}), T_CALL)?;
        let size = m.get("cssContentSize").or_else(|| m.get("contentSize"));
        if let Some(sz) = size {
            w = sz.get("width").and_then(Value::as_f64).unwrap_or(w).ceil();
            h = sz.get("height").and_then(Value::as_f64).unwrap_or(h).ceil().min(12000.0);
        }
        params["captureBeyondViewport"] = json!(true);
        params["clip"] = json!({ "x": 0, "y": 0, "width": w, "height": h, "scale": 1 });
    }
    let r = s.call("Page.captureScreenshot", params, Duration::from_secs(20))?;
    let data = r
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| Fail::new(502, "o navegador não devolveu a imagem."))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| Fail::new(502, format!("imagem inválida: {e}")))?;
    let ext = if png { "png" } else { "jpg" };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let path = shots_dir().join(format!("{}-{stamp}.{ext}", safe_name(portal)));
    std::fs::write(&path, &bytes)
        .map_err(|e| Fail::new(500, format!("não consegui salvar o screenshot: {e}")))?;
    Ok(format!(
        "Screenshot salvo em: {}\n({}x{} px{}, {}). Abra o arquivo com a sua ferramenta de ler imagens para ver.",
        path.display(),
        w as i64,
        h as i64,
        if full { ", página inteira" } else { "" },
        fmt
    ))
}

/// O que esperar em `wait`.
pub enum WaitFor {
    Text(String),
    Element(Target),
}

pub fn wait_for(s: &Session, what: &WaitFor, timeout: Duration, gone: bool) -> Res {
    let start = Instant::now();
    let check = |s: &Session| -> bool {
        match what {
            WaitFor::Text(t) => {
                let expr = format!(
                    "(function(t){{var b=document.body;return !!b&&(b.innerText||'').toLowerCase().indexOf(t)>=0;}})({})",
                    json!(t.to_lowercase())
                );
                s.eval(&expr, Duration::from_secs(5))
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            }
            WaitFor::Element(t) => {
                let expr = format!("({})({})", TARGET_JS, t.spec("visible", None));
                s.eval(&expr, Duration::from_secs(5))
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            }
        }
    };
    let label = match what {
        WaitFor::Text(t) => format!("\"{t}\""),
        WaitFor::Element(t) => t.describe(),
    };
    loop {
        if !s.is_alive() {
            return Err(Fail::new(410, "o navegador deste portal foi fechado."));
        }
        if check(s) != gone {
            let secs = start.elapsed().as_secs_f64();
            return Ok(if gone {
                format!("{label} sumiu ({secs:.1} s).")
            } else {
                format!("{label} apareceu ({secs:.1} s).")
            });
        }
        if start.elapsed() >= timeout {
            return Ok(format!(
                "aviso: depois de {} s, {label} {}. Rode `colmeia portal snapshot` para ver o estado.",
                timeout.as_secs(),
                if gone { "ainda está na página" } else { "ainda não apareceu" }
            ));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}
