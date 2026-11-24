import { memo, useEffect, useRef } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { X, Folder, ShieldCheck, Crown, Maximize2, Search } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { AGENTS, type AgentId } from "../lib/agents";
import { roleById, useRoles } from "../lib/roles";
import { markSeen } from "../lib/activity";
import {
  acquireTerminal,
  attachTerminal,
  detachTerminal,
  liftTerminal,
  openSearch,
  unliftTerminal,
  useLiftedTerminal,
  useSearchOpen,
} from "../lib/terminalRegistry";
import { ActivityIndicator, StatusPill } from "../components/TerminalBadges";
import { TerminalSearchBar } from "../components/TerminalSearchBar";

export interface TerminalNodeData {
  agent: AgentId;
  title?: string;
  role?: string;
  waiting?: boolean;
  cwd?: string;
  autoApproveInCwd?: boolean;
  /** Maestro: o backend dá permissões de orquestração a este agente. */
  maestro?: boolean;
  /** Muda para reiniciar o processo mantendo id/arestas (role assign, recruit --replace). */
  restartKey?: number;
}

function TerminalNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as TerminalNodeData;
  const agent = AGENTS[d.agent];
  const roles = useRoles();
  const role = roleById(d.role) ?? roles.find((r) => r.id === d.role);
  const slotRef = useRef<HTMLDivElement>(null);
  const { deleteElements, updateNodeData } = useReactFlow();
  const lifted = useLiftedTerminal() === id;
  const searching = useSearchOpen(id);

  const cwdName = d.cwd ? d.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;

  // Abre o seletor de pasta; trocar a pasta reinicia o terminal nela.
  const pickFolder = async () => {
    try {
      const dir = await open({ directory: true, defaultPath: d.cwd });
      if (typeof dir === "string" && dir !== d.cwd) {
        updateNodeData(id, { cwd: dir });
      }
    } catch {
      /* cancelado */
    }
  };

  const onRoleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const roleId = e.target.value;
    // O papel entra no boot do agente: trocar reinicia o processo (num shell
    // puro o papel não faz diferença, então só atualiza o rótulo).
    updateNodeData(
      id,
      d.agent === "shell"
        ? { role: roleId || undefined }
        : { role: roleId || undefined, restartKey: Date.now() },
    );
  };

  // O terminal vive no registry (sobrevive à troca de canvas): aqui só garantimos que ele
  // existe e anexamos o elemento dele ao corpo do nó. Desmontar NÃO mata o processo.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    acquireTerminal(id, {
      agent: d.agent,
      cwd: d.cwd,
      role: d.role,
      restartKey: d.restartKey,
    });
    attachTerminal(id, slot, 0);
    return () => detachTerminal(id, slot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, d.cwd, d.agent, d.restartKey]);

  const toggleLift = () => (lifted ? unliftTerminal() : liftTerminal(id));

  return (
    <div
      className={`term-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: agent.color } as React.CSSProperties}
      onPointerDown={() => markSeen(id)}
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

      <div
        className="node-header"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, select, input")) return;
          toggleLift();
        }}
        title="Duplo clique para expandir"
      >
        <ActivityIndicator id={id} waiting={d.waiting} />
        <span className="node-title">
          <agent.icon className="node-icon" size={13} strokeWidth={1.9} />
          <span className="node-title-text">{d.title ?? agent.label}</span>
        </span>
        <StatusPill id={id} />
        <button
          className={`cwd-btn nodrag ${d.cwd ? "has-cwd" : ""}`}
          onClick={pickFolder}
          onMouseDown={(e) => e.stopPropagation()}
          title={d.cwd ? `Pasta: ${d.cwd}` : "Definir pasta de trabalho"}
        >
          <Folder size={12} strokeWidth={2} />
          {cwdName && <span className="cwd-name">{cwdName}</span>}
        </button>
        {d.cwd && (
          <button
            className={`autoapprove-btn nodrag ${d.autoApproveInCwd ? "on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              updateNodeData(id, { autoApproveInCwd: !d.autoApproveInCwd });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title={
              d.autoApproveInCwd
                ? "Auto-aprovando escritas na pasta — clique para desligar"
                : "Auto-aprovar escritas dentro da pasta (Write/Edit)"
            }
          >
            <ShieldCheck size={12} strokeWidth={2} />
          </button>
        )}
        <button
          className={`maestro-btn nodrag ${d.maestro ? "on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            updateNodeData(id, { maestro: !d.maestro });
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title={
            d.maestro
              ? "Maestro: pode orquestrar a equipe — clique para desligar"
              : "Tornar maestro (permissões de orquestração)"
          }
        >
          <Crown size={12} strokeWidth={2} />
        </button>
        <select
          className={`role-select nodrag ${role ? "" : "is-empty"}`}
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
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          className="node-icon-btn nodrag"
          title="Buscar no terminal (Ctrl+F)"
          onClick={(e) => {
            e.stopPropagation();
            openSearch(id);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Search size={12} strokeWidth={2} />
        </button>
        <button
          className="node-icon-btn nodrag"
          title="Expandir (duplo clique no cabeçalho · F11)"
          onClick={(e) => {
            e.stopPropagation();
            toggleLift();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Maximize2 size={12} strokeWidth={2} />
        </button>
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

      <div className="term-body-wrap">
        <div ref={slotRef} className="term-body nodrag nowheel" />
        {lifted && (
          <div className="term-lifted-placeholder nodrag" onDoubleClick={unliftTerminal}>
            Em destaque — Esc ou F11 para voltar
          </div>
        )}
        {searching && !lifted && <TerminalSearchBar id={id} />}
      </div>

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const TerminalNode = memo(TerminalNodeInner);
