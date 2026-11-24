// Error boundary por nó: um nó que quebra mostra um aviso no lugar dele (com
// "Tentar de novo", "Copiar detalhes" e "Excluir") em vez de derrubar o canvas.

import { Component, memo, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { useReactFlow, type NodeProps, type NodeTypes } from "@xyflow/react";

interface BoundaryProps {
  id: string;
  type?: string;
  children: ReactNode;
}
interface BoundaryState {
  error: Error | null;
}

class NodeErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[colmeia] nó '${this.props.id}' (${this.props.type ?? "?"}) quebrou`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <NodeErrorFallback
          id={this.props.id}
          type={this.props.type}
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function NodeErrorFallback({
  id,
  type,
  error,
  onRetry,
}: {
  id: string;
  type?: string;
  error: Error;
  onRetry: () => void;
}) {
  const { deleteElements } = useReactFlow();
  const details = `${type ?? "nó"} ${id}: ${error.message}\n${error.stack ?? ""}`;
  return (
    <div className="ux-node-error">
      <b>Este nó falhou ao renderizar</b>
      <span className="ux-node-error-msg">{error.message || String(error)}</span>
      <div className="ux-node-error-actions nodrag">
        <button onClick={onRetry}>Tentar de novo</button>
        <button onClick={() => navigator.clipboard?.writeText(details).catch(() => {})}>
          Copiar detalhes
        </button>
        <button className="danger" onClick={() => deleteElements({ nodes: [{ id }] })}>
          Excluir
        </button>
      </div>
    </div>
  );
}

/** Envolve cada tipo de nó num error boundary próprio. */
export function withNodeErrorBoundary(types: NodeTypes): NodeTypes {
  const out: NodeTypes = {};
  for (const [key, Comp] of Object.entries(types)) {
    const Inner = Comp as ComponentType<NodeProps>;
    const Wrapped = (props: NodeProps) => (
      <NodeErrorBoundary id={props.id} type={props.type}>
        <Inner {...props} />
      </NodeErrorBoundary>
    );
    Wrapped.displayName = `Safe(${key})`;
    out[key] = memo(Wrapped) as unknown as NodeTypes[string];
  }
  return out;
}
