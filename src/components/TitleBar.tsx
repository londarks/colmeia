import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import logoUrl from "../assets/logo.png";

// Barra de título customizada (janela sem moldura do SO).
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
        <img src={logoUrl} className="titlebar-logo" alt="" />
        <span className="titlebar-name">colmeia</span>
      </div>

      <div className="titlebar-drag" data-tauri-drag-region />

      <div className="window-controls">
        <button
          className="win-btn"
          title="Minimizar"
          onClick={() => win().minimize()}
        >
          <Minus size={15} strokeWidth={2} />
        </button>
        <button
          className="win-btn"
          title={maximized ? "Restaurar" : "Maximizar"}
          onClick={async () => {
            await win().toggleMaximize();
            setMaximized(await win().isMaximized());
          }}
        >
          {maximized ? (
            <Copy size={13} strokeWidth={2} />
          ) : (
            <Square size={12} strokeWidth={2} />
          )}
        </button>
        <button
          className="win-btn win-close"
          title="Fechar"
          onClick={() => win().close()}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
