import { useEffect, useState } from "react";
import { LogoMark } from "../shared/Logo";

export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#191919] focus-visible:ring-offset-2";

const LINKS = [
  { href: "#product", label: "Product" },
  { href: "#how", label: "How it works" },
  { href: "#arc", label: "Why Arc" },
  { href: "#faq", label: "FAQ" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight - 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 px-6 sm:px-10 md:px-14 py-4 sm:py-5 transition-colors duration-200 ${
        scrolled ? "bg-white border-b border-gray-200" : ""
      }`}
    >
      <nav className="flex items-center justify-between" aria-label="Main">
        <a href="#top" className={`flex items-center gap-2.5 rounded ${focusRing}`}>
          <LogoMark className="w-6 h-6 text-[#191919]" />
          <span className="font-semibold text-base tracking-tight text-[#191919]">Credoc</span>
        </a>
        <ul className="hidden md:flex items-center gap-8">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className={`text-sm text-[#191919]/70 hover:text-[#191919] transition-colors duration-200 rounded ${focusRing}`}
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <a
          href="/app/"
          className={`px-5 py-2.5 bg-[#191919] text-white text-sm font-medium rounded-lg hover:bg-[#191919]/90 transition-colors duration-200 ${focusRing}`}
        >
          Launch app
        </a>
      </nav>
    </header>
  );
}
