// Preferências de UX por usuário (snap, dock...). Guardadas no localStorage com
// try/catch: em janela privada / storage bloqueado, volta para o padrão em memória.

import { useCallback, useState } from "react";

const PREFIX = "colmeia.ux.";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage indisponível: fica só em memória */
  }
}

/** useState persistido no localStorage. */
export function usePref<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        writePref(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, set];
}
