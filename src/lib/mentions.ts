// Menções do Composer: `@Nome` para agentes (terminais) e `#Nome` para notas.
// Nomes podem ter espaços ("Claude Code 1"), então a leitura é pelo MAIOR título que
// casa a partir do símbolo (sem diferenciar maiúsculas), seguido de fim ou de um
// caractere que não seja letra/dígito.

export type MentionSym = "@" | "#";

export interface Mentionable {
  id: string;
  title: string;
  sym: MentionSym;
}

export interface MentionHit {
  id: string;
  sym: MentionSym;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}_]/u;

function boundaryBefore(text: string, i: number): boolean {
  return i === 0 || !WORD.test(text[i - 1]);
}

/** Todas as menções reconhecidas no texto, na ordem. */
export function findMentions(text: string, items: Mentionable[]): MentionHit[] {
  const bySym: Record<MentionSym, Mentionable[]> = { "@": [], "#": [] };
  for (const it of items) if (it.title.trim()) bySym[it.sym].push(it);
  bySym["@"].sort((a, b) => b.title.length - a.title.length);
  bySym["#"].sort((a, b) => b.title.length - a.title.length);
  const lower = text.toLowerCase();
  const out: MentionHit[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as MentionSym;
    if ((c !== "@" && c !== "#") || !boundaryBefore(text, i)) continue;
    for (const it of bySym[c]) {
      const t = it.title.toLowerCase();
      const end = i + 1 + t.length;
      if (lower.startsWith(t, i + 1) && (end >= text.length || !WORD.test(text[end]))) {
        out.push({ id: it.id, sym: c, start: i, end });
        i = end - 1;
        break;
      }
    }
  }
  return out;
}

/** Menção sendo digitada no cursor (para o autocomplete), se houver. */
export function activeQuery(
  text: string,
  caret: number,
): { sym: MentionSym; start: number; query: string } | null {
  for (let i = caret - 1; i >= 0 && caret - i <= 48; i--) {
    const c = text[i];
    if (c === "\n") return null;
    if ((c === "@" || c === "#") && boundaryBefore(text, i)) {
      return { sym: c, start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

/** Candidatos para o autocomplete: começa com a busca primeiro, depois contém. */
export function suggest(items: Mentionable[], sym: MentionSym, query: string, limit = 8): Mentionable[] {
  const q = query.toLowerCase();
  const pool = items.filter((it) => it.sym === sym && it.title.trim());
  const starts = pool.filter((it) => it.title.toLowerCase().startsWith(q));
  const contains = pool.filter(
    (it) => !it.title.toLowerCase().startsWith(q) && it.title.toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, limit);
}

/** Texto final entregue a cada agente: a mensagem + o conteúdo das notas mencionadas. */
export function buildPayload(message: string, notes: { title: string; content: string }[]): string {
  const body = message.trim();
  if (!notes.length) return body;
  const parts = notes.map(
    (n) => `--- Nota "${n.title}" ---\n${n.content.trim() || "(vazia)"}\n--- fim da nota "${n.title}" ---`,
  );
  return `${body}\n\n${parts.join("\n\n")}`;
}
