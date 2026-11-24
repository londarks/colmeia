// Paleta pequena de notas e grupos, sempre via tokens do tema (nada de hex fixo).

export const NOTE_COLORS = {
  amber: { label: "Âmbar", value: "var(--warning)" },
  blue: { label: "Azul", value: "var(--info)" },
  green: { label: "Verde", value: "var(--success)" },
  red: { label: "Vermelho", value: "var(--error)" },
  accent: { label: "Destaque", value: "var(--accent)" },
  gray: { label: "Neutro", value: "var(--text-muted)" },
} as const;
export type NoteColor = keyof typeof NOTE_COLORS;

export function isNoteColor(c: unknown): c is NoteColor {
  return typeof c === "string" && Object.prototype.hasOwnProperty.call(NOTE_COLORS, c);
}

export function noteColorValue(c?: unknown, fallback: NoteColor = "amber"): string {
  return NOTE_COLORS[isNoteColor(c) ? c : fallback].value;
}
