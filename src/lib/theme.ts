// Gestão de tema — copia a abordagem do projeto "markdown": data-theme no <html>,
// persistido em localStorage, com evento para os terminais reagirem.
// Os tokens de cada tema ficam em src/styles/themes/*.css (portados do markdown).

import type { ITheme } from "@xterm/xterm";

export interface ThemeDef {
  id: string;
  label: string;
  /** Tema claro (as áreas principais têm fundo claro). */
  light?: boolean;
}

// Mesma lista (e ordem) do seletor de tema do markdown.
export const THEMES: ThemeDef[] = [
  { id: "cipher", label: "Cipher" },
  { id: "soft-light", label: "Soft Light", light: true },
  { id: "twilight", label: "Twilight", light: true },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "catppuccin", label: "Catppuccin" },
  { id: "rose-pine", label: "Rosé Pine" },
  { id: "dracula", label: "Dracula" },
  { id: "obsidian", label: "Obsidian" },
  { id: "atom", label: "Atom" },
  { id: "midnight", label: "Midnight" },
  { id: "solarized-light", label: "Solarized Light", light: true },
  { id: "nebula", label: "Nebula" },
];

const STORAGE_KEY = "colmeia:theme";
/** Marca que o valor salvo já usa os ids dos temas portados do markdown. */
const VERSION_KEY = "colmeia:theme-v";
const VERSION = "2";
const DEFAULT_THEME = "tokyo-night";

/**
 * Ids antigos → ids atuais. O "midnight" do colmeia v1 era a paleta verde que no
 * markdown se chama "cipher" (o "midnight" do markdown é roxo).
 */
const LEGACY_IDS: Record<string, string> = { midnight: "cipher" };

function isKnown(id: string): boolean {
  return THEMES.some((t) => t.id === id);
}

export function getStoredTheme(): string {
  let id: string | null = null;
  let migrated = false;
  try {
    id = localStorage.getItem(STORAGE_KEY);
    migrated = localStorage.getItem(VERSION_KEY) === VERSION;
  } catch {
    /* storage indisponível */
  }
  if (id && !migrated && LEGACY_IDS[id]) id = LEGACY_IDS[id];
  return id && isKnown(id) ? id : DEFAULT_THEME;
}

export function applyTheme(id: string) {
  const theme = isKnown(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
    localStorage.setItem(VERSION_KEY, VERSION);
  } catch {
    /* storage indisponível */
  }
  // Avisa os terminais para atualizarem suas cores.
  window.dispatchEvent(new CustomEvent("colmeia:themechange"));
}

/** Lê um token CSS do <html>. */
function tok(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Primeiro token não vazio da lista. */
function first(...names: string[]): string {
  for (const n of names) {
    const v = tok(n);
    if (v) return v;
  }
  return "";
}

/** Monta o tema do xterm a partir dos tokens CSS do tema ativo. */
export function readXtermTheme(): ITheme {
  const bg = tok("--bg-editor") || "#10131a";
  return {
    background: bg,
    foreground: tok("--text-primary") || "#e6e9ef",
    cursor: first("--editor-cursor", "--accent") || "#23d18b",
    cursorAccent: bg,
    selectionBackground: tok("--selection") || "rgba(255,255,255,0.2)",
    // Paleta ANSI do tema (src/styles/themes/*.css); cai nos tokens semânticos.
    black: first("--ansi-black", "--bg-sidebar"),
    red: first("--ansi-red", "--error"),
    green: first("--ansi-green", "--success"),
    yellow: first("--ansi-yellow", "--warning"),
    blue: first("--ansi-blue", "--accent-blue"),
    magenta: first("--ansi-magenta", "--accent"),
    cyan: first("--ansi-cyan", "--info"),
    white: first("--ansi-white", "--text-secondary"),
    brightBlack: first("--ansi-bright-black", "--text-muted"),
    brightRed: first("--ansi-bright-red", "--error"),
    brightGreen: first("--ansi-bright-green", "--success"),
    brightYellow: first("--ansi-bright-yellow", "--warning"),
    brightBlue: first("--ansi-bright-blue", "--accent-blue"),
    brightMagenta: first("--ansi-bright-magenta", "--accent"),
    brightCyan: first("--ansi-bright-cyan", "--info"),
    brightWhite: first("--ansi-bright-white", "--text-primary"),
  };
}

function parseRgb(value: string): [number, number, number, number] | null {
  const v = value.trim();
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16), 1];
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
      1,
    ];
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/i.exec(v);
  if (rgb) {
    let a = 1;
    if (rgb[4] !== undefined) {
      a = rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    }
    const c = (n: string) => Math.min(255, parseInt(n, 10));
    return [c(rgb[1]), c(rgb[2]), c(rgb[3]), Number.isFinite(a) ? a : 1];
  }
  return null;
}

/**
 * Normaliza um token de cor para #RRGGBB (o addon-search só aceita esse formato).
 * Cores translúcidas são compostas sobre `over` (o fundo do terminal).
 */
function toHex6(value: string, fallback: string, over?: string): string {
  const c = parseRgb(value);
  if (!c) return fallback;
  let [r, g, b] = c;
  const a = c[3];
  if (a < 1) {
    const base = (over && parseRgb(over)) || [0, 0, 0, 1];
    r = Math.round(r * a + base[0] * (1 - a));
    g = Math.round(g * a + base[1] * (1 - a));
    b = Math.round(b * a + base[2] * (1 - a));
  }
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Cores de destaque da busca no terminal, derivadas dos tokens do tema ativo. */
export function readSearchDecorations() {
  const bg = tok("--bg-editor");
  const match = toHex6(tok("--bg-selected"), "#414868", bg);
  const active = toHex6(tok("--warning"), "#ffaf5c", bg);
  return {
    matchBackground: match,
    matchBorder: toHex6(tok("--text-muted"), "#565f89", bg),
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchBorder: active,
    activeMatchColorOverviewRuler: active,
  };
}
