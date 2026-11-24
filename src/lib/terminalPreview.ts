// Prévia das últimas linhas de um terminal, lida do buffer real do xterm
// (via terminalRegistry). Funciona com qualquer renderer (WebGL/DOM) e inclui
// o scrollback, mesmo com o nó fora da tela ou em outro canvas.

import { hasTerminal, readTerminalText } from "./terminalRegistry";

/** Últimas `max` linhas não vazias do terminal, ou null se indisponível. */
export function readTerminalTail(nodeId: string, max = 30): string | null {
  if (!hasTerminal(nodeId)) return null;
  const lines = readTerminalText(nodeId, max + 40)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-max).join("\n");
}
