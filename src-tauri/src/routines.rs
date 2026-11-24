// Rotinas agendadas: um scheduler ÚNICO (uma thread) que dispara um texto
// (comando/prompt) num terminal do canvas, ou um lembrete (só notificação).
//
// - Agenda: `once <quando>`, `interval <30s|5m|2h|1h30m>`, `daily HH:MM`,
//   `weekly mon,fri@HH:MM` (horário local).
// - Persistência em `app_data_dir/routines.json` (sobrevive a restart), com
//   histórico das últimas execuções.
// - Próximo disparo calculado a partir do último "tick" (disparo ou pulo): disparos
//   perdidos com o app fechado colapsam em UM só.
// - Alvo pelo id do nó (o título é só para exibir).
// - Alvo ocupado → espera um pouco; se continuar ocupado, registra o pulo.

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::Shared;
use crate::activity::AgentState;

const HISTORY_MAX: usize = 20;
/// Teto do intervalo entre checagens do scheduler.
const MAX_TICK: Duration = Duration::from_secs(30);

// ============================================================================
// Agenda
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Schedule {
    /// Uma vez, no instante `at` (unix ms).
    Once { at: i64 },
    /// A cada `secs` segundos.
    Interval { secs: u64 },
    /// Todo dia às HH:MM (local).
    Daily { hour: u32, minute: u32 },
    /// Nos dias `days` (0 = segunda ... 6 = domingo) às HH:MM (local).
    Weekly {
        days: Vec<u32>,
        hour: u32,
        minute: u32,
    },
}

const DAY_KEYS: [[&str; 3]; 7] = [
    ["mon", "seg", "segunda"],
    ["tue", "ter", "terca"],
    ["wed", "qua", "quarta"],
    ["thu", "qui", "quinta"],
    ["fri", "sex", "sexta"],
    ["sat", "sab", "sabado"],
    ["sun", "dom", "domingo"],
];
const DAY_PT: [&str; 7] = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/// "30s", "5m", "2h", "1h30m", "1d"; número puro = minutos.
pub fn parse_duration(s: &str) -> Result<u64, String> {
    let s = s.trim().to_lowercase();
    if s.is_empty() {
        return Err("duração vazia".into());
    }
    if let Ok(n) = s.parse::<u64>() {
        return if n == 0 {
            Err("a duração precisa ser maior que zero".into())
        } else {
            Ok(n * 60)
        };
    }
    let mut total: u64 = 0;
    let mut num = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            num.push(c);
            continue;
        }
        let mult = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86_400,
            _ => return Err(format!("duração inválida '{s}' (ex.: 30s, 5m, 2h, 1h30m)")),
        };
        let n: u64 = num
            .parse()
            .map_err(|_| format!("duração inválida '{s}' (ex.: 30s, 5m, 2h, 1h30m)"))?;
        total += n * mult;
        num.clear();
    }
    if !num.is_empty() {
        return Err(format!("duração inválida '{s}': falta a unidade (s/m/h/d)"));
    }
    if total == 0 {
        return Err("a duração precisa ser maior que zero".into());
    }
    Ok(total)
}

/// "09:00" / "9:05" → (9, 5).
pub fn parse_hhmm(s: &str) -> Result<(u32, u32), String> {
    let s = s.trim();
    let (h, m) = s
        .split_once(':')
        .ok_or_else(|| format!("horário inválido '{s}' (use HH:MM)"))?;
    let h: u32 = h
        .trim()
        .parse()
        .map_err(|_| format!("horário inválido '{s}'"))?;
    let m: u32 = m
        .trim()
        .parse()
        .map_err(|_| format!("horário inválido '{s}'"))?;
    if h > 23 || m > 59 {
        return Err(format!("horário inválido '{s}' (00:00 a 23:59)"));
    }
    Ok((h, m))
}

fn parse_day(s: &str) -> Result<u32, String> {
    let k = s.trim().to_lowercase().replace('á', "a").replace('ç', "c");
    DAY_KEYS
        .iter()
        .position(|keys| keys.contains(&k.as_str()))
        .map(|i| i as u32)
        .ok_or_else(|| format!("dia inválido '{s}' (mon,tue,wed,thu,fri,sat,sun)"))
}

/// "mon,fri" / "mon-fri" / "seg,qua,sex" → dias ordenados (0 = segunda).
fn parse_days(s: &str) -> Result<Vec<u32>, String> {
    let mut days = Vec::new();
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        if let Some((a, b)) = part.split_once('-') {
            let (a, b) = (parse_day(a)?, parse_day(b)?);
            let mut d = a;
            loop {
                days.push(d);
                if d == b {
                    break;
                }
                d = (d + 1) % 7;
            }
        } else {
            days.push(parse_day(part)?);
        }
    }
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return Err("informe ao menos um dia (ex.: mon,fri)".into());
    }
    Ok(days)
}

/// Converte um horário local "ingênuo" para o fuso (lidando com buracos de horário de verão).
fn resolve_local<Tz: TimeZone>(tz: &Tz, naive: &NaiveDateTime) -> Option<DateTime<Tz>> {
    tz.from_local_datetime(naive).earliest().or_else(|| {
        tz.from_local_datetime(&(*naive + chrono::Duration::hours(1)))
            .earliest()
    })
}

/// "2026-06-20 15:00", "20/06/2026 15:00", "15:00" (próxima ocorrência), "+30m"/"em 30m"/"in 30m".
fn parse_when<Tz: TimeZone>(s: &str, now: &DateTime<Tz>) -> Result<DateTime<Tz>, String> {
    let s = s.trim();
    let rel = s
        .strip_prefix('+')
        .or_else(|| s.strip_prefix("in "))
        .or_else(|| s.strip_prefix("em "));
    if let Some(d) = rel {
        let secs = parse_duration(d)?;
        return Ok(now.clone() + chrono::Duration::seconds(secs as i64));
    }
    let tz = now.timezone();
    for fmt in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%d/%m/%Y %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return resolve_local(&tz, &naive).ok_or_else(|| format!("horário inexistente '{s}'"));
        }
    }
    if let Ok((h, m)) = parse_hhmm(s) {
        let today = now.date_naive();
        for offset in 0..=2u64 {
            let Some(date) = today.checked_add_days(chrono::Days::new(offset)) else {
                continue;
            };
            let Some(naive) = date.and_hms_opt(h, m, 0) else {
                continue;
            };
            if let Some(dt) = resolve_local(&tz, &naive) {
                if dt > *now {
                    return Ok(dt);
                }
            }
        }
    }
    Err(format!(
        "quando inválido '{s}' (use \"AAAA-MM-DD HH:MM\", \"HH:MM\" ou \"+30m\")"
    ))
}

/// Interpreta uma agenda. `now` serve para `once` relativo/"HH:MM".
///
/// Aceita: `once <quando>`, `interval <dur>` / `every <dur>` / `<dur>`,
/// `daily HH:MM`, `weekly mon,fri@HH:MM` (ou `weekly mon,fri HH:MM`).
pub fn parse_schedule<Tz: TimeZone>(spec: &str, now: &DateTime<Tz>) -> Result<Schedule, String> {
    let spec = spec.trim();
    let (kind, rest) = match spec.split_once(char::is_whitespace) {
        Some((k, r)) => (k.to_lowercase(), r.trim()),
        None => (spec.to_lowercase(), ""),
    };
    match kind.as_str() {
        "once" | "uma-vez" => {
            if rest.is_empty() {
                return Err("once precisa de um horário (ex.: once 2026-06-20 15:00)".into());
            }
            let at = parse_when(rest, now)?;
            if at <= *now {
                return Err("esse horário já passou".into());
            }
            Ok(Schedule::Once {
                at: at.timestamp_millis(),
            })
        }
        "interval" | "every" | "a-cada" => Ok(Schedule::Interval {
            secs: parse_duration(rest)?,
        }),
        "daily" | "diario" | "diária" | "diaria" => {
            let (hour, minute) = parse_hhmm(rest)?;
            Ok(Schedule::Daily { hour, minute })
        }
        "weekly" | "semanal" => {
            let (days, time) = rest
                .split_once('@')
                .or_else(|| rest.rsplit_once(char::is_whitespace))
                .ok_or("weekly precisa de dias e horário (ex.: weekly mon,fri@09:00)")?;
            let days = parse_days(days)?;
            let (hour, minute) = parse_hhmm(time)?;
            Ok(Schedule::Weekly { days, hour, minute })
        }
        "" => Err("agenda vazia".into()),
        _ if rest.is_empty() => {
            // "30m" sozinho = intervalo.
            parse_duration(&kind)
                .map(|secs| Schedule::Interval { secs })
                .map_err(|_| {
                    format!(
                        "agenda inválida '{spec}' (use once/interval/daily/weekly, ex.: \"daily 09:00\")"
                    )
                })
        }
        _ => Err(format!(
            "agenda inválida '{spec}' (use once/interval/daily/weekly, ex.: \"daily 09:00\")"
        )),
    }
}

/// Primeiro disparo ESTRITAMENTE depois de `base`.
pub fn next_fire_after<Tz: TimeZone>(
    schedule: &Schedule,
    base: &DateTime<Tz>,
) -> Option<DateTime<Tz>> {
    let tz = base.timezone();
    match schedule {
        Schedule::Once { at } => {
            let at = tz.timestamp_millis_opt(*at).single()?;
            (at > *base).then_some(at)
        }
        Schedule::Interval { secs } => {
            Some(base.clone() + chrono::Duration::seconds((*secs).max(1) as i64))
        }
        Schedule::Daily { hour, minute } => next_matching(base, &tz, *hour, *minute, |_| true),
        Schedule::Weekly { days, hour, minute } => {
            next_matching(base, &tz, *hour, *minute, |d: NaiveDate| {
                days.contains(&d.weekday().num_days_from_monday())
            })
        }
    }
}

fn next_matching<Tz: TimeZone>(
    base: &DateTime<Tz>,
    tz: &Tz,
    hour: u32,
    minute: u32,
    day_ok: impl Fn(NaiveDate) -> bool,
) -> Option<DateTime<Tz>> {
    let start = base.date_naive();
    for offset in 0..=8u64 {
        let date = start.checked_add_days(chrono::Days::new(offset))?;
        if !day_ok(date) {
            continue;
        }
        let naive = date.and_hms_opt(hour, minute, 0)?;
        if let Some(dt) = resolve_local(tz, &naive) {
            if dt > *base {
                return Some(dt);
            }
        }
    }
    None
}

fn fmt_duration(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    let mut out = String::new();
    if h > 0 {
        out.push_str(&format!("{h}h"));
    }
    if m > 0 {
        out.push_str(&format!("{m}m"));
    }
    if s > 0 || out.is_empty() {
        out.push_str(&format!("{s}s"));
    }
    out
}

/// Forma canônica (re-parseável) da agenda.
pub fn spec_of(schedule: &Schedule) -> String {
    match schedule {
        Schedule::Once { at } => Local
            .timestamp_millis_opt(*at)
            .single()
            .map(|dt| format!("once {}", dt.format("%Y-%m-%d %H:%M")))
            .unwrap_or_else(|| "once ?".into()),
        Schedule::Interval { secs } => format!("interval {}", fmt_duration(*secs)),
        Schedule::Daily { hour, minute } => format!("daily {hour:02}:{minute:02}"),
        Schedule::Weekly { days, hour, minute } => format!(
            "weekly {}@{hour:02}:{minute:02}",
            days.iter()
                .map(|d| DAY_KEYS[*d as usize % 7][0])
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

/// Descrição em português para a UI/CLI.
pub fn describe(schedule: &Schedule) -> String {
    match schedule {
        Schedule::Once { at } => Local
            .timestamp_millis_opt(*at)
            .single()
            .map(|dt| format!("uma vez em {}", dt.format("%d/%m/%Y %H:%M")))
            .unwrap_or_else(|| "uma vez".into()),
        Schedule::Interval { secs } => format!("a cada {}", fmt_duration(*secs)),
        Schedule::Daily { hour, minute } => format!("todo dia às {hour:02}:{minute:02}"),
        Schedule::Weekly { days, hour, minute } => format!(
            "{} às {hour:02}:{minute:02}",
            days.iter()
                .map(|d| DAY_PT[*d as usize % 7])
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

// ============================================================================
// Rotina + persistência
// ============================================================================

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: i64,
    /// sent | reminder | skippedBusy | targetMissing
    pub outcome: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub manual: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    pub schedule: Schedule,
    /// Id do nó alvo. Vazio = lembrete (só notificação).
    #[serde(default)]
    pub target_id: String,
    /// Título do alvo (só exibição; atualizado quando o nó é visto).
    #[serde(default)]
    pub target_title: String,
    /// Comando/prompt enviado ao terminal, ou o texto do lembrete.
    pub text: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub skip_if_busy: bool,
    /// Notificar também quando um envio a terminal dispara.
    #[serde(default)]
    pub notify: bool,
    /// Parar depois de N disparos (None = para sempre).
    #[serde(default)]
    pub max_runs: Option<u32>,
    pub created_at: i64,
    /// Base do agendamento: último disparo ou pulo agendado.
    #[serde(default)]
    pub last_tick_at: Option<i64>,
    #[serde(default)]
    pub last_fired_at: Option<i64>,
    #[serde(default)]
    pub fire_count: u32,
    /// `once` já disparou / `max_runs` atingido.
    #[serde(default)]
    pub completed: bool,
    /// Desde quando está devida mas esperando o alvo ficar livre.
    #[serde(default)]
    pub pending_since: Option<i64>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

impl Routine {
    pub fn is_reminder(&self) -> bool {
        self.target_id.is_empty()
    }

    /// Próximo disparo (unix ms), se houver.
    pub fn next_run_ms(&self) -> Option<i64> {
        if !self.enabled || self.completed {
            return None;
        }
        let base_ms = self.last_tick_at.unwrap_or(self.created_at);
        let base = Local.timestamp_millis_opt(base_ms).single()?;
        next_fire_after(&self.schedule, &base).map(|d| d.timestamp_millis())
    }

    /// Quanto tempo esperar o alvo ocupado antes de registrar o pulo.
    fn busy_grace_ms(&self) -> i64 {
        match self.schedule {
            Schedule::Interval { secs } => ((secs as i64) * 500).clamp(5_000, 300_000),
            _ => 300_000,
        }
    }

    fn push_history(&mut self, entry: HistoryEntry) {
        self.history.insert(0, entry);
        self.history.truncate(HISTORY_MAX);
    }
}

/// Rotina + campos calculados para a UI.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoutineView {
    #[serde(flatten)]
    pub routine: Routine,
    pub next_run: Option<i64>,
    pub spec: String,
    pub describe: String,
    pub waiting_busy: bool,
}

impl From<&Routine> for RoutineView {
    fn from(r: &Routine) -> Self {
        RoutineView {
            routine: r.clone(),
            next_run: r.next_run_ms(),
            spec: spec_of(&r.schedule),
            describe: describe(&r.schedule),
            waiting_busy: r.pending_since.is_some(),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct RoutinesFile {
    version: u32,
    routines: Vec<Routine>,
}

/// Entrada de criação (UI e CLI).
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInput {
    #[serde(default)]
    pub name: Option<String>,
    /// Ex.: "daily 09:00", "weekly mon,fri@09:00", "interval 30m", "once 2026-06-20 15:00".
    pub schedule: String,
    /// Id (ou título) do nó alvo. Vazio/None = lembrete.
    #[serde(default)]
    pub target: Option<String>,
    pub text: String,
    #[serde(default)]
    pub skip_if_busy: Option<bool>,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub max_runs: Option<u32>,
}

/// Edição: só os campos presentes mudam.
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutinePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub schedule: Option<String>,
    /// Some("") transforma em lembrete.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub skip_if_busy: Option<bool>,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// 0 = sem limite.
    #[serde(default)]
    pub max_runs: Option<u32>,
}

// ============================================================================
// Pontos que o integrador vai trocar (isolados de propósito)
// ============================================================================

/// O alvo está ocupado? Hoje: aprovação pendente OU saída recente no PTY.
/// O integrador troca por um estado de atividade melhor depois.
pub fn is_target_busy(shared: &Arc<Shared>, target_id: &str) -> bool {
    // Estado publicado pelo activity.rs (hooks do Claude + heurística de tela):
    // trabalhando ou pedindo atenção (menu/aprovação) = não digitar por cima.
    shared.has_pending_approval(target_id)
        || shared.activity_snapshot(target_id).state != AgentState::Idle
}

/// O alvo tem um PTY vivo?
fn is_target_running(shared: &Arc<Shared>, target_id: &str) -> bool {
    shared.session_io(target_id).is_some()
}

/// Entrega o texto ao terminal pela fila robusta (delivery.rs): paste, Enter
/// confirmado pela tela, sem atropelar asks nem digitação humana. Roda numa
/// thread à parte para não segurar o scheduler.
pub fn deliver(shared: &Arc<Shared>, target_id: &str, text: &str) -> bool {
    shared.submit_line(target_id.to_string(), text.to_string())
}

// ============================================================================
// Scheduler
// ============================================================================

pub struct Scheduler {
    shared: Arc<Shared>,
    app: AppHandle,
    path: Option<PathBuf>,
    routines: Mutex<Vec<Routine>>,
    wake_flag: Mutex<bool>,
    wake: Condvar,
}

static SCHED: OnceLock<Arc<Scheduler>> = OnceLock::new();

/// Sobe o scheduler (chamado uma vez no `setup()`).
pub fn init(shared: Arc<Shared>, app: AppHandle) {
    let path = app.path().app_data_dir().ok().map(|d| {
        let _ = std::fs::create_dir_all(&d);
        d.join("routines.json")
    });
    let routines = path.as_ref().map(load_file).unwrap_or_default();
    let sched = Arc::new(Scheduler {
        shared,
        app,
        path,
        routines: Mutex::new(routines),
        wake_flag: Mutex::new(false),
        wake: Condvar::new(),
    });
    if SCHED.set(sched.clone()).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("colmeia-routines".into())
        .spawn(move || sched.run_loop())
        .ok();
}

pub fn scheduler() -> Option<Arc<Scheduler>> {
    SCHED.get().cloned()
}

fn load_file(path: &PathBuf) -> Vec<Routine> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<RoutinesFile>(&text) {
        Ok(f) => f.routines,
        Err(e) => {
            // Não perde o arquivo: guarda uma cópia para inspeção.
            eprintln!("[routines] routines.json inválido: {e}");
            let _ = std::fs::copy(path, path.with_extension("json.bad"));
            Vec::new()
        }
    }
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn gen_id() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect::<String>()
        .to_lowercase()
}

fn fmt_time(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%d/%m %H:%M").to_string())
        .unwrap_or_else(|| "?".into())
}

impl Scheduler {
    fn run_loop(self: Arc<Self>) {
        loop {
            let wait = self.tick();
            let guard = self.wake_flag.lock().unwrap_or_else(|e| e.into_inner());
            let mut guard = if *guard {
                guard
            } else {
                self.wake
                    .wait_timeout(guard, wait)
                    .map(|(g, _)| g)
                    .unwrap_or_else(|e| e.into_inner().0)
            };
            *guard = false;
        }
    }

    /// Acorda a thread (mudança de agenda, run-now...).
    fn poke(&self) {
        *self.wake_flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
    }

    fn save(&self, list: &[Routine]) {
        let Some(path) = &self.path else { return };
        let file = RoutinesFile {
            version: 1,
            routines: list.to_vec(),
        };
        if let Ok(text) = serde_json::to_string_pretty(&file) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    fn changed(&self) {
        let _ = self.app.emit("colmeia://routines-changed", ());
    }

    fn notify(&self, r: &Routine) {
        let _ = self.app.emit(
            "colmeia://notify",
            serde_json::json!({
                "id": format!("routine:{}", r.id),
                "title": r.name,
                "body": r.text,
            }),
        );
    }

    /// Dispara `r` agora. Devolve o registro de histórico (já gravado em `r`).
    /// Notificações a emitir vão para `notes`.
    fn fire(
        &self,
        r: &mut Routine,
        now: i64,
        manual: bool,
        notes: &mut Vec<Routine>,
    ) -> HistoryEntry {
        let (outcome, detail) = if r.is_reminder() {
            notes.push(r.clone());
            ("reminder", String::new())
        } else if !is_target_running(&self.shared, &r.target_id) {
            (
                "targetMissing",
                format!("terminal \"{}\" não está rodando", r.target_title),
            )
        } else if deliver(&self.shared, &r.target_id, &r.text) {
            if r.notify {
                notes.push(r.clone());
            }
            ("sent", String::new())
        } else {
            (
                "targetMissing",
                format!("terminal \"{}\" não encontrado", r.target_title),
            )
        };
        let ok = outcome == "sent" || outcome == "reminder";
        if ok {
            r.fire_count += 1;
            r.last_fired_at = Some(now);
        }
        if !manual {
            r.last_tick_at = Some(now);
            r.pending_since = None;
            if matches!(r.schedule, Schedule::Once { .. }) {
                r.completed = true;
            }
        }
        if let Some(max) = r.max_runs {
            if max > 0 && r.fire_count >= max {
                r.completed = true;
            }
        }
        let entry = HistoryEntry {
            at: now,
            outcome: outcome.to_string(),
            detail,
            manual,
        };
        r.push_history(entry.clone());
        entry
    }

    /// Uma passada do scheduler. Devolve quanto esperar até a próxima.
    fn tick(&self) -> Duration {
        let now = now_ms();
        let mut notes = Vec::new();
        let mut dirty = false;
        let mut wait = MAX_TICK;
        {
            let mut list = self.routines.lock().unwrap_or_else(|e| e.into_inner());
            for r in list.iter_mut() {
                // Mantém o título do alvo atualizado (renomes no canvas).
                if !r.target_id.is_empty() {
                    let t = self.shared.title_of(&r.target_id);
                    if t != r.target_id && t != r.target_title {
                        r.target_title = t;
                        dirty = true;
                    }
                }
                let Some(next) = r.next_run_ms() else {
                    continue;
                };
                if next > now {
                    let ms = (next - now).max(0) as u64;
                    wait = wait.min(Duration::from_millis(ms));
                    continue;
                }
                // Devida.
                if !r.is_reminder()
                    && r.skip_if_busy
                    && is_target_running(&self.shared, &r.target_id)
                    && is_target_busy(&self.shared, &r.target_id)
                {
                    let pending = r.pending_since;
                    let grace = r.busy_grace_ms();
                    match pending {
                        None => {
                            r.pending_since = Some(now);
                            dirty = true;
                        }
                        Some(since) if now - since > grace => {
                            r.last_tick_at = Some(now);
                            r.pending_since = None;
                            r.push_history(HistoryEntry {
                                at: now,
                                outcome: "skippedBusy".into(),
                                detail: format!("\"{}\" continuou ocupado", r.target_title),
                                manual: false,
                            });
                            dirty = true;
                        }
                        Some(_) => {}
                    }
                    wait = wait.min(Duration::from_secs(2));
                    continue;
                }
                self.fire(r, now, false, &mut notes);
                dirty = true;
            }
            if dirty {
                self.save(&list);
            }
        }
        for r in &notes {
            self.notify(r);
        }
        if dirty {
            self.changed();
        }
        wait.max(Duration::from_millis(250))
    }

    // ---------------- CRUD ----------------

    pub fn list(&self) -> Vec<RoutineView> {
        self.routines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(RoutineView::from)
            .collect()
    }

    /// Resolve o alvo (id ou título) → (id, título). Vazio = lembrete.
    fn resolve_target(&self, target: Option<&str>) -> Result<(String, String), String> {
        match target.map(str::trim).filter(|t| !t.is_empty()) {
            None => Ok((String::new(), String::new())),
            Some(t) => self
                .shared
                .resolve_terminal(t)
                .ok_or_else(|| format!("Terminal \"{t}\" não encontrado.")),
        }
    }

    fn mutate<R>(
        &self,
        f: impl FnOnce(&mut Vec<Routine>) -> Result<R, String>,
    ) -> Result<R, String> {
        let out = {
            let mut list = self.routines.lock().unwrap_or_else(|e| e.into_inner());
            let out = f(&mut *list)?;
            self.save(&list);
            out
        };
        self.changed();
        self.poke();
        Ok(out)
    }

    pub fn create(&self, input: RoutineInput) -> Result<Routine, String> {
        let schedule = parse_schedule(&input.schedule, &Local::now())?;
        let text = input.text.trim().to_string();
        if text.is_empty() {
            return Err("Informe o comando/prompt (ou o texto do lembrete).".into());
        }
        let (target_id, target_title) = self.resolve_target(input.target.as_deref())?;
        let name = input
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| text.chars().take(40).collect());
        let now = now_ms();
        let routine = Routine {
            id: gen_id(),
            name,
            schedule,
            target_id,
            target_title,
            text,
            enabled: input.enabled.unwrap_or(true),
            skip_if_busy: input.skip_if_busy.unwrap_or(true),
            notify: input.notify.unwrap_or(false),
            max_runs: input.max_runs.filter(|n| *n > 0),
            created_at: now,
            last_tick_at: None,
            last_fired_at: None,
            fire_count: 0,
            completed: false,
            pending_since: None,
            history: Vec::new(),
        };
        let r = routine.clone();
        self.mutate(move |list| {
            list.push(r);
            Ok(())
        })?;
        Ok(routine)
    }

    pub fn edit(&self, id: &str, patch: RoutinePatch) -> Result<Routine, String> {
        let schedule = match &patch.schedule {
            Some(s) => Some(parse_schedule(s, &Local::now())?),
            None => None,
        };
        let target = match &patch.target {
            Some(t) => Some(self.resolve_target(Some(t.as_str()))?),
            None => None,
        };
        let id = id.to_string();
        self.mutate(move |list| {
            let r = list
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| format!("Rotina {id} não encontrada."))?;
            let now = now_ms();
            if let Some(n) = patch
                .name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
            {
                r.name = n;
            }
            if let Some(t) = patch.text.map(|t| t.trim().to_string()) {
                if t.is_empty() {
                    return Err("O texto não pode ficar vazio.".into());
                }
                r.text = t;
            }
            if let Some(s) = schedule {
                // Mudar a agenda zera os contadores (como "nova" rotina).
                r.schedule = s;
                r.last_tick_at = Some(now);
                r.fire_count = 0;
                r.completed = false;
                r.pending_since = None;
            }
            if let Some((tid, title)) = target {
                r.target_id = tid;
                r.target_title = title;
            }
            if let Some(b) = patch.skip_if_busy {
                r.skip_if_busy = b;
            }
            if let Some(b) = patch.notify {
                r.notify = b;
            }
            if let Some(n) = patch.max_runs {
                r.max_runs = (n > 0).then_some(n);
                r.completed = matches!(r.max_runs, Some(m) if r.fire_count >= m);
            }
            if let Some(e) = patch.enabled {
                if e && !r.enabled {
                    // Religar não dispara o que "perdeu" enquanto desligada.
                    r.last_tick_at = Some(now);
                    r.pending_since = None;
                }
                r.enabled = e;
            }
            Ok(r.clone())
        })
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<Routine, String> {
        self.edit(
            id,
            RoutinePatch {
                enabled: Some(enabled),
                ..Default::default()
            },
        )
    }

    pub fn delete(&self, id: &str) -> bool {
        let id = id.to_string();
        self.mutate(move |list| {
            let before = list.len();
            list.retain(|r| r.id != id);
            Ok(list.len() != before)
        })
        .unwrap_or(false)
    }

    /// Dispara agora, ignorando a agenda (não mexe na base do agendamento).
    pub fn run_now(&self, id: &str) -> Result<HistoryEntry, String> {
        let mut notes = Vec::new();
        let id = id.to_string();
        let entry = {
            let mut list = self.routines.lock().unwrap_or_else(|e| e.into_inner());
            let r = list
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| format!("Rotina {id} não encontrada."))?;
            let entry = self.fire(r, now_ms(), true, &mut notes);
            self.save(&list);
            entry
        };
        for r in &notes {
            self.notify(r);
        }
        self.changed();
        Ok(entry)
    }
}

// ============================================================================
// Comandos Tauri
// ============================================================================

fn sched() -> Result<Arc<Scheduler>, String> {
    scheduler().ok_or_else(|| "scheduler de rotinas não iniciado".to_string())
}

#[tauri::command]
pub fn routines_list() -> Vec<RoutineView> {
    scheduler().map(|s| s.list()).unwrap_or_default()
}

#[tauri::command]
pub fn routine_create(input: RoutineInput) -> Result<Vec<RoutineView>, String> {
    let s = sched()?;
    s.create(input)?;
    Ok(s.list())
}

#[tauri::command]
pub fn routine_edit(id: String, patch: RoutinePatch) -> Result<Vec<RoutineView>, String> {
    let s = sched()?;
    s.edit(&id, patch)?;
    Ok(s.list())
}

#[tauri::command]
pub fn routine_delete(id: String) -> Vec<RoutineView> {
    match scheduler() {
        Some(s) => {
            s.delete(&id);
            s.list()
        }
        None => Vec::new(),
    }
}

#[tauri::command]
pub fn routine_set_enabled(id: String, enabled: bool) -> Result<Vec<RoutineView>, String> {
    let s = sched()?;
    s.set_enabled(&id, enabled)?;
    Ok(s.list())
}

#[tauri::command]
pub fn routine_run(id: String) -> Result<Vec<RoutineView>, String> {
    let s = sched()?;
    s.run_now(&id)?;
    Ok(s.list())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    pub spec: String,
    pub describe: String,
    pub next_run: Option<i64>,
}

/// Valida uma agenda e mostra a próxima execução (para o formulário da UI).
#[tauri::command]
pub fn routine_preview(schedule: String) -> Result<SchedulePreview, String> {
    let now = Local::now();
    let s = parse_schedule(&schedule, &now)?;
    Ok(SchedulePreview {
        spec: spec_of(&s),
        describe: describe(&s),
        next_run: next_fire_after(&s, &now).map(|d| d.timestamp_millis()),
    })
}

// ============================================================================
// CLI: `colmeia routine ...` (o integrador liga isto a uma rota do orchestrator)
// ============================================================================

fn arg_str(args: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| args.get(*k))
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.trim().to_string()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
}

fn arg_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    match args.get(key) {
        Some(serde_json::Value::Bool(b)) => Some(*b),
        Some(serde_json::Value::String(s)) => Some(s == "true" || s == "1"),
        _ => None,
    }
}

/// Agenda a partir de `schedule` ou das flags `every|interval|daily|weekly|once`.
fn schedule_from_args(args: &serde_json::Value) -> Option<String> {
    if let Some(s) = arg_str(args, &["schedule"]) {
        return Some(s);
    }
    for (key, kind) in [
        ("every", "interval"),
        ("interval", "interval"),
        ("daily", "daily"),
        ("weekly", "weekly"),
        ("once", "once"),
    ] {
        if let Some(v) = arg_str(args, &[key]) {
            return Some(format!("{kind} {v}"));
        }
    }
    None
}

fn find_routine(list: &[RoutineView], args: &serde_json::Value) -> Result<Routine, (u16, String)> {
    let by_id = arg_str(args, &["id"]);
    let by_name = arg_str(args, &["name"]);
    let matches: Vec<&Routine> = list
        .iter()
        .map(|v| &v.routine)
        .filter(|r| match (&by_id, &by_name) {
            (Some(id), _) => r.id.starts_with(id.as_str()),
            (None, Some(n)) => r.name.eq_ignore_ascii_case(n) || r.id.starts_with(n.as_str()),
            (None, None) => false,
        })
        .collect();
    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => Err((
            404,
            if by_id.is_none() && by_name.is_none() {
                "Informe a rotina: \"<nome>\" ou --id <prefixo>. Veja `colmeia routine list`."
                    .into()
            } else {
                "Rotina não encontrada. Veja `colmeia routine list`.".into()
            },
        )),
        _ => Err((
            409,
            format!(
                "Mais de uma rotina bate; use --id <prefixo>:\n{}",
                matches
                    .iter()
                    .map(|r| format!("  - {} \"{}\"", &r.id[..r.id.len().min(6)], r.name))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        )),
    }
}

fn line_of(v: &RoutineView) -> String {
    let r = &v.routine;
    let target = if r.is_reminder() {
        "lembrete".to_string()
    } else {
        format!("→ \"{}\"", r.target_title)
    };
    let state = if r.completed {
        "concluída".to_string()
    } else if !r.enabled {
        "desligada".to_string()
    } else {
        v.next_run
            .map(|n| format!("próxima {}", fmt_time(n)))
            .unwrap_or_else(|| "sem próxima".into())
    };
    format!(
        "  - {} \"{}\" | {} | {} | {}",
        &r.id[..r.id.len().min(6)],
        r.name,
        v.describe,
        target,
        state
    )
}

/// `colmeia routine create|list|show|delete|enable|disable|run|edit`.
/// Devolve (status HTTP, texto para o agente).
#[allow(dead_code)] // ligado a uma rota do orchestrator pelo integrador
pub fn cli_routine(
    shared: &Arc<Shared>,
    _app: &AppHandle,
    source: &str,
    args: &serde_json::Value,
) -> (u16, String) {
    let Some(s) = scheduler() else {
        return (503, "Scheduler de rotinas não iniciado.".into());
    };
    let action = arg_str(args, &["action"]).unwrap_or_else(|| "list".into());
    match action.as_str() {
        "list" => {
            let list = s.list();
            if list.is_empty() {
                return (200, "Nenhuma rotina.".into());
            }
            (
                200,
                format!(
                    "Rotinas:\n{}",
                    list.iter().map(line_of).collect::<Vec<_>>().join("\n")
                ),
            )
        }
        "create" => {
            let Some(schedule) = schedule_from_args(args) else {
                return (400, "Uso: colmeia routine create \"<nome>\" --command \"...\" (--every 30m | --daily 09:00 | --weekly mon,fri@09:00 | --once \"2026-06-20 15:00\") [--terminal \"X\" | --reminder]".into());
            };
            let Some(text) = arg_str(args, &["command", "text", "prompt"]) else {
                return (
                    400,
                    "Falta --command \"...\" (o comando/prompt ou o texto do lembrete).".into(),
                );
            };
            let reminder = arg_bool(args, "reminder").unwrap_or(false);
            // Sem --terminal e sem --reminder: o próprio terminal que chamou.
            let target = if reminder {
                None
            } else {
                arg_str(args, &["terminal", "target"])
                    .or_else(|| (!source.is_empty()).then(|| source.to_string()))
            };
            if !reminder && target.is_none() {
                return (
                    400,
                    "Sem alvo: passe --terminal \"<nome>\" ou --reminder.".into(),
                );
            }
            if let Some(t) = &target {
                if shared.resolve_terminal(t).is_none() {
                    let names: Vec<String> = shared
                        .nodes
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|n| n.kind == "terminal")
                        .map(|n| format!("\"{}\"", n.title))
                        .collect();
                    return (
                        404,
                        format!(
                            "Terminal \"{t}\" não encontrado. Terminais: {}",
                            names.join(", ")
                        ),
                    );
                }
            }
            let skip = match arg_bool(args, "noSkipIfBusy") {
                Some(true) => Some(false),
                _ => arg_bool(args, "skipIfBusy"),
            };
            let input = RoutineInput {
                name: arg_str(args, &["name"]),
                schedule,
                target,
                text,
                skip_if_busy: skip,
                notify: arg_bool(args, "notify"),
                enabled: arg_bool(args, "disabled").map(|d| !d),
                max_runs: arg_str(args, &["count", "maxRuns"]).and_then(|c| c.parse().ok()),
            };
            match s.create(input) {
                Ok(r) => {
                    let v = RoutineView::from(&r);
                    (
                        200,
                        format!(
                            "Rotina {} \"{}\" criada: {} {}{}",
                            &r.id[..6.min(r.id.len())],
                            r.name,
                            v.describe,
                            if r.is_reminder() {
                                "(lembrete)".to_string()
                            } else {
                                format!("→ \"{}\"", r.target_title)
                            },
                            v.next_run
                                .map(|n| format!(", próxima {}", fmt_time(n)))
                                .unwrap_or_default()
                        ),
                    )
                }
                Err(e) => (400, e),
            }
        }
        "show" | "delete" | "enable" | "disable" | "run" | "edit" => {
            let r = match find_routine(&s.list(), args) {
                Ok(r) => r,
                Err((code, msg)) => return (code, msg),
            };
            let short = r.id[..r.id.len().min(6)].to_string();
            match action.as_str() {
                "show" => {
                    let v = RoutineView::from(&r);
                    let mut out = format!(
                        "{} \"{}\"\n  agenda: {} ({})\n  alvo: {}\n  texto: {}\n  estado: {}{}\n  disparos: {}",
                        short,
                        r.name,
                        v.describe,
                        v.spec,
                        if r.is_reminder() { "lembrete".to_string() } else { format!("\"{}\" ({})", r.target_title, r.target_id) },
                        r.text,
                        if r.completed { "concluída" } else if r.enabled { "ligada" } else { "desligada" },
                        v.next_run.map(|n| format!(", próxima {}", fmt_time(n))).unwrap_or_default(),
                        r.fire_count
                    );
                    if !r.history.is_empty() {
                        out.push_str("\n  histórico:");
                        for h in r.history.iter().take(10) {
                            out.push_str(&format!(
                                "\n    {} {}{}{}",
                                fmt_time(h.at),
                                h.outcome,
                                if h.manual { " (manual)" } else { "" },
                                if h.detail.is_empty() {
                                    String::new()
                                } else {
                                    format!(" — {}", h.detail)
                                }
                            ));
                        }
                    }
                    (200, out)
                }
                "delete" => {
                    if s.delete(&r.id) {
                        (200, format!("Rotina {short} \"{}\" removida.", r.name))
                    } else {
                        (404, "Rotina não encontrada.".into())
                    }
                }
                "enable" | "disable" => match s.set_enabled(&r.id, action == "enable") {
                    Ok(r) => (
                        200,
                        format!(
                            "Rotina \"{}\" {}.",
                            r.name,
                            if r.enabled { "ligada" } else { "desligada" }
                        ),
                    ),
                    Err(e) => (400, e),
                },
                "run" => match s.run_now(&r.id) {
                    Ok(h) => (
                        200,
                        format!(
                            "Rotina \"{}\" disparada: {}{}",
                            r.name,
                            h.outcome,
                            if h.detail.is_empty() {
                                String::new()
                            } else {
                                format!(" ({})", h.detail)
                            }
                        ),
                    ),
                    Err(e) => (400, e),
                },
                _ => {
                    // edit
                    let reminder = arg_bool(args, "reminder").unwrap_or(false);
                    let patch = RoutinePatch {
                        name: arg_str(args, &["newName", "rename"]),
                        schedule: schedule_from_args(args),
                        target: if reminder {
                            Some(String::new())
                        } else {
                            arg_str(args, &["terminal", "target"])
                        },
                        text: arg_str(args, &["command", "text", "prompt"]),
                        skip_if_busy: match arg_bool(args, "noSkipIfBusy") {
                            Some(true) => Some(false),
                            _ => arg_bool(args, "skipIfBusy"),
                        },
                        notify: arg_bool(args, "notify"),
                        enabled: arg_bool(args, "disabled").map(|d| !d),
                        max_runs: arg_str(args, &["count", "maxRuns"]).and_then(|c| c.parse().ok()),
                    };
                    match s.edit(&r.id, patch) {
                        Ok(r) => {
                            let v = RoutineView::from(&r);
                            (200, format!("Rotina atualizada:\n{}", line_of(&v)))
                        }
                        Err(e) => (400, e),
                    }
                }
            }
        }
        other => (
            400,
            format!("Ação inválida '{other}' (create|list|show|delete|enable|disable|run|edit)."),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn tz() -> FixedOffset {
        FixedOffset::west_opt(3 * 3600).unwrap() // America/Sao_Paulo (sem horário de verão)
    }
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<FixedOffset> {
        tz().with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn parses_daily() {
        let now = at(2026, 11, 23, 10, 0);
        assert_eq!(
            parse_schedule("daily 09:00", &now).unwrap(),
            Schedule::Daily { hour: 9, minute: 0 }
        );
        assert_eq!(
            parse_schedule("daily 9:05", &now).unwrap(),
            Schedule::Daily { hour: 9, minute: 5 }
        );
        assert!(parse_schedule("daily 25:00", &now).is_err());
        assert!(parse_schedule("daily", &now).is_err());
    }

    #[test]
    fn parses_weekly() {
        let now = at(2026, 11, 23, 10, 0);
        assert_eq!(
            parse_schedule("weekly mon,fri@09:00", &now).unwrap(),
            Schedule::Weekly {
                days: vec![0, 4],
                hour: 9,
                minute: 0
            }
        );
        assert_eq!(
            parse_schedule("weekly fri,mon 09:00", &now).unwrap(),
            Schedule::Weekly {
                days: vec![0, 4],
                hour: 9,
                minute: 0
            }
        );
        assert_eq!(
            parse_schedule("weekly mon-fri@18:30", &now).unwrap(),
            Schedule::Weekly {
                days: vec![0, 1, 2, 3, 4],
                hour: 18,
                minute: 30
            }
        );
        assert!(parse_schedule("weekly xyz@09:00", &now).is_err());
    }

    #[test]
    fn parses_intervals() {
        let now = at(2026, 11, 23, 10, 0);
        assert_eq!(
            parse_schedule("30m", &now).unwrap(),
            Schedule::Interval { secs: 1800 }
        );
        assert_eq!(
            parse_schedule("interval 30s", &now).unwrap(),
            Schedule::Interval { secs: 30 }
        );
        assert_eq!(
            parse_schedule("interval 2h", &now).unwrap(),
            Schedule::Interval { secs: 7200 }
        );
        assert_eq!(
            parse_schedule("every 1h30m", &now).unwrap(),
            Schedule::Interval { secs: 5400 }
        );
        assert_eq!(
            parse_schedule("interval 15", &now).unwrap(),
            Schedule::Interval { secs: 900 }
        );
        assert!(parse_schedule("interval 0s", &now).is_err());
        assert!(parse_schedule("interval 5x", &now).is_err());
        assert!(parse_schedule("banana", &now).is_err());
    }

    #[test]
    fn parses_once() {
        let now = at(2026, 11, 23, 10, 0);
        let s = parse_schedule("once 2026-11-24 15:00", &now).unwrap();
        assert_eq!(
            s,
            Schedule::Once {
                at: at(2026, 11, 24, 15, 0).timestamp_millis()
            }
        );
        let s = parse_schedule("once +30m", &now).unwrap();
        assert_eq!(
            s,
            Schedule::Once {
                at: at(2026, 11, 23, 10, 30).timestamp_millis()
            }
        );
        // "HH:MM" que já passou hoje → amanhã.
        let s = parse_schedule("once 09:00", &now).unwrap();
        assert_eq!(
            s,
            Schedule::Once {
                at: at(2026, 11, 24, 9, 0).timestamp_millis()
            }
        );
        assert!(parse_schedule("once 2020-01-01 00:00", &now).is_err());
    }

    #[test]
    fn next_daily() {
        let s = Schedule::Daily { hour: 9, minute: 0 };
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 23, 10, 0)),
            Some(at(2026, 11, 24, 9, 0))
        );
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 23, 8, 0)),
            Some(at(2026, 11, 23, 9, 0))
        );
        // Estritamente depois: exatamente 09:00 → amanhã.
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 23, 9, 0)),
            Some(at(2026, 11, 24, 9, 0))
        );
    }

    #[test]
    fn next_weekly() {
        // 2026-11-23 é segunda-feira.
        let s = Schedule::Weekly {
            days: vec![0, 4],
            hour: 9,
            minute: 0,
        };
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 23, 10, 0)),
            Some(at(2026, 11, 27, 9, 0))
        );
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 27, 9, 0)),
            Some(at(2026, 11, 30, 9, 0))
        );
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 23, 8, 59)),
            Some(at(2026, 11, 23, 9, 0))
        );
    }

    #[test]
    fn next_interval_and_once() {
        let s = Schedule::Interval { secs: 1800 };
        assert_eq!(
            next_fire_after(&s, &at(2026, 11, 23, 10, 0)),
            Some(at(2026, 11, 23, 10, 30))
        );
        let t = at(2026, 11, 24, 15, 0);
        let once = Schedule::Once {
            at: t.timestamp_millis(),
        };
        assert_eq!(next_fire_after(&once, &at(2026, 11, 23, 10, 0)), Some(t));
        assert_eq!(next_fire_after(&once, &at(2026, 11, 25, 10, 0)), None);
    }

    #[test]
    fn missed_fires_collapse_into_one() {
        // App fechado por 3 dias: a próxima a partir do último tick já passou
        // (dispara UMA vez), e a partir do disparo (agora) volta para o futuro.
        let s = Schedule::Daily { hour: 9, minute: 0 };
        let last_tick = at(2026, 11, 20, 9, 0);
        let now = at(2026, 11, 23, 12, 0);
        let due = next_fire_after(&s, &last_tick).unwrap();
        assert!(due <= now);
        let after_fire = next_fire_after(&s, &now).unwrap();
        assert_eq!(after_fire, at(2026, 11, 24, 9, 0));
        assert!(after_fire > now);
    }

    #[test]
    fn spec_roundtrip() {
        let now = at(2026, 11, 23, 10, 0);
        for spec in [
            "daily 09:00",
            "weekly mon,fri@09:00",
            "interval 1h30m",
            "interval 45s",
        ] {
            let s = parse_schedule(spec, &now).unwrap();
            assert_eq!(spec_of(&s), spec);
        }
    }
}
