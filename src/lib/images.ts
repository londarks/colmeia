// Imagens soltas/coladas viram data URL embutida no canvas. Para não inchar o
// workspace.json (salvo a cada mudança), imagens grandes são reduzidas.

const MAX_DIM = 1600;
const MAX_INLINE_BYTES = 600 * 1024;

export interface PreparedImage {
  src: string;
  width: number;
  height: number;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("imagem inválida"));
    img.src = src;
  });
}

/** Mede e, se preciso, reduz (lado máx. 1600px, re-encode em webp). SVG fica como está. */
export async function prepareImage(dataUrl: string): Promise<PreparedImage> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth || 320;
  const h = img.naturalHeight || 240;
  const isSvg = dataUrl.startsWith("data:image/svg");
  const big = dataUrl.length * 0.75 > MAX_INLINE_BYTES || Math.max(w, h) > MAX_DIM;
  if (isSvg || !big) return { src: dataUrl, width: w, height: h };
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { src: dataUrl, width: w, height: h };
  ctx.drawImage(img, 0, 0, cw, ch);
  return { src: canvas.toDataURL("image/webp", 0.88), width: cw, height: ch };
}

/** Tamanho inicial do nó: cabe em ~420px mantendo a proporção. */
export function fitNodeSize(w: number, h: number, max = 420): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * s), height: Math.round(h * s) };
}
