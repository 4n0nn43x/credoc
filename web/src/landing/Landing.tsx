import { ArrowRight } from "lucide-react";
import { HeroSketch } from "./HeroSketch";
import { ThemeToggle } from "../shared/ThemeToggle";
import { useThemeShortcut } from "../shared/theme";
import { Navbar, focusRing } from "./Navbar";
import { Arc, CtaBand, Faq, Financing, Footer, How, Pricing, Product } from "./Sections";

const PILLARS = [
  { n: "01", label: "Secured", href: "#how" },
  { n: "02", label: "Instant", href: "#arc" },
  { n: "03", label: "Financeable", href: "#financing" },
];

function Hero() {
  return (
    // min-h-screen below md so the stacked panel is never clipped on short phones.
    <section id="top" className="relative flex flex-col items-center overflow-hidden min-h-screen md:h-screen">
      <HeroSketch />
      {/* the sun in the sketch's sky is the theme switch (desktop); phones find it in the menu */}
      <ThemeToggle size={104} className={`hidden md:block absolute z-10 top-24 right-[5%] lg:right-[7%] text-ink/80 hover:text-ink rounded-full ${focusRing}`} />

      <div className="relative z-10 flex flex-col items-center text-center pt-24 sm:pt-[6.5rem] md:pt-32 px-4 sm:px-6">
        <h1 className="font-serif text-4xl sm:text-5xl md:text-7xl lg:text-8xl leading-[1.1] tracking-tighter text-ink font-normal">
          Get paid the
          <br />
          second it ships.
        </h1>
        <p className="max-w-sm sm:max-w-md mt-5 sm:mt-6 md:mt-8 text-sm md:text-base text-ink/70 leading-relaxed">
          Letters of credit for small importers and exporters. Funds locked in USDC or EURC on Arc, released
          the moment the bill of lading is signed.
        </p>
        <a
          href="/app/#/credits/new"
          data-hero-cta
          className={`mt-6 sm:mt-8 md:mt-10 px-6 sm:px-8 py-3 sm:py-3.5 bg-ink text-white text-sm font-medium rounded-lg hover:bg-ink/90 transition-colors duration-200 ${focusRing}`}
        >
          Open a credit
        </a>
      </div>

      <div className="relative z-10 mt-auto pt-12 md:pt-0 w-full max-w-5xl px-4 sm:px-6">
        <div data-hero-panel className="bg-white/90 backdrop-blur-sm border border-gray-200 border-b-0 pt-8 sm:pt-12 md:pt-16 px-5 sm:px-8 md:px-12 pb-0 shadow-sm">
          <div className="grid md:grid-cols-2 gap-6 sm:gap-8 md:gap-16">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-ink/50 font-medium">What is Credoc?</p>
              <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-serif font-normal leading-tight tracking-tight text-ink">
                Letters of credit,
                <br className="hidden sm:block" /> without the bank
              </h2>
            </div>
            <p className="self-end text-sm md:text-[15px] text-ink/70 leading-relaxed">
              A cash-backed documentary credit as a smart contract. The importer locks the funds, independent
              attestors present the shipping documents, and the exporter is paid in the same second. No
              correspondent bank, no minimum ticket.
            </p>
          </div>
          <div className="mt-6 sm:mt-8 md:mt-10 h-px bg-gray-200 w-full" />
          <div className="grid sm:grid-cols-3 gap-2 sm:gap-3 py-4 sm:py-6">
            {PILLARS.map((p) => (
              <a
                key={p.n}
                href={p.href}
                className={`group bg-wash hover:bg-wash-2 transition-all duration-200 cursor-pointer px-4 sm:px-6 py-3.5 sm:py-4 flex items-center justify-between text-sm text-ink ${focusRing}`}
              >
                <span>
                  <span className="text-ink/40">{p.n}</span>
                  <span className="mx-2 text-ink/30" aria-hidden="true">
                    /
                  </span>
                  <span className="font-medium">{p.label}</span>
                </span>
                <ArrowRight
                  className="w-4 h-4 text-gray-400 group-hover:text-gray-700 group-hover:translate-x-0.5 transition-all duration-200"
                  aria-hidden="true"
                />
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Landing() {
  useThemeShortcut();
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:bg-white focus:px-3 focus:py-2 focus:ring-2 focus:ring-ink"
      >
        Skip to content
      </a>
      <Navbar />
      <main id="main">
        <Hero />
        <Product />
        <How />
        <Financing />
        <Arc />
        <Pricing />
        <Faq />
        <CtaBand />
      </main>
      <Footer />
    </>
  );
}
