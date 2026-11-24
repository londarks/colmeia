// Painel de partituras: salvar a seleção/canvas como template de equipe, listar
// (embutidas + salvas) com miniatura, inserir, exportar, excluir e importar com
// revisão do que vai rodar.

import { useMemo, useState } from "react";
import { useStore } from "@xyflow/react";
import {
  Music,
  X,
  Plus,
  Download,
  Upload,
  Trash2,
  ShieldAlert,
  Save,
} from "lucide-react";
import {
  previewRects,
  summarizePartitura,
  type Partitura,
} from "../lib/partituras";
import type { PartiturasApi } from "../hooks/usePartituras";

function Preview({ p }: { p: Partitura }) {
  const rects = useMemo(() => previewRects(p), [p]);
  if (rects.length === 0) return <div className="pt-preview pt-preview-empty" />;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const pad = 30;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  return (
    <svg className="pt-preview" viewBox={vb} preserveAspectRatio="xMidYMid meet">
      {rects
        .slice()
        .sort((a, b) => (a.type === "group" ? -1 : 0) - (b.type === "group" ? -1 : 0))
        .map((r, i) => (
          <rect
            key={i}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={18}
            style={
              r.type === "group"
                ? { fill: "none", stroke: r.color, strokeWidth: 8, strokeDasharray: "24 16" }
                : { fill: r.color, fillOpacity: 0.55, stroke: r.color, strokeWidth: 6 }
            }
          />
        ))}
    </svg>
  );
}

function countsLabel(p: Partitura): string {
  const s = summarizePartitura(p);
  const parts: string[] = [];
  if (s.terminals.length) parts.push(`${s.terminals.length} agente${s.terminals.length > 1 ? "s" : ""}`);
  if (s.notes.length) parts.push(`${s.notes.length} nota${s.notes.length > 1 ? "s" : ""}`);
  if (s.texts) parts.push(`${s.texts} texto${s.texts > 1 ? "s" : ""}`);
  if (s.browsers.length) parts.push(`${s.browsers.length} browser`);
  if (s.groups.length) parts.push(`${s.groups.length} grupo${s.groups.length > 1 ? "s" : ""}`);
  return parts.join(" · ") || "vazia";
}

function ImportReview({ api }: { api: PartiturasApi }) {
  const pending = api.pending!;
  const s = summarizePartitura(pending.partitura);
  return (
    <div className="pt-review">
      <div className="pt-review-title">
        <ShieldAlert size={15} strokeWidth={2} />
        Revisar import: <b>{pending.partitura.name}</b>
      </div>
      <div className="panel-hint">
        Só aceite partituras de fontes em que você confia. Ao inserir, estes processos vão rodar
        na sua máquina:
      </div>
      <ul className="pt-review-list">
        {s.terminals.map((t, i) => (
          <li key={i}>
            <div className="pt-review-row">
              <b>{t.title}</b>
              <span className="pt-chip">{t.agentLabel}</span>
              {t.role && <span className="pt-chip">{t.role}</span>}
              {t.maestro && <span className="pt-chip">maestro</span>}
            </div>
            <code className="pt-cmd">{[t.command, ...t.args].join(" ")}</code>
          </li>
        ))}
        {s.terminals.length === 0 && <li className="panel-hint">Nenhum terminal.</li>}
      </ul>
      <div className="panel-hint">
        {s.notes.length} nota(s){s.notes.some((n) => n.hasContent) ? " com texto" : ""} ·{" "}
        {s.texts} texto(s) · {s.groups.length} grupo(s) · {s.edges} conexão(ões)
        {s.browsers.length > 0 && <> · browsers: {s.browsers.join(", ")}</>}
      </div>
      {pending.warnings.length > 0 && (
        <ul className="pt-warnings">
          {pending.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div className="pt-review-actions">
        <button className="pt-btn" onClick={api.cancelImport}>
          Cancelar
        </button>
        <button className="pt-btn" onClick={() => api.confirmImport(false)}>
          Importar
        </button>
        <button className="panel-add" onClick={() => api.confirmImport(true)}>
          Importar e inserir
        </button>
      </div>
    </div>
  );
}

export function PartiturasPanel({ api }: { api: PartiturasApi }) {
  const selectedCount = useStore((s) => s.nodes.reduce((c, n) => c + (n.selected ? 1 : 0), 0));
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includeNotes, setIncludeNotes] = useState(true);
  const [selectionOnly, setSelectionOnly] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const onlySel = selectionOnly && selectedCount > 0;

  const submit = async () => {
    if (!name.trim()) {
      api.setError("Dê um nome à partitura.");
      return;
    }
    const ok = await api.saveFromCanvas({
      name: name.trim(),
      description: description.trim(),
      includeNoteContent: includeNotes,
      selectionOnly: onlySel,
    });
    if (ok) {
      setSaving(false);
      setName("");
      setDescription("");
    }
  };

  return (
    <div className="routines-panel partituras-panel">
      <div className="panel-header">
        <b>
          <Music size={15} strokeWidth={2} /> Partituras
        </b>
        <div className="pt-header-actions">
          <button className="panel-close" title="Importar de arquivo" onClick={api.importFromFile}>
            <Upload size={15} strokeWidth={2} />
          </button>
          <button
            className={`panel-close ${saving ? "on" : ""}`}
            title="Salvar como partitura"
            onClick={() => setSaving((v) => !v)}
          >
            <Save size={15} strokeWidth={2} />
          </button>
          <button className="panel-close" title="Fechar" onClick={() => api.setOpen(false)}>
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      {api.pending && <ImportReview api={api} />}

      {saving && !api.pending && (
        <div className="panel-form">
          <input
            placeholder="Nome (ex.: Squad de backend)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <input
            placeholder="Descrição (opcional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="pt-check">
            <input
              type="checkbox"
              checked={onlySel}
              disabled={selectedCount === 0}
              onChange={(e) => setSelectionOnly(e.target.checked)}
            />
            {selectedCount > 0
              ? `Só a seleção (${selectedCount} nó${selectedCount > 1 ? "s" : ""})`
              : "Sem seleção — salva o canvas inteiro"}
          </label>
          <label className="pt-check">
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(e) => setIncludeNotes(e.target.checked)}
            />
            Incluir o texto das notas
          </label>
          <div className="panel-hint">
            Pastas (cwd), comandos e caminhos não são salvos — ao inserir, os terminais herdam a
            pasta do terminal selecionado.
          </div>
          <button className="panel-add" onClick={submit}>
            Salvar partitura
          </button>
        </div>
      )}

      {api.error && <div className="panel-error pt-error">{api.error}</div>}

      <div className="panel-list">
        {api.partituras.map((p) => (
          <div key={p.id} className="pt-card">
            <Preview p={p} />
            <div className="pt-info">
              <div className="pt-name" title={p.name}>
                {p.name}
                {p.builtin && <span className="pt-chip">embutida</span>}
              </div>
              {p.description && <div className="pt-desc">{p.description}</div>}
              <div className="pt-counts">{countsLabel(p)}</div>
              <div className="pt-actions">
                <button
                  className="pt-btn primary"
                  title="Inserir no centro da tela"
                  onClick={() => api.insertPartitura(p.id)}
                >
                  <Plus size={13} strokeWidth={2.2} /> Inserir
                </button>
                <button className="pt-btn" title="Exportar para arquivo" onClick={() => api.exportOne(p)}>
                  <Download size={13} strokeWidth={2} />
                </button>
                {!p.builtin &&
                  (confirmDelete === p.id ? (
                    <button
                      className="pt-btn danger"
                      onClick={() => {
                        setConfirmDelete(null);
                        api.remove(p.id);
                      }}
                      onMouseLeave={() => setConfirmDelete(null)}
                    >
                      Confirmar
                    </button>
                  ) : (
                    <button
                      className="pt-btn danger"
                      title="Excluir"
                      onClick={() => setConfirmDelete(p.id)}
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
