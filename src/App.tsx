import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
} from "@xyflow/react";
import { listen } from "@tauri-apps/api/event";
import { TerminalNode } from "./nodes/TerminalNode";
import { NoteNode } from "./nodes/NoteNode";
import { AGENTS, AGENT_LIST, type AgentId } from "./lib/agents";
import { THEMES, getStoredTheme, applyTheme } from "./lib/theme";
import { setGraph } from "./lib/pty";
import "./App.css";

let counter = 0;

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [theme, setTheme] = useState<string>(getStoredTheme());
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ terminal: TerminalNode, note: NoteNode }),
    [],
  );

  // Referência sempre atualizada dos nós, para resolver títulos em callbacks.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Espelha o grafo no backend sempre que nós/arestas mudam (escopo do roteamento).
  useEffect(() => {
    const graphNodes = nodes.map((n) => ({
      id: n.id,
      type: n.type ?? "terminal",
      title: (n.data as { title?: string }).title ?? n.id,
    }));
    const graphEdges = edges.map((e) => ({ source: e.source, target: e.target }));
    setGraph(graphNodes, graphEdges).catch(() => {});
  }, [nodes, edges]);

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)),
    [setEdges],
  );

  const addNode = useCallback(
    (agent: AgentId) => {
      counter += 1;
      const id = `${agent}-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) => {
        // Título humano único por tipo: "Claude Code 1", "Shell 2"...
        const sameKind = nds.filter(
          (n) => (n.data as { agent?: AgentId }).agent === agent,
        ).length;
        const title = `${AGENTS[agent].label} ${sameKind + 1}`;
        return nds.concat({
          id,
          type: "terminal",
          position: { x: 140 + offset, y: 110 + offset },
          data: { agent, title },
          style: { width: 500, height: 340 },
        });
      });
    },
    [setNodes],
  );

  const addNoteNode = useCallback(
    (title: string, content: string) => {
      counter += 1;
      const id = `note-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) =>
        nds.concat({
          id,
          type: "note",
          position: { x: 200 + offset, y: 160 + offset },
          data: { title: title || "Nota", content: content || "" },
          style: { width: 280, height: 200 },
        }),
      );
    },
    [setNodes],
  );

  // Conecta dois nós resolvendo-os pelo título (usado por `colmeia connect`).
  const connectByTitle = useCallback(
    (source: string, target: string) => {
      const byTitle = (t: string) =>
        nodesRef.current.find(
          (n) =>
            ((n.data as { title?: string }).title ?? n.id).toLowerCase() ===
            t.toLowerCase(),
        );
      const a = byTitle(source);
      const b = byTitle(target);
      if (a && b && a.id !== b.id) {
        setEdges((eds) =>
          addEdge(
            { id: `e-${a.id}-${b.id}`, source: a.id, target: b.id, animated: true },
            eds,
          ),
        );
      }
    },
    [setEdges],
  );

  // Ouve pedidos do backend (agente rodando `colmeia note` / `colmeia connect`).
  useEffect(() => {
    const subs = [
      listen<{ title: string; content: string }>("colmeia://add-note", (e) =>
        addNoteNode(e.payload.title, e.payload.content),
      ),
      listen<{ source: string; target: string }>("colmeia://connect", (e) =>
        connectByTitle(e.payload.source, e.payload.target),
      ),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [addNoteNode, connectByTitle]);

  const nodeColor = useCallback(
    (n: Node) =>
      n.type === "note"
        ? "#f59e0b"
        : AGENTS[(n.data as { agent: AgentId }).agent]?.color ?? "#666",
    [],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🐝</span>
          <b>colmeia</b>
          <span className="tag">orquestrador de agentes</span>
        </div>

        <div className="spacer" />

        <div className="add-group">
          {AGENT_LIST.map((a) => (
            <button
              key={a.id}
              className="add-btn"
              style={{ ["--c" as string]: a.color } as React.CSSProperties}
              onClick={() => addNode(a.id)}
              title={`Adicionar ${a.label}`}
            >
              <span className="add-emoji">{a.emoji}</span>
              {a.label}
            </button>
          ))}
          <button
            className="add-btn"
            style={{ ["--c" as string]: "#f59e0b" } as React.CSSProperties}
            onClick={() => addNoteNode("Nota", "")}
            title="Adicionar nota"
          >
            <span className="add-emoji">📝</span>
            Nota
          </button>
        </div>

        <div className="divider" />

        <label className="theme-picker" title="Tema">
          <span className="theme-swatch" />
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            animated: true,
            style: { stroke: "var(--accent)", strokeWidth: 2 },
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--border)"
          />
          <MiniMap
            className="minimap"
            pannable
            zoomable
            nodeColor={nodeColor}
            nodeStrokeWidth={0}
            maskColor="rgba(0, 0, 0, 0.55)"
          />
          <Controls className="controls" showInteractive={false} />
        </ReactFlow>

        {nodes.length === 0 && (
          <div className="empty">
            <div className="empty-badge">🐝</div>
            <h2>Canvas vazio</h2>
            <p>
              Adicione um agente na barra acima. Cada nó é um <b>terminal real</b>,
              rodando um shell ou uma CLI de agente de verdade.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
