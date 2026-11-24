// Notificações e atividade dos agentes.
//
// Ouve os eventos do backend (contrato fixo):
//   colmeia://notify            { id, title, body }
//   colmeia://activity          { id, state: "working" | "idle" | "attention", reason? }
//   colmeia://approval-request  ApprovalRequest (já existente)
// e transforma em: toast in-app (clicável → foca o nó), notificação do SO e
// piscar a taskbar quando a janela está sem foco. Também segura o keep-awake
// enquanto algum agente estiver `working`.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Node } from "@xyflow/react";
import { keepAwake, type ApprovalRequest } from "./pty";
import { nodeToast } from "../components/Toasts";
import { nodeIdOfActiveElement } from "./camera";

export type ActivityState = "working" | "idle" | "attention";

const PREF_KEY = "colmeia:os-notifications";
/** Folga antes de soltar o keep-awake (evita liga/desliga entre turnos). */
const KEEP_AWAKE_GRACE_MS = 5000;
/** Não repete a mesma notificação do SO (mesmo agente + tipo) dentro disso. */
const OS_DEDUP_MS = 5000;

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}
function writePref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* storage indisponível: vale só nesta sessão */
  }
}

/** A janela do app está em primeiro plano? */
function windowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

let permission: Promise<boolean> | null = null;
function ensurePermission(): Promise<boolean> {
  if (!permission) {
    permission = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === "granted";
      } catch {
        return false;
      }
    })();
    // Se negar, tenta de novo numa próxima vez (o usuário pode ter mudado no SO).
    permission.then((ok) => {
      if (!ok) permission = null;
    });
  }
  return permission;
}

interface Params {
  /** Nós atuais (para título e ordem espacial dos agentes em atenção). */
  nodes: Node[];
  /** Leva a câmera até o nó e foca (clique no toast). */
  focusNode: (id: string) => void;
}

export function useNotifications({ nodes, focusNode }: Params) {
  const [activity, setActivity] = useState<Record<string, ActivityState>>({});
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [osEnabled, setOsEnabledState] = useState<boolean>(readPref);
  const osRef = useRef(osEnabled);
  osRef.current = osEnabled;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const focusRef = useRef(focusNode);
  focusRef.current = focusNode;
  const lastOs = useRef<Record<string, number>>({});

  const setOsEnabled = useCallback((on: boolean) => {
    writePref(on);
    setOsEnabledState(on);
    if (on) ensurePermission();
  }, []);

  const titleOf = (id: string) => {
    const n = nodesRef.current.find((x) => x.id === id);
    return ((n?.data as { title?: string } | undefined)?.title ?? id) as string;
  };

  /** Notificação do SO + piscar taskbar, só com a janela desfocada e a preferência ligada. */
  const alertOs = useCallback(async (key: string, title: string, body?: string) => {
    if (!osRef.current || windowFocused()) return;
    const now = Date.now();
    if (now - (lastOs.current[key] ?? 0) < OS_DEDUP_MS) return;
    lastOs.current[key] = now;
    getCurrentWindow()
      .requestUserAttention(UserAttentionType.Informational)
      .catch(() => {});
    if (await ensurePermission()) {
      try {
        sendNotification({ title, body });
      } catch {
        /* ignora */
      }
    }
  }, []);

  /** Limpa o estado de atenção (o usuário viu o agente). */
  const markSeen = useCallback((id: string) => {
    if (activityRef.current[id] !== "attention") return;
    setActivity((prev) => ({ ...prev, [id]: "idle" }));
  }, []);

  // Focar um terminal (clique/teclado) conta como "visto".
  useEffect(() => {
    const onFocusIn = () => {
      const id = nodeIdOfActiveElement();
      if (id) markSeen(id);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [markSeen]);

  useEffect(() => {
    const subs = [
      listen<{ id: string; title?: string; body?: string }>("colmeia://notify", (e) => {
        const { id, title, body } = e.payload;
        const agent = id ? titleOf(id) : "";
        const head = title || (agent ? `${agent} avisa` : "colmeia");
        nodeToast({
          title: head,
          body: body || undefined,
          tone: "attention",
          key: `notify-${id}-${head}`,
          onClick: id ? () => focusRef.current(id) : undefined,
        });
        alertOs(`notify-${id}`, head, body);
      }),
      listen<{ id: string; state: ActivityState; reason?: string }>(
        "colmeia://activity",
        (e) => {
          const { id, state, reason } = e.payload;
          if (!id) return;
          const prev = activityRef.current[id];
          if (prev === state) return;
          activityRef.current = { ...activityRef.current, [id]: state };
          setActivity(activityRef.current);
          const name = titleOf(id);
          if (state === "attention") {
            const title = `${name} precisa de você`;
            nodeToast({
              title,
              body: reason,
              tone: "attention",
              key: `attention-${id}`,
              duration: 10000,
              onClick: () => focusRef.current(id),
            });
            alertOs(`attention-${id}`, title, reason);
          } else if (state === "idle" && prev === "working" && !windowFocused()) {
            const title = `${name} terminou`;
            nodeToast({
              title,
              body: reason,
              tone: "done",
              key: `done-${id}`,
              duration: 10000,
              onClick: () => focusRef.current(id),
            });
            alertOs(`done-${id}`, title, reason);
          }
        },
      ),
      listen<ApprovalRequest>("colmeia://approval-request", (e) => {
        const a = e.payload;
        alertOs(
          `approval-${a.node}`,
          `${a.title || titleOf(a.node)} pede aprovação`,
          [a.tool, a.summary].filter(Boolean).join(": "),
        );
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertOs]);

  // Esquece a atividade de nós que não existem mais.
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const stale = Object.keys(activityRef.current).filter((id) => !ids.has(id));
    if (!stale.length) return;
    const next = { ...activityRef.current };
    for (const id of stale) delete next[id];
    activityRef.current = next;
    setActivity(next);
  }, [nodes]);

  // Keep-awake: segura enquanto houver agente trabalhando; solta com folga.
  const anyWorking = Object.values(activity).some((s) => s === "working");
  const awakeOn = useRef(false);
  useEffect(() => {
    if (anyWorking) {
      if (!awakeOn.current) {
        awakeOn.current = true;
        keepAwake(true).catch(() => {});
      }
      return;
    }
    if (!awakeOn.current) return;
    const t = window.setTimeout(() => {
      awakeOn.current = false;
      keepAwake(false).catch(() => {});
    }, KEEP_AWAKE_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [anyWorking]);
  useEffect(
    () => () => {
      if (awakeOn.current) keepAwake(false).catch(() => {});
    },
    [],
  );

  /** Agentes em atenção (evento `attention` ou aprovação pendente), em ordem espacial. */
  const attentionIds = nodes
    .filter(
      (n) =>
        activity[n.id] === "attention" || !!(n.data as { waiting?: boolean }).waiting,
    )
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((n) => n.id);

  return { activity, attentionIds, markSeen, osEnabled, setOsEnabled };
}

export type Notifications = ReturnType<typeof useNotifications>;
