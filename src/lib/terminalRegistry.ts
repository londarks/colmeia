// Registry de terminais vivos, fora do React.
//
// Por id de nó, guarda o `Terminal` do xterm + addons + o elemento DOM que o hospeda (`host`) +
// a sessão de PTY no backend. O TerminalNode (e o painel de Lift) só ANEXAM o `host` a um "slot"
// ao montar e desanexam ao desmontar — trocar de canvas não mata nem recria o terminal; o host
// fica estacionado num contêiner invisível até alguém anexá-lo de novo, com todo o histórico.
//
// `ptyKill` só acontece em `disposeTerminal` (nó deletado), `disposeCanvas` (canvas excluído) e
// no fechamento da janela (depois de salvar o scrollback).
//
// Scrollback: as últimas ~2000 linhas de cada terminal são serializadas (addon-serialize) e
// salvas em disco (`scrollback_save`) com debounce e ao fechar a janela. Na primeira vez que o
// nó aparece na sessão do app, o texto salvo é reescrito no terminal antes do novo processo.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { AGENTS, type AgentId } from "./agents";
import { readSearchDecorations, readXtermTheme } from "./theme";
import { ptyKill, ptyResize, ptySpawn, ptyWrite, b64ToBytes } from "./pty";
import * as activity from "./activity";

/** Linhas de scrollback persistidas por terminal. */
const SCROLLBACK_LINES = 2000;
/** Intervalo máximo entre saves do scrollback enquanto há saída. */
const SAVE_DEBOUNCE_MS = 4000;
/** Ignora a saída inicial (prompt/banner) para não marcar "não visto" ao abrir. */
const STARTUP_QUIET_MS = 2500;

export interface TerminalSpec {
  agent: AgentId;
  cwd?: string;
  /** Id do papel: entra uma vez no boot do agente (backend). */
  role?: string;
  /** Muda para reiniciar o processo mantendo id/arestas (role assign, recruit --replace). */
  restartKey?: number;
}

interface Slot {
  el: HTMLElement;
  priority: number;
}

interface Entry {
  id: string;
  canvasId: string;
  agent: AgentId;
  cwd?: string;
  role?: string;
  restartKey?: number;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  webgl?: WebglAddon;
  host: HTMLDivElement;
  slots: Slot[];
  ro: ResizeObserver;
  /** Geração do processo: mensagens de canais antigos (após restart) são ignoradas. */
  gen: number;
  exited: boolean;
  spawnedAt: number;
  dirty: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
  fitRaf?: number;
  disposed: boolean;
  /** Promessa do start atual (restauração + spawn), para serializar restarts. */
  starting: Promise<void>;
  cleanup: (() => void)[];
}

const entries = new Map<string, Entry>();
let currentCanvas = "";
let parking: HTMLDivElement | null = null;
let globalsInstalled = false;

// ----------------------------------------------------------------------------
// Pequeno store de UI (busca aberta / nó em Lift), para os componentes React.

const uiListeners = new Set<() => void>();
const searchOpen = new Set<string>();
let liftedId: string | null = null;

function emitUi() {
  uiListeners.forEach((fn) => fn());
}
function subscribeUi(fn: () => void) {
  uiListeners.add(fn);
  return () => {
    uiListeners.delete(fn);
  };
}

// ----------------------------------------------------------------------------
// Scrollback em disco (comandos de `src-tauri/src/scrollback.rs`).

function scrollbackSave(canvas: string, node: string, text: string): Promise<void> {
  return invoke("scrollback_save", { canvas, node, text });
}
function scrollbackLoad(canvas: string, node: string): Promise<string | null> {
  return invoke("scrollback_load", { canvas, node });
}
export function scrollbackDelete(canvas: string, node?: string): Promise<void> {
  return invoke("scrollback_delete", { canvas, node: node ?? null });
}

// ----------------------------------------------------------------------------
// Infra interna

function getParking(): HTMLDivElement {
  if (parking && parking.isConnected) return parking;
  // Contêiner fora da tela mas no DOM (mantém medições e o contexto WebGL vivos).
  const el = document.createElement("div");
  el.className = "term-parking";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "900px",
    height: "600px",
    overflow: "hidden",
    visibility: "hidden",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  parking = el;
  return el;
}

function installGlobals() {
  if (globalsInstalled) return;
  globalsInstalled = true;
  // Cores acompanham o tema global.
  window.addEventListener("colmeia:themechange", () => {
    entries.forEach((e) => {
      e.term.options.theme = readXtermTheme();
    });
  });
  // Ao fechar a janela: salva o scrollback de todos e encerra os processos.
  // (O Tauri só destrói a janela depois que este handler resolve.)
  getCurrentWindow()
    .onCloseRequested(async () => {
      await withTimeout(shutdownAll(), 2500);
    })
    .catch(() => {});
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

function writeAsync(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** O host está num slot visível com tamanho de layout? (evita fit para 2 colunas) */
function canFit(e: Entry): boolean {
  const parent = e.host.parentElement;
  if (!parent || parent === parking || !e.host.isConnected) return false;
  return e.host.clientWidth > 0 && e.host.clientHeight > 0;
}

function safeFit(e: Entry) {
  if (e.disposed || !canFit(e)) return;
  try {
    const dims = e.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    if (dims.cols < 2 || dims.rows < 1) return;
    if (dims.cols !== e.term.cols || dims.rows !== e.term.rows) e.fit.fit();
  } catch {
    /* fit antes do layout */
  }
}

function scheduleFit(e: Entry) {
  if (e.fitRaf !== undefined) cancelAnimationFrame(e.fitRaf);
  e.fitRaf = requestAnimationFrame(() => {
    e.fitRaf = undefined;
    safeFit(e);
    if (canFit(e)) e.term.refresh(0, e.term.rows - 1);
  });
}

/** Coloca o host no slot de maior prioridade (ou no estacionamento). */
function placeHost(e: Entry) {
  if (e.disposed) return;
  const top = e.slots.reduce<Slot | undefined>(
    (best, s) => (!best || s.priority >= best.priority ? s : best),
    undefined,
  );
  const target = top?.el ?? getParking();
  if (e.host.parentElement !== target) target.appendChild(e.host);
  if (top) scheduleFit(e);
}

function serializeEntry(e: Entry): string {
  try {
    return e.serialize.serialize({
      scrollback: SCROLLBACK_LINES,
      excludeAltBuffer: true,
      excludeModes: true,
    });
  } catch {
    return "";
  }
}

async function saveEntry(e: Entry): Promise<void> {
  clearTimeout(e.saveTimer);
  e.saveTimer = undefined;
  if (!e.dirty || !e.canvasId || e.disposed) return;
  e.dirty = false;
  const text = serializeEntry(e);
  if (!text) return;
  try {
    await scrollbackSave(e.canvasId, e.id, text);
  } catch {
    e.dirty = true; // tenta de novo no próximo ciclo
  }
}

function markDirty(e: Entry) {
  e.dirty = true;
  if (e.saveTimer !== undefined) return;
  e.saveTimer = setTimeout(() => {
    e.saveTimer = undefined;
    void saveEntry(e);
  }, SAVE_DEBOUNCE_MS);
}

/** Depois de reescrever o scrollback, leva o cursor abaixo da última linha com texto. */
async function moveCursorBelowContent(term: Terminal) {
  const buf = term.buffer.active;
  const cursorAbs = buf.baseY + buf.cursorY;
  let last = -1;
  for (let y = buf.length - 1; y > cursorAbs; y--) {
    if ((buf.getLine(y)?.translateToString(true) ?? "").length > 0) {
      last = y;
      break;
    }
  }
  if (last > cursorAbs) await writeAsync(term, `\x1b[${last - cursorAbs}B`);
}

/** Restaura o scrollback (só na 1ª vez do nó nesta sessão) e sobe o processo. */
async function start(e: Entry, restore: boolean) {
  if (restore && e.canvasId) {
    try {
      const saved = await scrollbackLoad(e.canvasId, e.id);
      if (saved && !e.disposed) {
        await writeAsync(e.term, saved);
        await writeAsync(e.term, "\x1b[0m");
        await moveCursorBelowContent(e.term);
        await writeAsync(e.term, "\r\n\x1b[0;90m— sessão anterior —\x1b[0m\r\n");
      }
    } catch {
      /* sem scrollback salvo */
    }
  }
  if (e.disposed) return;
  await spawn(e);
}

async function spawn(e: Entry) {
  e.gen += 1;
  const gen = e.gen;
  e.exited = false;
  e.spawnedAt = Date.now();
  // Ajusta o tamanho ao slot antes de subir o processo (se já estiver anexado).
  safeFit(e);
  const { command, args } = AGENTS[e.agent]?.resolve() ?? AGENTS.shell.resolve();
  try {
    await ptySpawn(
      {
        id: e.id,
        command,
        args,
        cwd: e.cwd,
        cols: e.term.cols || 80,
        rows: e.term.rows || 24,
        role: e.role,
        agent: e.agent,
        // Mesma chave = mesma conversa do Claude ao reabrir o app. Trocar pasta ou
        // papel (restartKey) começa uma conversa nova, de propósito.
        sessionKey: [e.canvasId, e.id, e.cwd ?? "", e.restartKey ?? 0].join("|"),
      },
      (msg) => {
        if (e.disposed || gen !== e.gen) return; // canal de um processo antigo
        if (msg.kind === "data") {
          e.term.write(b64ToBytes(msg.b64));
          markDirty(e);
          if (Date.now() - e.spawnedAt > STARTUP_QUIET_MS) activity.reportOutput(e.id);
        } else {
          e.exited = true;
          e.term.write("\r\n\x1b[90m[processo encerrado]\x1b[0m\r\n");
          markDirty(e);
        }
      },
    );
    // O tamanho pode ter mudado enquanto o spawn rodava.
    if (gen === e.gen) ptyResize(e.id, e.term.cols, e.term.rows).catch(() => {});
  } catch (err) {
    if (gen === e.gen) {
      e.exited = true;
      e.term.write(`\r\n\x1b[31mFalha ao iniciar ${command}: ${err}\x1b[0m\r\n`);
    }
  }
}

/** Reinicia o processo na pasta de `e.cwd` (já atualizada por quem chama). */
async function restart(e: Entry) {
  await e.starting.catch(() => {});
  if (e.disposed) return;
  e.gen += 1; // invalida o canal antigo já agora (o kill emite "exit")
  await ptyKill(e.id).catch(() => {});
  const where = e.cwd ? e.cwd : "pasta padrão";
  await writeAsync(e.term, `\r\n\x1b[0;90m— reiniciado em ${where} —\x1b[0m\r\n`);
  await spawn(e);
}

function create(id: string, spec: TerminalSpec): Entry {
  installGlobals();
  const host = document.createElement("div");
  host.className = "term-host";
  getParking().appendChild(host);

  const term = new Terminal({
    fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    theme: readXtermTheme(),
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(host);

  const e: Entry = {
    id,
    canvasId: currentCanvas,
    agent: spec.agent,
    role: spec.role,
    restartKey: spec.restartKey,
    cwd: spec.cwd,
    term,
    fit,
    search,
    serialize,
    host,
    slots: [],
    ro: new ResizeObserver(() => safeFit(e)),
    gen: 0,
    exited: false,
    spawnedAt: 0,
    dirty: false,
    disposed: false,
    starting: Promise.resolve(),
    cleanup: [],
  };

  // Renderer WebGL (bem mais leve com muitos terminais); cai para o DOM se falhar.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (e.webgl === webgl) e.webgl = undefined;
    });
    term.loadAddon(webgl);
    e.webgl = webgl;
  } catch {
    e.webgl = undefined;
  }

  // Copiar (Ctrl+Shift+C), colar (Ctrl+Shift+V), copiar tudo (Ctrl+Shift+A), buscar (Ctrl+F)
  // e Lift (F11). O Ctrl+C continua sendo interrupção (SIGINT), como num terminal de verdade.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const k = ev.key.toLowerCase();
    if (ev.key === "F11" && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      if (liftedId === id) unliftTerminal();
      else liftTerminal(id);
      return false;
    }
    if (ev.ctrlKey && !ev.altKey && k === "f") {
      ev.preventDefault();
      openSearch(id);
      return false;
    }
    if (!ev.ctrlKey || !ev.shiftKey) return true;
    if (k === "c") {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
    }
    if (k === "v") {
      navigator.clipboard
        .readText()
        .then((t) => {
          if (t) ptyWrite(id, t).catch(() => {});
        })
        .catch(() => {});
      return false;
    }
    if (k === "a") {
      term.selectAll();
      const all = term.getSelection();
      if (all) navigator.clipboard.writeText(all).catch(() => {});
      return false;
    }
    return true;
  });

  const onData = term.onData((chunk) => {
    if (!e.exited) ptyWrite(id, chunk).catch(() => {});
  });
  const onResize = term.onResize(({ cols, rows }) => {
    ptyResize(id, cols, rows).catch(() => {});
  });
  e.cleanup.push(() => onData.dispose(), () => onResize.dispose());

  // Foco do terminal → "visto" + alvo do indicador de não visto.
  const ta = term.textarea;
  if (ta) {
    const onFocus = () => activity.setFocused(id);
    const onBlur = () => activity.clearFocused(id);
    ta.addEventListener("focus", onFocus);
    ta.addEventListener("blur", onBlur);
    e.cleanup.push(() => {
      ta.removeEventListener("focus", onFocus);
      ta.removeEventListener("blur", onBlur);
    });
  }

  e.ro.observe(host);
  entries.set(id, e);
  e.starting = start(e, true);
  return e;
}

// ----------------------------------------------------------------------------
// API pública

/** Canvas ao qual os terminais criados a partir de agora pertencem (o canvas ativo). */
export function setActiveCanvas(canvasId: string) {
  currentCanvas = canvasId;
}

/**
 * Obtém (ou cria e sobe) o terminal do nó. Se a pasta mudou, reinicia o processo nela
 * mantendo o histórico na tela.
 */
export function acquireTerminal(id: string, spec: TerminalSpec): void {
  const e = entries.get(id);
  if (!e) {
    create(id, spec);
    return;
  }
  if (e.canvasId && currentCanvas && e.canvasId !== currentCanvas) {
    // Ids repetidos entre canvases (dados antigos): os dois nós dividem o mesmo processo.
    console.warn(
      `[colmeia] terminal '${id}' pertence ao canvas ${e.canvasId}, mas foi montado em ${currentCanvas}`,
    );
  }
  // Pasta, tipo de agente ou restartKey diferentes => reinicia o processo
  // (o papel só entra no boot, então ele acompanha o restart).
  const cwdChanged = (spec.cwd || undefined) !== (e.cwd || undefined);
  const agentChanged = spec.agent !== e.agent;
  const keyChanged = (spec.restartKey ?? 0) !== (e.restartKey ?? 0);
  e.role = spec.role;
  if (cwdChanged || agentChanged || keyChanged) {
    e.cwd = spec.cwd;
    e.agent = spec.agent;
    e.restartKey = spec.restartKey;
    e.starting = restart(e);
  }
}

/**
 * Anexa o terminal a um elemento (slot). Com vários slots, vence o de maior prioridade
 * (nó no canvas = 0, painel de Lift = 1). Faz fit ao anexar.
 */
export function attachTerminal(id: string, el: HTMLElement, priority = 0) {
  const e = entries.get(id);
  if (!e) return;
  e.slots = e.slots.filter((s) => s.el !== el).concat({ el, priority });
  placeHost(e);
}

/** Desanexa o terminal do slot; ele volta para outro slot ou para o estacionamento. */
export function detachTerminal(id: string, el: HTMLElement) {
  const e = entries.get(id);
  if (!e) return;
  e.slots = e.slots.filter((s) => s.el !== el);
  placeHost(e);
}

/** Recalcula o tamanho (ex.: depois de uma animação de layout). */
export function fitTerminal(id: string) {
  const e = entries.get(id);
  if (e) scheduleFit(e);
}

export function focusTerminal(id: string) {
  entries.get(id)?.term.focus();
}

export function hasTerminal(id: string): boolean {
  return entries.has(id);
}

/** Canvas ao qual o terminal pertence (útil para "ir ao próximo em atenção"). */
export function getTerminalCanvas(id: string): string | undefined {
  return entries.get(id)?.canvasId;
}

/** Ids de todos os terminais vivos (opcionalmente só de um canvas). */
export function listTerminals(canvasId?: string): string[] {
  return [...entries.values()]
    .filter((e) => !canvasId || e.canvasId === canvasId)
    .map((e) => e.id);
}

/** Texto (sem atributos) das últimas linhas do terminal. */
export function readTerminalText(id: string, lines = 200): string {
  const e = entries.get(id);
  if (!e) return "";
  const buf = e.term.buffer.active;
  const out: string[] = [];
  for (let y = Math.max(0, buf.length - lines); y < buf.length; y++) {
    out.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return out.join("\n").replace(/\s+$/, "");
}

/**
 * Nó deletado de verdade: mata o processo, descarta o xterm e apaga o scrollback salvo.
 * `canvasId` é usado para apagar o arquivo quando o terminal nunca subiu nesta sessão.
 */
export function disposeTerminal(id: string, opts: { canvasId?: string; keepScrollback?: boolean } = {}) {
  const e = entries.get(id);
  const canvas = e?.canvasId || opts.canvasId || currentCanvas;
  if (e) {
    e.disposed = true;
    e.gen += 1;
    clearTimeout(e.saveTimer);
    if (e.fitRaf !== undefined) cancelAnimationFrame(e.fitRaf);
    e.ro.disconnect();
    e.cleanup.forEach((fn) => fn());
    try {
      e.term.dispose();
    } catch {
      /* noop */
    }
    e.host.remove();
    entries.delete(id);
  }
  ptyKill(id).catch(() => {});
  if (!opts.keepScrollback && canvas) scrollbackDelete(canvas, id).catch(() => {});
  activity.clearActivity(id);
  if (searchOpen.delete(id)) emitUi();
  if (liftedId === id) unliftTerminal();
}

/**
 * Canvas excluído: mata os terminais dele (os que o registry conhece + `nodeIds` lidos do
 * workspace salvo) e apaga a pasta de scrollback do canvas.
 */
export async function disposeCanvas(canvasId: string, nodeIds: string[] = []) {
  const ids = new Set(listTerminals(canvasId));
  for (const nid of nodeIds) {
    const owner = entries.get(nid)?.canvasId;
    // Não mata um terminal homônimo de outro canvas.
    if (!owner || owner === canvasId) ids.add(nid);
  }
  ids.forEach((nid) => disposeTerminal(nid, { canvasId, keepScrollback: true }));
  await scrollbackDelete(canvasId).catch(() => {});
}

/** Salva agora o scrollback de todos os terminais. */
export async function saveAllScrollback(): Promise<void> {
  await Promise.all([...entries.values()].map((e) => {
    e.dirty = true;
    return saveEntry(e);
  }));
}

/** Fechamento do app: salva tudo e encerra os processos. */
export async function shutdownAll(): Promise<void> {
  await saveAllScrollback().catch(() => {});
  await Promise.all([...entries.keys()].map((id) => ptyKill(id).catch(() => {})));
}

// ---- Busca -----------------------------------------------------------------

export function openSearch(id: string) {
  if (!entries.has(id)) return;
  searchOpen.add(id);
  emitUi();
  // O componente da barra foca o campo ao montar; reemite para quem já está aberto.
  window.dispatchEvent(new CustomEvent("colmeia:terminal-search", { detail: { id } }));
}

export function closeSearch(id: string, refocus = true) {
  const e = entries.get(id);
  e?.search.clearDecorations();
  if (searchOpen.delete(id)) emitUi();
  if (refocus) e?.term.focus();
}

export function isSearchOpen(id: string): boolean {
  return searchOpen.has(id);
}

export function useSearchOpen(id: string): boolean {
  return useSyncExternalStore(subscribeUi, () => searchOpen.has(id));
}

/** Busca para frente/para trás. Devolve se achou. */
export function searchTerminal(
  id: string,
  query: string,
  dir: "next" | "previous",
  opts: { caseSensitive?: boolean; regex?: boolean; incremental?: boolean } = {},
): boolean {
  const e = entries.get(id);
  if (!e) return false;
  if (!query) {
    e.search.clearDecorations();
    return false;
  }
  const o = {
    caseSensitive: !!opts.caseSensitive,
    regex: !!opts.regex,
    incremental: !!opts.incremental,
    decorations: readSearchDecorations(),
  };
  try {
    return dir === "next" ? e.search.findNext(query, o) : e.search.findPrevious(query, o);
  } catch {
    return false; // regex inválida, etc.
  }
}

/** Ouve o contador de resultados ("N de M"). */
export function onSearchResults(
  id: string,
  cb: (r: { resultIndex: number; resultCount: number }) => void,
): () => void {
  const e = entries.get(id);
  if (!e) return () => {};
  const d = e.search.onDidChangeResults(cb);
  return () => d.dispose();
}

// ---- Lift ------------------------------------------------------------------

/** Abre o nó num painel grande sobre o canvas (o mesmo terminal, reanexado). */
export function liftTerminal(id: string) {
  if (!entries.has(id) || liftedId === id) return;
  liftedId = id;
  emitUi();
}

export function unliftTerminal() {
  if (liftedId === null) return;
  const prev = liftedId;
  liftedId = null;
  emitUi();
  // Devolve o foco ao terminal no canvas.
  requestAnimationFrame(() => entries.get(prev)?.term.focus());
}

export function getLiftedTerminal(): string | null {
  return liftedId;
}

export function useLiftedTerminal(): string | null {
  return useSyncExternalStore(subscribeUi, () => liftedId);
}
