// One theme for the landing page and the dashboard: saved in localStorage (same origin, so both follow it and other
// tabs update live), the system preference until the user picks one. public/theme-init.js applies it before paint.
import { useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "credoc-theme";
const EVENT = "credoc-theme";

export const currentTheme = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

function apply(t: Theme) {
  const r = document.documentElement;
  r.classList.toggle("dark", t === "dark"); // landing (Tailwind tokens)
  r.setAttribute("data-bs-theme", t); // dashboard (Bootstrap 5.3 colour modes)
  r.style.colorScheme = t; // native controls and scrollbars
  window.dispatchEvent(new Event(EVENT));
}

const saved = (): Theme | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // storage blocked: the theme still switches, it is just not remembered
  }
};

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* see saved() */
  }
  apply(t);
}

export const toggleTheme = () => setTheme(currentTheme() === "dark" ? "light" : "dark");

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY && (e.newValue === "light" || e.newValue === "dark")) apply(e.newValue);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!saved()) apply(e.matches ? "dark" : "light");
  });
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Current theme, re-rendering when it changes (button, shortcut, another tab or the system). */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, currentTheme, () => "light");

/** Subscribe outside React (the hero canvas redraws its still frame). */
export const onThemeChange = subscribe;

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** "D" switches the theme anywhere, except while typing or with a modifier held. */
export function isThemeKey(e: KeyboardEvent) {
  return e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target);
}

export function useThemeShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isThemeKey(e)) toggleTheme();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
