// Atalhos de teclado globais do canvas.
//
// Regra: nunca roubar tecla quando o foco está num terminal (xterm) ou num campo
// de texto (input/textarea/select/contenteditable). Exceções, que valem em
// qualquer lugar: Ctrl+K (palette) e Ctrl+Shift+A (próximo em atenção — dentro do
// terminal só quando há alguém em atenção, para não matar o "selecionar tudo" do xterm).

import { useEffect, useRef } from "react";

export type ShortcutAction =
  | "palette"
  | "nextAttention"
  | "focusTerminalN"
  | "nextTerminal"
  | "prevTerminal"
  | "nextConnected"
  | "prevConnected"
  | "connectMode"
  | "undo"
  | "redo"
  | "frameSelection"
  | "help"
  // Tratados em hooks/useCanvasUx, useLayout e useDock (listados aqui só para a ajuda).
  | "duplicate"
  | "rename"
  | "pin"
  | "bringToFront"
  | "sendToBack"
  | "snapGrid"
  | "align"
  | "distribute"
  | "tidy"
  | "dock"
  | "composer";

export interface ShortcutDef {
  action: ShortcutAction;
  /** Combinações como exibidas na ajuda. */
  keys: string[];
  label: string;
  /** Vale também com o foco num terminal / campo de texto. */
  global?: boolean;
}

/** Lista exibida na tela de ajuda (`?`) e na palette. */
export const SHORTCUTS: ShortcutDef[] = [
  { action: "palette", keys: ["Ctrl+K"], label: "Abrir a command palette", global: true },
  {
    action: "nextAttention",
    keys: ["Ctrl+Shift+A"],
    label: "Ir para o próximo agente em atenção",
    global: true,
  },
  { action: "focusTerminalN", keys: ["Ctrl+1 … Ctrl+9"], label: "Focar o N-ésimo terminal" },
  { action: "nextTerminal", keys: ["Ctrl+Tab"], label: "Próximo terminal" },
  { action: "prevTerminal", keys: ["Ctrl+Shift+Tab"], label: "Terminal anterior" },
  { action: "nextConnected", keys: ["Alt+→"], label: "Próximo nó conectado (segue a aresta)" },
  { action: "prevConnected", keys: ["Alt+←"], label: "Nó conectado anterior (volta pela aresta)" },
  {
    action: "connectMode",
    keys: ["C"],
    label: "Modo connect: com 1 nó selecionado, clique no alvo (Esc cancela)",
  },
  { action: "undo", keys: ["Ctrl+Z"], label: "Desfazer (canvas)" },
  { action: "redo", keys: ["Ctrl+Shift+Z", "Ctrl+Y"], label: "Refazer (canvas)" },
  { action: "frameSelection", keys: ["F"], label: "Enquadrar a seleção (ou tudo)" },
  { action: "help", keys: ["?"], label: "Mostrar esta ajuda" },
  { action: "duplicate", keys: ["Ctrl+D"], label: "Duplicar a seleção" },
  { action: "rename", keys: ["F2"], label: "Renomear o nó selecionado" },
  { action: "pin", keys: ["Ctrl+Shift+L"], label: "Travar/destravar posição da seleção" },
  { action: "bringToFront", keys: ["Ctrl+]"], label: "Trazer para frente" },
  { action: "sendToBack", keys: ["Ctrl+["], label: "Enviar para trás" },
  { action: "snapGrid", keys: ["Alt+G"], label: "Encaixar na grade (liga/desliga) · Alt ao arrastar solta o ímã" },
  {
    action: "align",
    keys: ["Alt+Shift+←/→/↑/↓", "Alt+Shift+C", "Alt+Shift+M"],
    label: "Alinhar a seleção (esquerda/direita/topo/base, centro, meio)",
  },
  { action: "distribute", keys: ["Alt+Shift+H", "Alt+Shift+V"], label: "Distribuir a seleção (horizontal/vertical)" },
  { action: "tidy", keys: ["Ctrl+Shift+T"], label: "Arrumar a seleção (ou o canvas) em camadas pelas arestas" },
  { action: "dock", keys: ["Ctrl+Shift+D"], label: "Mostrar/esconder o Dock de terminais" },
  { action: "composer", keys: ["Ctrl+Enter"], label: "Composer com @agente e #nota (Ctrl+Enter envia)" },
];

/** O foco está dentro de um xterm? */
export function isInTerminal(el: Element | null): boolean {
  return !!el?.closest?.(".xterm");
}

/** O foco está num campo onde o usuário digita? (inclui o xterm, que usa textarea) */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (isInTerminal(el)) return true;
  const h = el as HTMLElement;
  if (h.isContentEditable) return true;
  const tag = h.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export type ShortcutHandlers = {
  palette: () => void;
  /** Retorna false se não havia ninguém em atenção. */
  nextAttention: () => boolean;
  hasAttention: () => boolean;
  focusTerminalN: (n: number) => void;
  cycleTerminal: (dir: 1 | -1) => void;
  walkConnected: (dir: 1 | -1) => void;
  connectMode: () => boolean;
  undo: () => void;
  redo: () => void;
  frameSelection: () => void;
  help: () => void;
  /** Esc: cancela modo connect / fecha overlays. Retorna true se consumiu. */
  escape: () => boolean;
  /** Algum modal nosso aberto (palette/ajuda) — atalhos de canvas ficam mudos. */
  modalOpen: () => boolean;
};

/** Registra os atalhos no window (fase de captura, antes do xterm). */
export function useShortcuts(handlers: ShortcutHandlers) {
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) {
        // Permite repetição só para ciclar terminais (segurar Ctrl+Tab).
        if (!(e.repeat && e.key === "Tab" && e.ctrlKey)) return;
      }
      const H = h.current;
      const target = e.target as Element | null;
      const active = document.activeElement;
      const inTerm = isInTerminal(target) || isInTerminal(active);
      const typing = inTerm || isTypingTarget(target) || isTypingTarget(active);
      const key = e.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;
      const ctrl = e.ctrlKey || e.metaKey;

      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // ---- Globais (valem até dentro do terminal) ----
      if (ctrl && !e.shiftKey && !e.altKey && lower === "k") {
        consume();
        H.palette();
        return;
      }
      if (ctrl && e.shiftKey && !e.altKey && lower === "a") {
        // No terminal, só rouba se houver alguém em atenção.
        if (inTerm && !H.hasAttention()) return;
        if (isTypingTarget(target) && !inTerm) return; // campo de texto: Ctrl+Shift+A nativo
        consume();
        H.nextAttention();
        return;
      }

      // Esc só é consumido se havia algo nosso para cancelar (modo connect / ajuda).
      if (key === "Escape") {
        if (H.escape()) consume();
        return;
      }

      // Daqui pra baixo: nada quando digitando ou com modal aberto.
      if (typing || H.modalOpen()) return;

      if (ctrl && !e.altKey && key === "Tab") {
        consume();
        H.cycleTerminal(e.shiftKey ? -1 : 1);
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(key)) {
        consume();
        H.focusTerminalN(Number(key));
        return;
      }
      if (e.altKey && !ctrl && !e.shiftKey && (key === "ArrowRight" || key === "ArrowLeft")) {
        consume();
        H.walkConnected(key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (ctrl && !e.altKey && lower === "z") {
        consume();
        if (e.shiftKey) H.redo();
        else H.undo();
        return;
      }
      if (ctrl && !e.altKey && !e.shiftKey && lower === "y") {
        consume();
        H.redo();
        return;
      }
      if (ctrl || e.altKey) return;
      if (lower === "c" && !e.shiftKey) {
        if (H.connectMode()) consume();
        return;
      }
      if (lower === "f" && !e.shiftKey) {
        consume();
        H.frameSelection();
        return;
      }
      if (key === "?") {
        consume();
        H.help();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
