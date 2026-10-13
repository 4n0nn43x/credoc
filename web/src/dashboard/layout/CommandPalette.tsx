import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { shortHex } from "../../shared/format";
import { currentTheme, toggleTheme } from "../../shared/theme";
import { Amount, StatusBadge } from "../components/ui";
import { status } from "../lib/model";
import { useStore } from "../lib/store";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? "⌘" : "Ctrl";

/** Pages reachable from anywhere, with their two-key shortcut ("G" then a letter) or a single key. */
export const PAGES = [
  { to: "/", label: "Overview", icon: "ti-layout-dashboard", keys: ["G", "O"] },
  { to: "/credits", label: "Credits", icon: "ti-file-certificate", keys: ["G", "C"] },
  { to: "/credits/new", label: "Open a credit", icon: "ti-square-rounded-plus", keys: ["N"] },
  { to: "/attest", label: "Attest documents", icon: "ti-signature", keys: ["G", "A"] },
  { to: "/verify", label: "Verify a document", icon: "ti-file-search", keys: ["G", "V"] },
  { to: "/market", label: "Receivables market", icon: "ti-building-bank", keys: ["G", "M"] },
  { to: "/identity", label: "Track record", icon: "ti-id-badge-2", keys: ["G", "T"] },
  { to: "/activity", label: "Activity", icon: "ti-activity", keys: ["G", "Y"] },
] as const;

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function Kbd({ keys }: { keys: readonly string[] }) {
  return (
    <span className="d-inline-flex gap-1" aria-hidden="true">
      {keys.map((k, i) => (
        <kbd key={i} className="credoc-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Global shortcuts: Ctrl/⌘ K or "/" opens the palette, "N" opens a credit, "G" then a letter jumps to a page.
 * Ignored while typing in a field, so they never steal keystrokes.
 */
export function useShortcuts(open: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const k = e.key.toUpperCase();
      if (pendingG && Date.now() - pendingG < 1200) {
        // "G" then a letter: handled below, never a theme switch
      } else if (k === "D") {
        toggleTheme();
        return;
      }
      if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        open();
      } else if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        const page = PAGES.find((p) => p.keys.length === 2 && p.keys[1] === k);
        if (page) navigate(page.to);
      } else if (k === "G") {
        pendingG = Date.now();
      } else {
        const page = PAGES.find((p) => p.keys.length === 1 && p.keys[0] === k);
        if (page) navigate(page.to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, open]);
}

type Item = { id: string; group: string; run: () => void; render: React.ReactNode; text: string };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { credits, now } = useStore();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    input.current?.focus();
    const prev = returnFocus.current;
    return () => {
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, []);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase().replace(/^#/, "");
    const t = now();
    const out: Item[] = [];
    for (const c of credits) {
      const counterparty = shortHex(c.beneficiary);
      const text = `#${c.id} ${c.ref} ${c.beneficiary} ${c.applicant}`.toLowerCase();
      if (term && !text.includes(term) && c.id.toString() !== term) continue;
      out.push({
        id: `credit-${c.id}`,
        group: "Credits",
        text,
        run: () => navigate(`/credits/${c.id}`),
        render: (
          <>
            <i className="ti ti-file-certificate fs-18 text-muted" />
            <span className="flex-grow-1 text-truncate">
              <span className="fw-medium text-dark">{c.ref || `Credit #${c.id}`}</span>
              <span className="text-muted ms-2 fs-12">
                #{c.id.toString()}
                {counterparty && ` · ${counterparty}`}
              </span>
            </span>
            <Amount value={c.total} token={c.token} className="fs-13 d-none d-sm-inline" />
            <StatusBadge s={status(c, t)} />
          </>
        ),
      });
      if (!term && out.length >= 5) break;
    }
    for (const p of PAGES) {
      if (term && !p.label.toLowerCase().includes(term)) continue;
      out.push({
        id: `page-${p.to}`,
        group: "Go to",
        text: p.label,
        run: () => navigate(p.to),
        render: (
          <>
            <i className={`ti ${p.icon} fs-18 text-muted`} />
            <span className="flex-grow-1 text-dark">{p.label}</span>
            <Kbd keys={p.keys} />
          </>
        ),
      });
    }
    const dark = currentTheme() === "dark";
    const themeLabel = dark ? "Switch to light theme" : "Switch to dark theme";
    if (!term || `${themeLabel} theme dark light`.toLowerCase().includes(term))
      out.push({
        id: "theme",
        group: "Preferences",
        text: themeLabel,
        run: toggleTheme,
        render: (
          <>
            <i className={`ti ${dark ? "ti-sun" : "ti-moon"} fs-18 text-muted`} />
            <span className="flex-grow-1 text-dark">{themeLabel}</span>
            <Kbd keys={["D"]} />
          </>
        ),
      });
    return out;
  }, [q, credits, now, navigate]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <>
      <div className="modal fade show d-block" role="dialog" aria-modal="true" aria-label="Search and commands" onMouseDown={onClose}>
        <div className="modal-dialog modal-lg credoc-palette" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <div className="d-flex align-items-center gap-2 px-3 border-bottom">
              <i className="ti ti-search fs-20 text-muted" />
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                className="form-control border-0 shadow-none py-3 fs-15"
                placeholder="Search credits by number, PO or address, or pages…"
                role="combobox"
                aria-expanded="true"
                aria-controls="credoc-palette-list"
                aria-activedescendant={items[active] ? `pal-${active}` : undefined}
              />
              <kbd className="credoc-kbd">Esc</kbd>
            </div>
            <div ref={list} id="credoc-palette-list" role="listbox" className="credoc-palette-list p-2">
              {items.length === 0 && (
                <div className="text-center text-muted py-4">
                  No credit or page matches “{q}”. Try a PO reference like PO-2026-1004, or a credit number.
                </div>
              )}
              {items.map((it, i) => {
                const header = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                return (
                  <div key={it.id}>
                    {header && <div className="micro-label px-2 pt-2 pb-1">{header}</div>}
                    <div
                      id={`pal-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={i === active}
                      className={`credoc-palette-item d-flex align-items-center gap-2 ${i === active ? "is-active" : ""}`}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(i)}
                    >
                      {it.render}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="d-flex flex-wrap gap-3 px-3 py-2 border-top fs-12 text-muted">
              <span>
                <Kbd keys={["↑", "↓"]} /> navigate
              </span>
              <span>
                <Kbd keys={["↵"]} /> open
              </span>
              <span>
                <Kbd keys={[MOD, "K"]} /> or <Kbd keys={["/"]} /> search
              </span>
              <span>
                <Kbd keys={["G"]} /> then a letter: go to a page
              </span>
              <span>
                <Kbd keys={["D"]} /> theme
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show" />
    </>
  );
}
