import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { LogoMark } from "../shared/Logo";
import { ThemeToggle } from "../shared/ThemeToggle";
import { useTheme } from "../shared/theme";

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2";

const LINKS = [
  { href: "#product", label: "Product" },
  { href: "#how", label: "How it works" },
  { href: "#arc", label: "Why Arc" },
  { href: "#faq", label: "FAQ" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const dark = useTheme() === "dark";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight - 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 px-6 sm:px-10 md:px-14 py-4 sm:py-5 transition-colors duration-200 ${
        scrolled || menu ? "bg-white border-b border-gray-200" : ""
      }`}
    >
      <nav className="flex items-center justify-between" aria-label="Main">
        <a href="#top" className={`flex items-center gap-2.5 rounded ${focusRing}`}>
          <LogoMark className="w-6 h-6 text-ink" />
          <span className="font-semibold text-base tracking-tight text-ink">Credoc</span>
        </a>
        <ul className="hidden md:flex items-center gap-8">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className={`text-sm text-ink/70 hover:text-ink transition-colors duration-200 rounded ${focusRing}`}
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <a
            href="/app/"
            className={`px-5 py-2.5 bg-ink text-white text-sm font-medium rounded-lg hover:bg-ink/90 transition-colors duration-200 ${focusRing}`}
          >
            Launch app
          </a>
          <button
            type="button"
            onClick={() => setMenu(!menu)}
            aria-expanded={menu}
            aria-controls="mobile-menu"
            aria-label={menu ? "Close menu" : "Open menu"}
            className={`md:hidden p-2 -mr-2 text-ink rounded ${focusRing}`}
          >
            {menu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </nav>
      {menu && (
        <div id="mobile-menu" className="md:hidden pt-3 pb-2">
          <ul className="flex flex-col">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={() => setMenu(false)} className={`block py-3 text-base text-ink/80 rounded ${focusRing}`}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-2 pt-3 border-t border-gray-200 flex items-center justify-between">
            <span className="text-sm text-ink/70">{dark ? "Dark theme" : "Light theme"}</span>
            <ThemeToggle size={30} className={`text-ink rounded ${focusRing}`} />
          </div>
        </div>
      )}
    </header>
  );
}
