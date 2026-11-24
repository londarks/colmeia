import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  closeSearch,
  onSearchResults,
  searchTerminal,
} from "../lib/terminalRegistry";

// Barrinha de busca sobreposta ao terminal (Ctrl+F com o terminal focado).
// Enter = próximo · Shift+Enter = anterior · Esc = fecha e devolve o foco ao terminal.
export function TerminalSearchBar({ id }: { id: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // Ctrl+F de novo com a barra já aberta: volta o foco ao campo.
    const onReopen = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id !== id) return;
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("colmeia:terminal-search", onReopen);
    const off = onSearchResults(id, (r) =>
      setResult({ index: r.resultIndex, count: r.resultCount }),
    );
    return () => {
      window.removeEventListener("colmeia:terminal-search", onReopen);
      off();
    };
  }, [id]);

  const run = (dir: "next" | "previous", incremental = false) => {
    if (!query) {
      setResult(null);
      searchTerminal(id, "", dir);
      return;
    }
    const found = searchTerminal(id, query, dir, { caseSensitive, incremental });
    if (!found) setResult({ index: -1, count: 0 });
  };

  // Busca incremental enquanto digita.
  useEffect(() => {
    run("next", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive]);

  const label = !query
    ? ""
    : !result || result.count === 0
      ? "sem resultados"
      : result.index < 0
        ? `${result.count}+`
        : `${result.index + 1} de ${result.count}`;

  return (
    <div
      className="term-search nodrag nowheel"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="term-search-input"
        value={query}
        placeholder="Buscar no terminal"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            closeSearch(id);
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(e.shiftKey ? "previous" : "next");
          }
        }}
      />
      <span className={`term-search-count ${query && result?.count === 0 ? "none" : ""}`}>
        {label}
      </span>
      <button
        className={`term-search-btn ${caseSensitive ? "on" : ""}`}
        title="Diferenciar maiúsculas/minúsculas"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button
        className="term-search-btn"
        title="Anterior (Shift+Enter)"
        onClick={() => run("previous")}
      >
        <ChevronUp size={13} strokeWidth={2} />
      </button>
      <button
        className="term-search-btn"
        title="Próximo (Enter)"
        onClick={() => run("next")}
      >
        <ChevronDown size={13} strokeWidth={2} />
      </button>
      <button
        className="term-search-btn"
        title="Fechar (Esc)"
        onClick={() => closeSearch(id)}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
