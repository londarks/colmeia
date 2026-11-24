// Estado + ações das partituras: listar (embutidas + salvas), salvar a seleção,
// excluir, exportar, importar com revisão e inserir no canvas.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow, type Node, type XYPosition } from "@xyflow/react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ROLE_MAP } from "../lib/roles";
import {
  BUILTIN_PARTITURAS,
  PARTITURA_EXT,
  instantiatePartitura,
  layoutSize,
  newPartituraId,
  partiturasDelete,
  partiturasExport,
  partiturasImport,
  partiturasList,
  partiturasSave,
  sanitizePartitura,
  snapshotPartitura,
  type Partitura,
} from "../lib/partituras";
import { findFreeSpot, newEdgeId, viewportCenterClient, type CanvasApi } from "../lib/canvas";

export interface InsertPartituraOptions {
  /** Centro desejado (coordenadas do canvas). Padrão: centro da viewport atual. */
  position?: XYPosition;
  /** Pasta dos terminais. Padrão: o `cwd` do terminal selecionado (se houver). */
  cwd?: string;
  /** Id de um nó já no canvas para ligar ao "líder" da partitura (maestro/orquestrador). */
  connectTo?: string;
  /** `false` insere as notas em branco. Padrão: `true`. */
  includeNoteContent?: boolean;
}

export interface InsertPartituraResult {
  partitura: Partitura;
  /** Ids dos nós criados, na ordem da partitura. */
  nodeIds: string[];
  /** chave da peça na partitura → id do nó criado. */
  idMap: Record<string, string>;
  /** Nós criados (com os títulos finais, já sem colisão). */
  created: Node[];
}

export interface PendingImport {
  partitura: Partitura;
  warnings: string[];
  source: string;
}

export interface SaveOptions {
  name: string;
  description?: string;
  includeNoteContent?: boolean;
  /** `true` salva só a seleção; `false` o canvas todo. */
  selectionOnly: boolean;
}

export function usePartituras(api: CanvasApi) {
  const { screenToFlowPosition } = useReactFlow();
  const [saved, setSaved] = useState<Partitura[]>([]);
  const [open_, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [error, setError] = useState("");

  const all = useMemo(() => [...BUILTIN_PARTITURAS, ...saved], [saved]);
  const allRef = useRef(all);
  allRef.current = all;

  const refresh = useCallback(async () => {
    try {
      setSaved(await partiturasList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const find = useCallback((nameOrId: string): Partitura | undefined => {
    const list = allRef.current;
    const q = nameOrId.trim().toLowerCase();
    return (
      list.find((p) => p.id === nameOrId) ??
      list.find((p) => p.name.toLowerCase() === q) ??
      list.find((p) => p.name.toLowerCase().startsWith(q)) ??
      (q.length >= 3 ? list.find((p) => p.name.toLowerCase().includes(q)) : undefined)
    );
  }, []);

  /**
   * Insere uma partitura (por nome ou id) no canvas, com ids novos, em espaço
   * livre perto do centro da viewport. Reutilizável (ex.: `colmeia partitura insert`).
   */
  const insertPartitura = useCallback(
    (nameOrId: string, options: InsertPartituraOptions = {}): InsertPartituraResult | null => {
      const p = find(nameOrId);
      if (!p) return null;
      const nodes = api.nodesRef.current;
      const selectedTerminal = nodes.find((n) => n.type === "terminal" && n.selected);
      const cwd =
        options.cwd ?? (selectedTerminal?.data as { cwd?: string } | undefined)?.cwd ?? undefined;
      const size = layoutSize(p);
      const center = options.position ?? screenToFlowPosition(viewportCenterClient());
      const origin = findFreeSpot(center, size, nodes);
      const takenTitles = new Set(
        nodes
          .filter((n) => n.type === "terminal")
          .map((n) => String((n.data as { title?: string }).title ?? n.id)),
      );
      const inst = instantiatePartitura(p, {
        origin,
        cwd,
        takenTitles,
        includeNoteContent: options.includeNoteContent,
      });

      const edges = [...inst.edges];
      if (options.connectTo && nodes.some((n) => n.id === options.connectTo)) {
        const leader =
          p.nodes.find((n) => n.type === "terminal" && n.data.maestro === true) ??
          p.nodes.find((n) => n.type === "terminal" && n.data.role === "orquestrador") ??
          p.nodes.find((n) => n.type === "terminal");
        if (leader) {
          const target = inst.idMap[leader.key];
          edges.push({
            id: newEdgeId(options.connectTo, target),
            source: options.connectTo,
            target,
            animated: true,
          });
        }
      }

      api.setNodes((nds) =>
        nds
          .map((n): Node => (n.selected ? { ...n, selected: false } : n))
          .concat(inst.nodes),
      );
      api.setEdges((eds) => eds.concat(edges));
      return {
        partitura: p,
        nodeIds: p.nodes.map((n) => inst.idMap[n.key]),
        idMap: inst.idMap,
        created: inst.nodes,
      };
    },
    [api, find, screenToFlowPosition],
  );

  // Catálogo resumido para o backend (`colmeia partitura list|insert` do orquestrador).
  useEffect(() => {
    const items = all.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      builtin: BUILTIN_PARTITURAS.some((b) => b.id === p.id),
      agents: p.nodes
        .filter((n) => n.type === "terminal")
        .map((n) => ({
          title: String(n.data.title ?? ""),
          role: n.data.role ? (ROLE_MAP[String(n.data.role)]?.label ?? String(n.data.role)) : "",
          agent: String(n.data.agent ?? ""),
        })),
    }));
    invoke("partituras_set_catalog", { items }).catch(() => {});
  }, [all]);

  // Pedido do backend: um orquestrador rodou `colmeia partitura insert "<nome>"`.
  // Insere ligado a ele, na pasta dele, e responde com os nomes reais dos agentes.
  const insertRef = useRef(insertPartitura);
  insertRef.current = insertPartitura;
  useEffect(() => {
    const un = listen<{ req: string; id: string; source: string }>(
      "colmeia://partitura-insert",
      (e) => {
        const { req, id, source } = e.payload;
        const src = api.nodesRef.current.find((n) => n.id === source);
        const cwd = (src?.data as { cwd?: string } | undefined)?.cwd;
        const res = insertRef.current(id, { connectTo: source || undefined, cwd });
        const done = (ok: boolean, text: string) =>
          invoke("partitura_insert_done", { req, ok, text }).catch(() => {});
        if (!res) {
          done(false, `Partitura "${id}" não está mais disponível no canvas.`);
          return;
        }
        const agents = res.created
          .filter((n) => n.type === "terminal")
          .map((n) => {
            const d = n.data as { title?: string; role?: string };
            const role = d.role ? (ROLE_MAP[d.role]?.label ?? d.role) : "";
            return `  - "${d.title ?? n.id}"${role ? ` [${role}]` : ""}`;
          });
        done(
          true,
          `Partitura "${res.partitura.name}" inserida e ligada ao líder dela.\n` +
            (agents.length ? `Agentes:\n${agents.join("\n")}\n` : "") +
            "Eles levam alguns segundos para subir. Rode `colmeia list` e delegue com `colmeia ask`.",
        );
      },
    );
    return () => {
      un.then((f) => f());
    };
  }, [api]);

  const saveFromCanvas = useCallback(
    async (opts: SaveOptions) => {
      setError("");
      const nodes = api.nodesRef.current;
      const pick = opts.selectionOnly ? nodes.filter((n) => n.selected) : nodes;
      if (pick.length === 0) {
        setError("Nada para salvar: selecione nós ou desmarque “só a seleção”.");
        return false;
      }
      const p = snapshotPartitura(pick, nodes, api.edgesRef.current, opts);
      if (p.nodes.length === 0) {
        setError("A seleção não tem peças suportadas (terminais, notas, textos, grupos).");
        return false;
      }
      try {
        await partiturasSave(p);
        await refresh();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      }
    },
    [api, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setError("");
      try {
        await partiturasDelete(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const exportOne = useCallback(async (p: Partitura) => {
    setError("");
    try {
      const safe = p.name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "partitura";
      const path = await save({
        defaultPath: `${safe}.${PARTITURA_EXT}`,
        filters: [{ name: "Partitura do colmeia", extensions: ["json"] }],
      });
      if (!path) return;
      await partiturasExport(path, p);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Recebe o conteúdo cru (de arquivo ou drop) e abre a revisão. */
  const reviewImport = useCallback((raw: unknown, source: string) => {
    setError("");
    try {
      const { partitura, warnings } = sanitizePartitura(raw);
      setPending({ partitura, warnings, source });
      setOpen(true);
    } catch (e) {
      setError(`Import falhou: ${e instanceof Error ? e.message : String(e)}`);
      setOpen(true);
    }
  }, []);

  const importFromFile = useCallback(async () => {
    setError("");
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Partitura do colmeia", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      reviewImport(await partiturasImport(path), path);
    } catch (e) {
      setError(String(e));
    }
  }, [reviewImport]);

  /** Aceita o import revisado: salva com id novo (nunca sobrescreve) e opcionalmente insere. */
  const confirmImport = useCallback(
    async (insertNow: boolean) => {
      if (!pending) return;
      const now = Date.now();
      const p: Partitura = { ...pending.partitura, id: newPartituraId(), updatedAt: now };
      try {
        await partiturasSave(p);
        setPending(null);
        await refresh();
        if (insertNow) {
          // `find` lê de `allRef`, que só atualiza no próximo render: insere direto.
          allRef.current = [...allRef.current, p];
          insertPartitura(p.id);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [pending, refresh, insertPartitura],
  );

  return {
    partituras: all,
    open: open_,
    setOpen,
    error,
    setError,
    pending,
    cancelImport: () => setPending(null),
    confirmImport,
    importFromFile,
    reviewImport,
    exportOne,
    remove,
    saveFromCanvas,
    insertPartitura,
    refresh,
  };
}

export type PartiturasApi = ReturnType<typeof usePartituras>;
