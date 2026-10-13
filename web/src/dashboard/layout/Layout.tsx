import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { CommandPalette, Kbd, MOD, useShortcuts } from "./CommandPalette";
import { LogoMark } from "../../shared/Logo";
import { useBrand } from "../../shared/brand";
import { ThemeToggle } from "../../shared/ThemeToggle";
import { CREDOC_ADDRESS, chain, explorerAddress } from "../../shared/config";
import { amount, shortHex } from "../../shared/format";
import { useAdmin } from "../lib/admin";
import { pendingActions } from "../lib/model";
import { useStore } from "../lib/store";
import { useWallet } from "../lib/wallet";

const NAV: { title: string; items: { to: string; icon: string; label: string; badge?: "actions" }[] }[] = [
  {
    title: "Trade",
    items: [
      { to: "/", icon: "ti-layout-dashboard", label: "Overview", badge: "actions" },
      { to: "/credits", icon: "ti-file-certificate", label: "Credits" },
      { to: "/credits/new", icon: "ti-square-rounded-plus", label: "Open a credit" },
    ],
  },
  {
    title: "Documents",
    items: [
      { to: "/attest", icon: "ti-signature", label: "Attest documents" },
      { to: "/verify", icon: "ti-file-search", label: "Verify a document" },
    ],
  },
  { title: "Financing", items: [{ to: "/market", icon: "ti-building-bank", label: "Receivables market" }] },
  {
    title: "Trust",
    items: [
      { to: "/identity", icon: "ti-id-badge-2", label: "Track record" },
      { to: "/activity", icon: "ti-activity", label: "Activity" },
    ],
  },
  { title: "Account", items: [{ to: "/plans", icon: "ti-crown", label: "Plans" }] },
];
/** Shown only to a signed-in admin session (lib/admin.ts). */
const ADMIN_NAV: (typeof NAV)[number] = { title: "Admin", items: [{ to: "/admin", icon: "ti-shield-lock", label: "Admin" }] };

/** Osen sizes the sidebar from the window width; mirror its breakpoints without its jQuery. */
function useSidenavSize() {
  useEffect(() => {
    const html = document.documentElement;
    const apply = () => {
      const w = window.innerWidth;
      html.setAttribute("data-sidenav-size", w <= 767.98 ? "full" : w <= 1140 ? "condensed" : "default");
      if (w > 767.98) html.classList.remove("sidebar-enable");
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

function Sidenav({ actionCount, close }: { actionCount: number; close: () => void }) {
  const brand = useBrand();
  const admin = useAdmin().status === "admin";
  return (
    <div className="sidenav-menu">
      <NavLink to="/" className="logo px-4" onClick={close}>
        <LogoMark className="credoc-mark" />
        <span className="credoc-wordmark logo-lg-text">Credoc</span>
        {brand.name !== "Credoc" && <span className="logo-lg-text fs-12 text-muted ms-2 text-truncate">{brand.name}</span>}
      </NavLink>
      <button className="button-close-fullsidebar" onClick={close} aria-label="Close menu">
        <i className="ti ti-x align-middle" />
      </button>
      <div className="credoc-sidenav-body d-flex flex-column overflow-auto">
        <ul className="side-nav">
          {(admin ? [...NAV, ADMIN_NAV] : NAV).flatMap((section) => [
            <li key={section.title} className="side-nav-title mt-2">
              {section.title}
            </li>,
            ...section.items.map((it) => <NavItem key={it.to} {...it} count={it.badge ? actionCount : 0} close={close} />),
          ])}
        </ul>
        <div className="credoc-sidenav-note px-4 py-3 mt-auto border-top border-dashed fs-12 text-muted" title="Funds are held by the contract, never by Credoc.">
          <div className="d-flex align-items-center gap-1">
            <i className="ti ti-lock" aria-hidden="true" />
            <span className="note-text">Funds are held by the contract, never by Credoc.</span>
          </div>
          {CREDOC_ADDRESS && (
            <div className="mt-1 hash note-text">
              <a href={explorerAddress(CREDOC_ADDRESS)} target="_blank" rel="noreferrer" className="link-secondary">
                {shortHex(CREDOC_ADDRESS)} <i className="ti ti-external-link" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NavItem({ to, icon, label, count, close }: { to: string; icon: string; label: string; count: number; close: () => void }) {
  const { pathname } = useLocation();
  const active = to === "/" ? pathname === "/" : to === "/credits" ? /^\/credits(\/\d+)?$/.test(pathname) : pathname.startsWith(to);
  return (
    <li className={`side-nav-item ${active ? "active" : ""}`}>
      <NavLink to={to} end={to === "/"} className={`side-nav-link ${active ? "active" : ""}`} onClick={close}>
        <span className="menu-icon">
          <i className={`ti ${icon}`} />
        </span>
        <span className="menu-text">{label}</span>
        {count > 0 && <span className="badge bg-dark rounded-pill">{count}</span>}
      </NavLink>
    </li>
  );
}

function Topbar({ toggle, openPalette }: { toggle: () => void; openPalette: () => void }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menu.current && !menu.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);


  return (
    <header className="app-topbar">
      <div className="page-container topbar-menu">
        <div className="d-flex align-items-center gap-2">
          <button className="sidenav-toggle-button px-2" onClick={toggle} aria-label="Toggle menu">
            <i className="ti ti-menu-deep fs-24" />
          </button>
          <button
            type="button"
            onClick={openPalette}
            className="topbar-search credoc-search-trigger text-muted d-none d-lg-flex gap-2 align-items-center border-0"
            aria-label={`Search credits and pages (${MOD} K)`}
          >
            <i className="ti ti-search fs-18" />
            <span className="flex-grow-1 text-start">Search…</span>
            <Kbd keys={[MOD, "K"]} />
          </button>
          <button type="button" onClick={openPalette} className="topbar-link btn btn-link px-2 d-lg-none" aria-label="Search">
            <i className="ti ti-search fs-20" />
          </button>
        </div>

        <div className="d-flex align-items-center gap-2">
          <ThemeToggle size={26} className="topbar-link credoc-theme-btn" />
          <span className="network-pill d-none d-sm-inline-flex" title={`chainId ${chain.id}`}>
            <span className="dot" /> {chain.name}
          </span>

          {w.wrongChain && (
            <button className="btn btn-sm btn-warning" onClick={() => void w.switchChain()}>
              Switch to Arc
            </button>
          )}

          <div className="topbar-item position-relative" ref={menu}>
            {w.address ? (
              <button className="topbar-link btn btn-outline-light text-dark px-2 d-flex align-items-center gap-2" onClick={() => setOpen(!open)} aria-expanded={open}>
                <i className="ti ti-wallet fs-18" />
                <span className="d-none d-md-inline text-start lh-sm">
                  <span className="d-block fw-semibold">{shortHex(w.address)}</span>
                  {w.balances && (
                    <span className="d-block fs-11 text-muted num">
                      {amount(w.balances.usdc)} USDC · {amount(w.balances.eurc)} EURC
                    </span>
                  )}
                </span>
                <i className="ti ti-chevron-down" />
              </button>
            ) : (
              <Link className="btn btn-dark" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
                Sign in
              </Link>
            )}
            {open && (
              <div className="dropdown-menu dropdown-menu-end show p-2" style={{ right: 0, left: "auto", minWidth: 280, top: "calc(100% + 8px)" }}>
                {w.hasInjected && w.kind !== "injected" && (
                  <button className="dropdown-item rounded" onClick={() => void w.connect().then(() => setOpen(false))}>
                    <i className="ti ti-plug me-1" /> Connect browser wallet
                  </button>
                )}
                {w.address && (
                  <>
                    <div className="px-2 py-1 hash text-muted">{w.address}</div>
                    <button className="dropdown-item rounded text-danger" onClick={() => { w.disconnect(); setOpen(false); }}>
                      <i className="ti ti-logout me-1" /> Sign out
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

export function Layout() {
  useSidenavSize();
  const { address } = useWallet();
  const { credits, offers, now, status, error } = useStore();
  const actions = pendingActions(credits, offers, address, now());
  const { pathname } = useLocation();
  const brand = useBrand();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useShortcuts(openPalette);
  useEffect(() => {
    document.documentElement.classList.toggle("sidebar-enable", mobileOpen);
  }, [mobileOpen]);
  const close = () => setMobileOpen(false);
  const toggle = () => {
    const html = document.documentElement;
    const size = html.getAttribute("data-sidenav-size");
    if (size === "full") setMobileOpen((o) => !o);
    else html.setAttribute("data-sidenav-size", size === "condensed" ? "default" : "condensed");
  };
  useEffect(() => {
    window.scrollTo(0, 0);
    close();
  }, [pathname]);

  return (
    <div className="wrapper">
      <Topbar toggle={toggle} openPalette={openPalette} />
      <Sidenav actionCount={actions.length} close={close} />
      <div className="page-content">
        <div className="page-container">
          {status === "unconfigured" && (
            <div className="alert alert-warning mt-3">
              Credoc is not deployed on Arc mainnet yet: set <code>VITE_CREDOC_ADDRESS</code> once the contract is live.
            </div>
          )}
          {status === "error" && <div className="alert alert-danger mt-3">Cannot reach the network: {error}</div>}
          <Outlet />
        </div>
        <footer className="footer">
          <div className="page-container d-flex justify-content-between flex-wrap gap-2 fs-12 text-muted">
            <span>
              {brand.name === "Credoc" ? "Credoc · letters of credit settled on Arc" : `${brand.name} · Powered by Credoc`}
            </span>
            <span>
              <a href="/" className="link-secondary me-3">Home</a>
              <a href="/#faq" className="link-secondary">FAQ</a>
            </span>
          </div>
        </footer>
      </div>
      {mobileOpen && <div className="offcanvas-backdrop fade show" onClick={close} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
