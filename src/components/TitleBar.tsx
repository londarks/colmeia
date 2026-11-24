import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoUrl from "../assets/logo.png";

// Barra de título customizada (janela sem moldura do SO). Os controles de
// janela seguem os do app "markdown": ícones finos de 10px, botões de 44px.
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((u) => u()).catch(() => {});
    };
  }, []);

  const win = () => getCurrentWindow();

  return (
    <div className="titlebar">
      <div className="titlebar-brand" data-tauri-drag-region>
        <img src={logoUrl} className="titlebar-logo" alt="" data-tauri-drag-region />
        <span className="titlebar-name" data-tauri-drag-region>
          colmeia
        </span>
      </div>

      <div className="titlebar-drag" data-tauri-drag-region />

      <div className="window-controls">
        <button
          type="button"
          className="win-btn"
          title="Minimizar"
          aria-label="Minimizar"
          onClick={() => win().minimize()}
        >
          <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="win-btn"
          title={maximized ? "Restaurar" : "Maximizar"}
          aria-label={maximized ? "Restaurar" : "Maximizar"}
          onClick={async () => {
            await win().toggleMaximize();
            setMaximized(await win().isMaximized());
          }}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="2" y="0" width="8" height="8" rx="0.5" stroke="currentColor" strokeWidth="1" />
              <rect
                x="0"
                y="2"
                width="8"
                height="8"
                rx="0.5"
                stroke="currentColor"
                strokeWidth="1"
                fill="var(--bg-sidebar)"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="win-btn win-close"
          title="Fechar"
          aria-label="Fechar"
          onClick={() => win().close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
