// Menu de contexto próprio (sem dependência): itens, separadores, marcação (✓),
// atalho exibido e submenus. Fecha com Esc, clique fora, rolagem ou ao escolher.
// Teclado: ↑/↓ navega, Enter/Espaço escolhe, → abre submenu, ← volta.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** Atalho exibido à direita (só informativo). */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | "separator";

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
  /** Uso interno (submenus). */
  nested?: boolean;
  /** Uso interno: fecha o menu inteiro depois de escolher num submenu. */
  onChosen?: () => void;
}

const isItem = (e: MenuEntry): e is MenuItem => e !== "separator";

export function ContextMenu({ x, y, entries, onClose, nested, onChosen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subAt, setSubAt] = useState({ x: 0, y: 0 });
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Mantém o menu dentro da janela.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 4 ? Math.max(4, (nested ? x - r.width - 200 : x - r.width)) : x;
    const ny = y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y;
    setPos({ x: nx, y: ny });
  }, [x, y, nested]);

  // Fecha ao clicar fora / rolar / perder o foco da janela (só o menu raiz escuta).
  useEffect(() => {
    if (nested) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ux-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const close = () => onClose();
    // Rolar o canvas fecha; rolar dentro de um menu comprido, não.
    const onWheel = (e: WheelEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ux-menu")) onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [nested, onClose]);

  // Foco no menu ao abrir (o submenu também, para o teclado navegar nele).
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const openSubmenu = (i: number) => {
    const btn = itemRefs.current[i];
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setSubAt({ x: r.right + 2, y: r.top - 4 });
    setOpenSub(i);
  };

  const choose = (i: number) => {
    const e = entries[i];
    if (!e || !isItem(e) || e.disabled) return;
    if (e.submenu) {
      openSubmenu(i);
      return;
    }
    (onChosen ?? onClose)();
    e.onSelect?.();
  };

  const step = (dir: 1 | -1) => {
    const n = entries.length;
    let i = active;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      const e = entries[i];
      if (isItem(e) && !e.disabled) break;
    }
    setActive(i);
    itemRefs.current[i]?.focus({ preventScroll: true });
  };

  return (
    <>
      <div
        ref={ref}
        className="ux-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            step(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            step(-1);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (active >= 0) choose(active);
          } else if (e.key === "ArrowRight") {
            const it = entries[active];
            if (it && isItem(it) && it.submenu) {
              e.preventDefault();
              openSubmenu(active);
            }
          } else if (e.key === "ArrowLeft" && nested) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {entries.length === 0 && <div className="ux-menu-empty">Nada aqui</div>}
        {entries.map((e, i) =>
          e === "separator" ? (
            <div key={`sep-${i}`} className="ux-menu-sep" role="separator" />
          ) : (
            <button
              key={`${e.label}-${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitem"
              className={`ux-menu-item ${e.danger ? "danger" : ""} ${active === i ? "active" : ""}`}
              disabled={e.disabled}
              onMouseEnter={() => {
                setActive(i);
                if (e.submenu && !e.disabled) openSubmenu(i);
                else setOpenSub(null);
              }}
              onClick={(ev) => {
                ev.stopPropagation();
                choose(i);
              }}
            >
              <span className="ux-menu-check">
                {e.checked ? <Check size={12} strokeWidth={2.2} /> : e.icon ?? null}
              </span>
              <span className="ux-menu-label">{e.label}</span>
              {e.hint && <span className="ux-menu-hint">{e.hint}</span>}
              {e.submenu && <ChevronRight size={12} strokeWidth={2} className="ux-menu-arrow" />}
            </button>
          ),
        )}
      </div>
      {openSub !== null && isItem(entries[openSub]) && (entries[openSub] as MenuItem).submenu && (
        <ContextMenu
          nested
          x={subAt.x}
          y={subAt.y}
          entries={(entries[openSub] as MenuItem).submenu!}
          onClose={() => {
            // ← no teclado: fecha só o submenu e devolve o foco ao item pai.
            setOpenSub(null);
            itemRefs.current[openSub]?.focus({ preventScroll: true });
          }}
          onChosen={onChosen ?? onClose}
        />
      )}
    </>
  );
}
