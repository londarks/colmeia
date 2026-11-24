// Soltar coisas no canvas:
//  - arquivo de imagem → ImageNode
//  - .md / .txt → nota com o conteúdo
//  - .json de partitura → revisão de import (callback)
//  - URL arrastada (de um navegador) → nó browser
// Arquivos chegam pelo drag-drop nativo do Tauri (só caminhos; o conteúdo é
// lido por `dropped_file_read`). URLs/arquivos que chegam como drop HTML5 são
// tratados também, como fallback.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useReactFlow, type Node, type XYPosition } from "@xyflow/react";
import type { CanvasApi } from "../lib/canvas";
import { blobToDataUrl } from "../lib/images";
import {
  baseName,
  isHttpUrl,
  makeBrowserNode,
  makeImageNode,
  makeNoteNode,
} from "../lib/nodeFactory";
import { PARTITURA_KIND } from "../lib/partituras";

interface DroppedFile {
  kind: "image" | "text" | "json";
  name: string;
  text?: string;
  dataUrl?: string;
}

export interface FileDropOptions {
  /** Chamado com o JSON de uma partitura solta no canvas (para revisar). */
  onPartitura?: (raw: unknown, source: string) => void;
}

const STAGGER = 36;
const TEXT_EXT = /\.(md|markdown|txt)$/i;

/** O ponto (cliente) está sobre o canvas? */
function overCanvas(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return !!el?.closest(".react-flow");
}

function parsePartitura(text: string): unknown | null {
  try {
    const v = JSON.parse(text) as { kind?: unknown; nodes?: unknown };
    return v && v.kind === PARTITURA_KIND && Array.isArray(v.nodes) ? v : null;
  } catch {
    return null;
  }
}

export function useFileDrop(api: CanvasApi, opts: FileDropOptions = {}) {
  const { screenToFlowPosition } = useReactFlow();
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const add = (node: Node) => api.setNodes((nds) => nds.concat(node));

    const handleFile = async (f: DroppedFile, at: XYPosition, source: string) => {
      if (f.kind === "image" && f.dataUrl) {
        add(await makeImageNode(f.dataUrl, at, f.name));
      } else if (f.kind === "text") {
        add(makeNoteNode(baseName(f.name), f.text ?? "", at));
      } else if (f.kind === "json" && f.text) {
        const p = parsePartitura(f.text);
        if (p) optsRef.current.onPartitura?.(p, source);
      }
    };

    // ---- drop nativo do Tauri (arquivos do SO) ----
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        if (e.payload.type !== "drop") return;
        const dpr = window.devicePixelRatio || 1;
        const client = { x: e.payload.position.x / dpr, y: e.payload.position.y / dpr };
        if (!overCanvas(client.x, client.y)) return;
        const base = screenToFlowPosition(client);
        let i = 0;
        for (const path of e.payload.paths) {
          const at = { x: base.x + i * STAGGER, y: base.y + i * STAGGER };
          i += 1;
          try {
            const f = await invoke<DroppedFile>("dropped_file_read", { path });
            await handleFile(f, at, path);
          } catch (err) {
            console.warn("drop ignorado:", path, err);
          }
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {});

    // ---- drop HTML5 (URLs arrastadas; arquivos se o drop nativo estiver desligado) ----
    const accepts = (dt: DataTransfer | null) =>
      !!dt && (dt.types.includes("text/uri-list") || dt.types.includes("Files"));

    const onDragOver = (e: DragEvent) => {
      if (!accepts(e.dataTransfer) || !overCanvas(e.clientX, e.clientY)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onDrop = async (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!accepts(dt) || !dt || !overCanvas(e.clientX, e.clientY)) return;
      e.preventDefault();
      const base = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const files = Array.from(dt.files);
      if (files.length) {
        let i = 0;
        for (const file of files) {
          const at = { x: base.x + i * STAGGER, y: base.y + i * STAGGER };
          i += 1;
          try {
            if (file.type.startsWith("image/")) {
              await handleFile(
                { kind: "image", name: file.name, dataUrl: await blobToDataUrl(file) },
                at,
                file.name,
              );
            } else if (TEXT_EXT.test(file.name)) {
              await handleFile({ kind: "text", name: file.name, text: await file.text() }, at, file.name);
            } else if (/\.json$/i.test(file.name)) {
              await handleFile({ kind: "json", name: file.name, text: await file.text() }, at, file.name);
            }
          } catch {
            /* ignora arquivo ilegível */
          }
        }
        return;
      }
      const uri =
        dt.getData("text/uri-list")
          .split(/\r?\n/)
          .find((l) => l && !l.startsWith("#")) ?? dt.getData("text/plain");
      if (uri && isHttpUrl(uri)) add(makeBrowserNode(uri.trim(), base));
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [api, screenToFlowPosition]);
}
