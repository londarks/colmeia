import { memo, useEffect, useRef, useState } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { X } from "lucide-react";
import { AGENTS, type AgentId } from "../lib/agents";
import { ROLES, ROLE_MAP } from "../lib/roles";
import { readXtermTheme } from "../lib/theme";
import {
  ptySpawn,
  ptyWrite,
  ptySubmit,
  ptyResize,
  ptyKill,
  b64ToBytes,
} from "../lib/pty";

export interface TerminalNodeData {
  agent: AgentId;
  title?: string;
  role?: string;
  waiting?: boolean;
  cwd?: string;
}

function TerminalNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as TerminalNodeData;
  const agent = AGENTS[d.agent];
  const role = d.role ? ROLE_MAP[d.role] : undefined;
  const termRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [busy, setBusy] = useState(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { deleteElements, updateNodeData } = useReactFlow();

  const status = d.waiting ? "waiting" : busy ? "working" : "idle";

  const onRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const roleId = e.target.value;
    updateNodeData(id, { role: roleId || undefined });
    const r = roleId ? ROLE_MAP[roleId] : undefined;
    // Briefa o agente com o papel (não faz sentido num shell puro).
    if (r && d.agent !== "shell") {
      ptySubmit(id, r.briefing).catch(() => {});
    }
  };

  useEffect(() => {
    if (!termRef.current || started.current) return;
    started.current = true;

    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      theme: readXtermTheme(),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(termRef.current);
    try {
      fit.fit();
    } catch {
      /* ignora fit antes do layout */
    }

    // Copiar (Ctrl+Shift+C) e colar (Ctrl+Shift+V) — o Ctrl+C continua sendo
    // interrupção (SIGINT), como num terminal de verdade.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c") {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
      }
      if (k === "v") {
        navigator.clipboard
          .readText()
          .then((t) => {
            if (t) ptyWrite(id, t).catch(() => {});
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    const { command, args } = agent.resolve();
    let exited = false;

    ptySpawn(
      { id, command, args, cwd: d.cwd, cols: term.cols || 80, rows: term.rows || 24 },
      (msg) => {
        if (msg.kind === "data") {
          term.write(b64ToBytes(msg.b64));
          setBusy(true);
          clearTimeout(busyTimer.current);
          busyTimer.current = setTimeout(() => setBusy(false), 1200);
        } else {
          exited = true;
          term.write("\r\n\x1b[90m[processo encerrado]\x1b[0m\r\n");
        }
      },
    ).catch((e) =>
      term.write(`\r\n\x1b[31mFalha ao iniciar ${command}: ${e}\x1b[0m\r\n`),
    );

    const onData = term.onData((chunk) => {
      if (!exited) ptyWrite(id, chunk).catch(() => {});
    });
    const onResize = term.onResize(({ cols, rows }) => {
      ptyResize(id, cols, rows).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* noop */
      }
    });
    ro.observe(termRef.current);

    // Atualiza as cores quando o tema global muda.
    const onThemeChange = () => {
      term.options.theme = readXtermTheme();
    };
    window.addEventListener("colmeia:themechange", onThemeChange);

    return () => {
      window.removeEventListener("colmeia:themechange", onThemeChange);
      clearTimeout(busyTimer.current);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      ptyKill(id).catch(() => {});
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div
      className={`term-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: agent.color } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={320}
        minHeight={200}
        isVisible={!!selected}
        color={agent.color}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />
      <Handle type="target" position={Position.Left} className="term-handle" />

      <div className="node-header">
        <span
          className={`dot status-${status}`}
          title={
            status === "waiting"
              ? "Aguardando aprovação"
              : status === "working"
                ? "Trabalhando"
                : "Ocioso"
          }
        />
        <span className="node-title">
          <agent.icon className="node-icon" size={13} strokeWidth={1.9} />
          {d.title ?? agent.label}
        </span>
        <select
          className="role-select nodrag"
          value={d.role ?? ""}
          onChange={onRoleChange}
          onMouseDown={(e) => e.stopPropagation()}
          title="Papel do agente"
          style={
            role
              ? ({
                  color: role.color,
                  borderColor: role.color,
                  background: `color-mix(in srgb, ${role.color} 16%, transparent)`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {!d.role && <option value="">papel</option>}
          {ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          className="node-close nodrag"
          title="Fechar terminal"
          onClick={(e) => {
            e.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div ref={termRef} className="term-body nodrag nowheel" />

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const TerminalNode = memo(TerminalNodeInner);
