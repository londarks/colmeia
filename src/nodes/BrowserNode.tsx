import { memo, useState } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { Globe, X, ArrowRight } from "lucide-react";

export interface BrowserNodeData {
  title?: string;
  url?: string;
}

const COLOR = "#38bdf8";

function BrowserNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as BrowserNodeData;
  const { updateNodeData, deleteElements } = useReactFlow();
  const [input, setInput] = useState(d.url ?? "");
  const [reloadKey, setReloadKey] = useState(0);

  const go = () => {
    let u = input.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    setInput(u);
    updateNodeData(id, { url: u });
    setReloadKey((k) => k + 1);
  };

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

      <div className="node-header browser-header">
        <Globe size={13} className="node-icon" />
        <input
          className="browser-url nodrag"
          value={input}
          placeholder="digite uma URL…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button className="browser-go nodrag" title="Ir" onClick={go}>
          <ArrowRight size={13} strokeWidth={2.2} />
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

      <div className="browser-body nodrag nowheel">
        {d.url ? (
          <iframe
            key={reloadKey}
            src={d.url}
            title={id}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="browser-empty">
            Digite uma URL e Enter — ou um agente usa <code>colmeia browse</code>.
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const BrowserNode = memo(BrowserNodeInner);
