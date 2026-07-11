import { memo, useEffect, useRef } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  type NodeProps,
} from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { AGENTS, type AgentId } from "../lib/agents";
import { readXtermTheme } from "../lib/theme";
import { ptySpawn, ptyWrite, ptyResize, ptyKill, b64ToBytes } from "../lib/pty";

export interface TerminalNodeData {
  agent: AgentId;
  title?: string;
  cwd?: string;
}

function TerminalNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as TerminalNodeData;
  const agent = AGENTS[d.agent];
  const termRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

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

    const { command, args } = agent.resolve();
    let exited = false;

    ptySpawn(
      { id, command, args, cwd: d.cwd, cols: term.cols || 80, rows: term.rows || 24 },
      (msg) => {
        if (msg.kind === "data") {
          term.write(b64ToBytes(msg.b64));
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
        <span className="grip" aria-hidden>
          ⣿
        </span>
        <span className="dot" />
        <span className="node-title">
          {agent.emoji} {d.title ?? agent.label}
        </span>
        <span className="node-id">{id}</span>
      </div>

      <div ref={termRef} className="term-body nodrag nowheel" />

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const TerminalNode = memo(TerminalNodeInner);
