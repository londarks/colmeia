// Renderização de markdown das notas: GFM (tabelas, tarefas, tachado), código
// com destaque simples, matemática (KaTeX) e diagramas (mermaid). KaTeX e
// mermaid são pesados, então só são carregados (import dinâmico) quando a nota
// realmente usa `$...$` ou um bloco ```mermaid```.

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

type PluginList = NonNullable<Options["remarkPlugins"]>;
type RehypeList = NonNullable<Options["rehypePlugins"]>;

// ------------------------------------------------------------------ matemática

interface MathPlugins {
  remark: PluginList[number];
  rehype: RehypeList[number];
}
let mathPromise: Promise<MathPlugins> | null = null;
function loadMath(): Promise<MathPlugins> {
  if (!mathPromise) {
    mathPromise = Promise.all([
      import("remark-math"),
      import("rehype-katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([rm, rk]) => ({ remark: rm.default, rehype: rk.default }));
  }
  return mathPromise;
}

const MATH_RE = /\$\$[\s\S]+?\$\$|(^|[^\\$\w])\$[^\s$][^$\n]*\$/;

// ------------------------------------------------------------------ mermaid

/** O tema ativo é escuro? Decide pela luminância do fundo do editor. */
function isDarkTheme(): boolean {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg-editor").trim();
  let r = 0;
  let g = 0;
  let b = 0;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = v.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return true;
    [r, g, b] = m.slice(0, 3).map(Number);
  }
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidTheme = "";
let mermaidSeq = 0;

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  const theme = isDarkTheme() ? "dark" : "default";
  if (theme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    mermaidTheme = theme;
  }
  return mermaid;
}

/** Contador que muda quando o tema global troca (para re-renderizar diagramas). */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    window.addEventListener("colmeia:themechange", on);
    return () => window.removeEventListener("colmeia:themechange", on);
  }, []);
  return tick;
}

function MermaidBlock({ code }: { code: string }) {
  const tick = useThemeTick();
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;
    getMermaid()
      .then(async (mermaid) => {
        mermaidSeq += 1;
        const { svg } = await mermaid.render(`colmeia-mmd-${mermaidSeq}`, code);
        if (alive) {
          setSvg(svg);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [code, tick]);

  if (error) {
    return (
      <div className="md-mermaid-error">
        <div>Diagrama mermaid inválido: {error}</div>
        <pre className="md-pre">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) return <div className="md-mermaid md-loading">carregando diagrama…</div>;
  // `securityLevel: "strict"` já sanitiza o SVG gerado pelo mermaid.
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// ------------------------------------------------------------------ destaque de código

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do switch case break continue new " +
    "class extends import from export default async await try catch finally throw typeof " +
    "instanceof in of interface type enum public private protected static void null " +
    "undefined true false fn pub use mod impl struct trait match mut self Self where loop " +
    "def lambda pass None True False elif and or not is with as yield raise package func " +
    "go defer select chan map range then fi esac done echo local readonly"
  ).split(" "),
);
const HASH_COMMENT_LANGS = new Set([
  "py", "python", "sh", "bash", "zsh", "shell", "yaml", "yml", "toml", "ps1",
  "powershell", "rb", "ruby", "r", "dockerfile", "make", "makefile", "conf", "ini",
]);

function highlight(code: string, lang: string): ReactNode[] {
  const hash = HASH_COMMENT_LANGS.has(lang);
  const re = new RegExp(
    [
      hash ? "(#[^\\n]*)" : "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)",
      "(\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)",
      "(\\b\\d+(?:\\.\\d+)?\\b)",
      "([A-Za-z_$][\\w$]*)",
    ].join("|"),
    "g",
  );
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [tok, com, str, num, word] = m;
    const cls = com
      ? "md-tok-com"
      : str
        ? "md-tok-str"
        : num
          ? "md-tok-num"
          : word && KEYWORDS.has(word)
            ? "md-tok-kw"
            : "";
    out.push(cls ? <span key={k++} className={cls}>{tok}</span> : tok);
    last = m.index + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

// ------------------------------------------------------------------ tarefas clicáveis

/** Alterna o `[ ]`/`[x]` do item de lista que começa em `offset` no markdown. */
export function toggleTaskAt(source: string, offset: number): string {
  const m = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/.exec(source.slice(offset));
  if (!m) return source;
  const pos = offset + m[1].length;
  const next = source[pos] === " " ? "x" : " ";
  return source.slice(0, pos) + next + source.slice(pos + 1);
}

const TaskOffsetCtx = createContext<number | null>(null);
const ToggleCtx = createContext<((offset: number) => void) | undefined>(undefined);

function TaskCheckbox(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const offset = useContext(TaskOffsetCtx);
  const onToggle = useContext(ToggleCtx);
  if (props.type !== "checkbox") return <input {...props} />;
  const enabled = !!onToggle && offset !== null;
  return (
    <input
      type="checkbox"
      className="md-task nodrag"
      checked={!!props.checked}
      disabled={!enabled}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={() => enabled && onToggle!(offset!)}
    />
  );
}

// ------------------------------------------------------------------ hast helpers

interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastLike[];
}

function hastText(n: HastLike | undefined): string {
  if (!n) return "";
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(hastText).join("");
}

function langOf(n: HastLike | undefined): string {
  const cls = n?.properties?.className;
  const list = Array.isArray(cls) ? cls.map(String) : typeof cls === "string" ? [cls] : [];
  const l = list.find((c) => c.startsWith("language-"));
  return l ? l.slice("language-".length).toLowerCase() : "";
}

const COMPONENTS: Components = {
  a: ({ node: _n, href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        // Nunca navegar a janela do app: abre no navegador do sistema.
        e.preventDefault();
        e.stopPropagation();
        if (href && /^(https?:|mailto:)/i.test(href)) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  pre: ({ node, children }) => {
    const code = (node as HastLike | undefined)?.children?.find(
      (c) => c.type === "element" && c.tagName === "code",
    );
    if (!code) return <pre className="md-pre">{children}</pre>;
    const lang = langOf(code);
    const text = hastText(code).replace(/\n$/, "");
    if (lang === "mermaid") return <MermaidBlock code={text} />;
    return (
      <pre className="md-pre nowheel">
        {lang && <span className="md-lang">{lang}</span>}
        <code>{highlight(text, lang)}</code>
      </pre>
    );
  },
  li: ({ node, className, children, ...rest }) => {
    const isTask = typeof className === "string" && className.includes("task-list-item");
    const offset = node?.position?.start.offset;
    return (
      <li className={className} {...rest}>
        {isTask && offset != null ? (
          <TaskOffsetCtx.Provider value={offset}>{children}</TaskOffsetCtx.Provider>
        ) : (
          children
        )}
      </li>
    );
  },
  input: ({ node: _n, ...rest }) => <TaskCheckbox {...rest} />,
};

// ------------------------------------------------------------------ componente

interface Props {
  source: string;
  /** Recebe o markdown atualizado quando um checkbox é clicado. Sem ele, só leitura. */
  onChange?: (next: string) => void;
}

function MarkdownInner({ source, onChange }: Props) {
  const wantsMath = MATH_RE.test(source);
  const [math, setMath] = useState<MathPlugins | null>(null);

  useEffect(() => {
    if (wantsMath && !math) {
      let alive = true;
      loadMath()
        .then((m) => alive && setMath(m))
        .catch(() => {});
      return () => {
        alive = false;
      };
    }
  }, [wantsMath, math]);

  const remarkPlugins = useMemo<PluginList>(
    () => (math && wantsMath ? [remarkGfm, math.remark] : [remarkGfm]),
    [math, wantsMath],
  );
  const rehypePlugins = useMemo<RehypeList>(
    () => (math && wantsMath ? [math.rehype] : []),
    [math, wantsMath],
  );

  const toggle = useMemo(
    () => (onChange ? (offset: number) => onChange(toggleTaskAt(source, offset)) : undefined),
    [onChange, source],
  );

  return (
    <ToggleCtx.Provider value={toggle}>
      <div className="md">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={COMPONENTS}
        >
          {source}
        </ReactMarkdown>
      </div>
    </ToggleCtx.Provider>
  );
}

export const Markdown = memo(MarkdownInner);
