// Toasts in-app (sonner, MIT) com as cores do tema ativo.

import { Toaster, toast } from "sonner";
import { Bell, CheckCircle2, ShieldAlert } from "lucide-react";

export function ThemedToaster() {
  return (
    <Toaster
      position="bottom-right"
      visibleToasts={5}
      gap={8}
      toastOptions={{
        className: "cl-sonner",
        style: {
          background: "var(--bg-dropdown)",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
        },
      }}
    />
  );
}

export type NodeToastTone = "attention" | "done" | "approval" | "info";

const ICONS = {
  attention: Bell,
  done: CheckCircle2,
  approval: ShieldAlert,
  info: Bell,
} as const;

/** Toast clicável: clicar em qualquer parte foca o nó do agente. */
export function nodeToast(opts: {
  title: string;
  body?: string;
  tone?: NodeToastTone;
  onClick?: () => void;
  /** Chave para colapsar toasts repetidos do mesmo agente/tipo. */
  key?: string;
  duration?: number;
}) {
  const tone = opts.tone ?? "info";
  const Icon = ICONS[tone];
  toast.custom(
    (t) => (
      <button
        type="button"
        className={`cl-toast tone-${tone}`}
        onClick={() => {
          opts.onClick?.();
          toast.dismiss(t);
        }}
        title={opts.onClick ? "Clique para ir até o agente" : undefined}
      >
        <Icon className="cl-toast-icon" size={16} strokeWidth={2} />
        <span className="cl-toast-text">
          <b>{opts.title}</b>
          {opts.body && <span>{opts.body}</span>}
        </span>
      </button>
    ),
    { id: opts.key, duration: opts.duration ?? 6000 },
  );
}
