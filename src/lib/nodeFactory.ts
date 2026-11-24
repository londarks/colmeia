// Fábricas de nós usadas por colar/soltar no canvas.

import type { Node, XYPosition } from "@xyflow/react";
import { newNodeId } from "./canvas";
import { fitNodeSize, prepareImage } from "./images";

/** `at` é o centro desejado (coordenadas do canvas). */
export async function makeImageNode(dataUrl: string, at: XYPosition, title?: string): Promise<Node> {
  const img = await prepareImage(dataUrl);
  const size = fitNodeSize(img.width, img.height);
  return {
    id: newNodeId("image"),
    type: "image",
    position: { x: at.x - size.width / 2, y: at.y - size.height / 2 },
    data: { src: img.src, title },
    style: size,
  };
}

export function makeNoteNode(title: string, content: string, at: XYPosition): Node {
  return {
    id: newNodeId("note"),
    type: "note",
    position: { x: at.x - 160, y: at.y - 120 },
    data: { title: title || "Nota", content },
    style: { width: 320, height: 240 },
  };
}

export function makeBrowserNode(url: string, at: XYPosition): Node {
  return {
    id: newNodeId("browser"),
    type: "browser",
    position: { x: at.x - 280, y: at.y - 210 },
    data: { title: "Browser", url },
    style: { width: 560, height: 420 },
  };
}

/** Nome sem extensão, para título de nota. */
export function baseName(name: string): string {
  const file = name.split(/[\\/]/).pop() ?? name;
  return file.replace(/\.[^.]+$/, "") || file;
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}
