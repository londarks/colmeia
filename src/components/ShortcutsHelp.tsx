// Tela de ajuda (`?`) com a lista de atalhos.

import { useEffect, useRef } from "react";
import { SHORTCUTS } from "../lib/shortcuts";

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="cl-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="cl-help"
        role="dialog"
        aria-label="Atalhos de teclado"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h3>Atalhos de teclado</h3>
        {SHORTCUTS.map((s) => (
          <div key={s.action} className="cl-help-row">
            <span>{s.label}</span>
            <span className="cl-help-keys">
              {s.keys.map((k) => (
                <kbd key={k} className="cl-kbd">
                  {k}
                </kbd>
              ))}
            </span>
          </div>
        ))}
        <p className="cl-help-note">
          Com o foco num terminal ou campo de texto, só Ctrl+K e Ctrl+Shift+A funcionam (o
          Ctrl+Shift+A só é capturado no terminal quando há agente em atenção). Use Ctrl+K
          para navegar a partir de um terminal.
        </p>
      </div>
    </div>
  );
}
