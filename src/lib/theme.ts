// Gestão de tema — copia a abordagem do projeto "markdown": data-theme no <html>,
// persistido em localStorage, com evento para os terminais reagirem.

import type { ITheme } from "@xterm/xterm";

export interface ThemeDef {
  id: string;
  label: string;
}

export const THEMES: ThemeDef[] = [
  { id: "midnight", label: "Midnight" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "dracula", label: "Dracula" },
  { id: "rose-pine", label: "Rosé Pine" },
];

const STORAGE_KEY = "colmeia:theme";
const DEFAULT_THEME = "tokyo-night";

export function getStoredTheme(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME;
}

export function applyTheme(id: string) {
  document.documentElement.dataset.theme = id;
  localStorage.setItem(STORAGE_KEY, id);
  // Avisa os terminais para atualizarem suas cores.
  window.dispatchEvent(new CustomEvent("colmeia:themechange"));
}

/** Lê um token CSS do <html>. */
function tok(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Monta o tema do xterm a partir dos tokens CSS do tema ativo. */
export function readXtermTheme(): ITheme {
  return {
    background: tok("--bg-editor") || "#10131a",
    foreground: tok("--text-primary") || "#e6e9ef",
    cursor: tok("--accent") || "#23d18b",
    cursorAccent: tok("--bg-editor") || "#10131a",
    selectionBackground: tok("--selection") || "rgba(255,255,255,0.2)",
    black: tok("--bg-sidebar"),
    red: tok("--error"),
    green: tok("--success"),
    yellow: tok("--warning"),
    blue: tok("--accent-blue"),
    magenta: tok("--accent"),
    cyan: tok("--info"),
    white: tok("--text-secondary"),
    brightBlack: tok("--text-muted"),
    brightWhite: tok("--text-primary"),
  };
}
