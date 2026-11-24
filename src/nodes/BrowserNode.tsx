// Nó de portal: um Chromium headless de verdade (controlado por CDP no backend)
// exibido por screencast. O usuário clica/rola/digita no quadro e isso é
// repassado ao navegador; os agentes ligados por aresta usam `colmeia portal`.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, CornerDownLeft, Globe, RotateCw, X } from "lucide-react";
import {
  cdpModifiers,
  normalizeUrl,
  portalAttach,
  portalDetach,
  portalHistory,
  portalInput,
  portalNavigate,
  portalResize,
  type PortalEvent,
} from "../lib/portal";

export interface BrowserNodeData {
  title?: string;
  url?: string;
  /** Título da página aberta (só exibição). */
  pageTitle?: string;
}

const COLOR = "#38bdf8";
const MOVE_THROTTLE_MS = 40;

const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll",
  z: "undo",
  y: "redo",
  x: "cut",
  c: "copy",
};

function newKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function BrowserNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as BrowserNodeData;
  const { updateNodeData, deleteElements } = useReactFlow();
  const [input, setInput] = useState(d.url ?? "");
  const [active, setActive] = useState(!!d.url);
  const [attachNonce, setAttachNonce] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const frameSize = useRef({ w: 0, h: 0 });
  const hasFrameRef = useRef(false);
  const lastMove = useRef(0);
  const urlRef = useRef(d.url);
  urlRef.current = d.url;

  // Um agente (ou colar/soltar) deu uma URL a um nó ainda inativo → liga.
  useEffect(() => {
    if (d.url && !active) setActive(true);
    if (d.url && document.activeElement !== urlInputRef.current) setInput(d.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.url]);

  const onEvent = useCallback(
    (ev: PortalEvent) => {
      switch (ev.kind) {
        case "frame": {
          if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${ev.b64}`;
          frameSize.current = { w: ev.width, h: ev.height };
          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }
          break;
        }
        case "nav": {
          if (document.activeElement !== urlInputRef.current) setInput(ev.url);
          setStatus((s) => (s.startsWith("erro") ? "" : s));
          const patch: Partial<BrowserNodeData> = {};
          if (ev.url && ev.url !== "about:blank" && ev.url !== urlRef.current) patch.url = ev.url;
          if (ev.title) patch.pageTitle = ev.title;
          if (Object.keys(patch).length) updateNodeData(id, patch);
          break;
        }
        case "status":
          setStatus(ev.text);
          if (ev.text === "") setError(null);
          break;
        case "error":
          setError(ev.message);
          setStatus("");
          break;
        case "closed":
          setClosed(ev.reason);
          break;
      }
    },
    [id, updateNodeData],
  );

  // Liga o nó ao navegador do portal enquanto estiver montado.
  useEffect(() => {
    if (!active) return;
    const key = newKey();
    const el = bodyRef.current;
    const w = Math.max(200, Math.round(el?.offsetWidth ?? 800));
    const h = Math.max(150, Math.round(el?.offsetHeight ?? 600));
    setClosed(null);
    setError(null);
    portalAttach(id, key, urlRef.current, w, h, onEvent).catch((e) => setError(String(e)));
    return () => {
      portalDetach(id, key).catch(() => {});
    };
  }, [id, active, attachNonce, onEvent]);

  // O backend reabriu o navegador (ação de um agente depois de um crash) → religa.
  useEffect(() => {
    const un = listen<{ id: string }>("colmeia://portal-reattach", (e) => {
      if (e.payload.id === id) setAttachNonce((n) => n + 1);
    });
    return () => {
      un.then((f) => f());
    };
  }, [id]);

  // Viewport do navegador = tamanho do quadro (px de layout, independe do zoom).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !active) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        portalResize(id, Math.round(el.offsetWidth), Math.round(el.offsetHeight)).catch(() => {});
      }, 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [id, active]);

  const go = () => {
    const u = normalizeUrl(input);
    if (!u) return;
    setInput(u);
    updateNodeData(id, { url: u });
    if (!active) {
      setActive(true);
    } else if (closed) {
      setAttachNonce((n) => n + 1);
    } else {
      portalNavigate(id, u).catch((e) => setError(String(e)));
    }
  };

  // ── Entrada do usuário → CDP ─────────────────────────────────────────

  /** Converte a posição do mouse (tela, com zoom do canvas) em px CSS da página. */
  const point = (e: { clientX: number; clientY: number }) => {
    const el = bodyRef.current!;
    const r = el.getBoundingClientRect();
    const fw = frameSize.current.w || el.offsetWidth;
    const fh = frameSize.current.h || el.offsetHeight;
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * fw,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * fh,
    };
  };

  const buttonName = (b: number) => (b === 2 ? "right" : b === 1 ? "middle" : "left");

  const sendMouse = (params: Record<string, unknown>) => {
    portalInput(id, { kind: "mouse", params }).catch(() => {});
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!hasFrame) return;
    e.stopPropagation();
    bodyRef.current?.focus();
    sendMouse({
      type: "mousePressed",
      ...point(e),
      button: buttonName(e.button),
      buttons: e.buttons,
      clickCount: e.detail || 1,
      modifiers: cdpModifiers(e),
    });
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!hasFrame) return;
    e.stopPropagation();
    sendMouse({
      type: "mouseReleased",
      ...point(e),
      button: buttonName(e.button),
      buttons: e.buttons,
      clickCount: e.detail || 1,
      modifiers: cdpModifiers(e),
    });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!hasFrame) return;
    const now = performance.now();
    if (now - lastMove.current < MOVE_THROTTLE_MS) return;
    lastMove.current = now;
    sendMouse({
      type: "mouseMoved",
      ...point(e),
      button: e.buttons & 1 ? "left" : "none",
      buttons: e.buttons,
      modifiers: cdpModifiers(e),
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!hasFrame) return;
    e.stopPropagation();
    const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    sendMouse({
      type: "mouseWheel",
      ...point(e),
      deltaX: e.deltaX * scale,
      deltaY: e.deltaY * scale,
      modifiers: cdpModifiers(e),
    });
  };

  const keyParams = (e: React.KeyboardEvent, down: boolean) => {
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    const text = down ? (printable ? e.key : e.key === "Enter" ? "\r" : "") : "";
    const p: Record<string, unknown> = {
      type: down ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      modifiers: cdpModifiers(e),
      autoRepeat: e.repeat,
    };
    if (text) {
      p.text = text;
      p.unmodifiedText = text;
    }
    if (down && (e.ctrlKey || e.metaKey)) {
      const cmd = EDIT_COMMANDS[e.key.toLowerCase()];
      if (cmd) p.commands = [cmd];
    }
    return p;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!hasFrame) return;
    e.stopPropagation();
    // Ctrl/Cmd+V: deixa o navegador disparar o `paste` (tratado abaixo).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    portalInput(id, { kind: "key", params: keyParams(e, true) }).catch(() => {});
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!hasFrame) return;
    e.stopPropagation();
    e.preventDefault();
    portalInput(id, { kind: "key", params: keyParams(e, false) }).catch(() => {});
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!hasFrame) return;
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData.getData("text");
    if (text) portalInput(id, { kind: "text", text }).catch(() => {});
  };

  const overlay = error
    ? { text: error, tone: "error" as const }
    : closed
      ? { text: `O navegador do portal fechou (${closed}).`, tone: "closed" as const }
      : status
        ? { text: status, tone: "info" as const }
        : null;

  return (
    <div
      className={`browser-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: COLOR } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={340}
        minHeight={260}
        isVisible={!!selected}
        color={COLOR}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />
      <Handle type="target" position={Position.Left} className="term-handle" />

      <div className="node-header browser-header" title={d.pageTitle || undefined}>
        <Globe size={13} className="node-icon" />
        <span className="portal-name">{d.title ?? "Portal"}</span>
        <button
          className="browser-go nodrag"
          title="Voltar"
          disabled={!active}
          onClick={() => portalHistory(id, "back").catch(() => {})}
        >
          <ArrowLeft size={13} strokeWidth={2.2} />
        </button>
        <button
          className="browser-go nodrag"
          title="Avançar"
          disabled={!active}
          onClick={() => portalHistory(id, "forward").catch(() => {})}
        >
          <ArrowRight size={13} strokeWidth={2.2} />
        </button>
        <button
          className="browser-go nodrag"
          title="Recarregar"
          disabled={!active}
          onClick={() => portalHistory(id, "reload").catch(() => {})}
        >
          <RotateCw size={12} strokeWidth={2.2} />
        </button>
        <input
          ref={urlInputRef}
          className="browser-url nodrag nokey"
          value={input}
          placeholder="digite uma URL…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") go();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button className="browser-go nodrag" title="Ir" onClick={go}>
          <CornerDownLeft size={13} strokeWidth={2.2} />
        </button>
        <button
          className="node-close nodrag"
          title="Fechar"
          onClick={(e) => {
            e.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div
        ref={bodyRef}
        className="browser-body portal-frame nodrag nowheel nokey"
        tabIndex={0}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onContextMenu={(e) => e.preventDefault()}
      >
        {active ? (
          <img
            ref={imgRef}
            className="portal-img"
            alt=""
            draggable={false}
            style={{ visibility: hasFrame ? "visible" : "hidden" }}
          />
        ) : (
          <div className="browser-empty">
            Digite uma URL e Enter — ou um agente ligado usa <code>colmeia portal open</code>.
          </div>
        )}
        {active && overlay && (
          <div className={`portal-overlay is-${overlay.tone}`}>
            <span>{overlay.text}</span>
            {overlay.tone !== "info" && (
              <button
                className="portal-retry nodrag"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setAttachNonce((n) => n + 1);
                }}
              >
                Reabrir
              </button>
            )}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const BrowserNode = memo(BrowserNodeInner);
