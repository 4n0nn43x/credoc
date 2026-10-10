import type { ReactNode } from "react";
import { ArrowRight, ChevronDown, FileText } from "lucide-react";
import { LogoMark } from "../shared/Logo";
import { focusRing } from "./Navbar";

const label = "text-[11px] uppercase tracking-[0.2em] text-[#191919]/60 font-medium";
const title = "mt-3 font-serif font-normal text-3xl sm:text-4xl md:text-5xl leading-tight tracking-tight text-[#191919]";
const body = "text-sm md:text-[15px] text-[#191919]/70 leading-relaxed";

function Section({ id, micro, heading, intro, children, tinted }: {
  id: string;
  micro: string;
  heading: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
  tinted?: boolean;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`scroll-mt-20 border-t border-gray-200 py-20 sm:py-28 ${tinted ? "bg-[#F4F3F3]" : "bg-white"}`}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <p className={label}>{micro}</p>
        <h2 id={`${id}-title`} className={title}>
          {heading}
        </h2>
        {intro && <p className={`mt-5 max-w-2xl ${body}`}>{intro}</p>}
        <div className="mt-12 sm:mt-16">{children}</div>
      </div>
    </section>
  );
}

/* 1. Product */

const ROLES = [
  {
    role: "Importer",
    does: "Locks the full amount in USDC or EURC, split into tranches, one per shipment, and names who attests each document.",
    gets: "Pays only against the documents. Unshipped tranches come back after expiry.",
  },
  {
    role: "Exporter",
    does: "Ships the goods knowing the cash is already locked and the credit is irrevocable: only the exporter can cancel it.",
    gets: "Paid in the same transaction as the last required document.",
  },
  {
    role: "Attestor",
    does: "A freight forwarder or inspector presents the hash of the bill of lading or inspection certificate.",
    gets: "Signs offchain with EIP-712. No wallet funds needed, the file never leaves the device.",
  },
  {
    role: "Financier",
    does: "Buys the right to a tranche's proceeds before shipment, at a discount, with the payment escrowed.",
    gets: "Collects at face value on delivery, priced from an onchain track record. Can resell.",
  },
];

export function Product() {
  return (
    <Section
      id="product"
      micro="Product"
      heading="One credit, four roles"
      intro="A documentary credit has always been a promise between several parties. Credoc writes that promise into one contract on Arc, where each party can only do its part."
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 border-t border-gray-200">
        {ROLES.map((r, i) => (
          <article
            key={r.role}
            className={`py-8 lg:px-6 border-b border-gray-200 lg:border-b-0 ${i > 0 ? "lg:border-l" : "lg:pl-0"} ${
              i % 2 === 1 ? "sm:pl-6 sm:border-l lg:pl-6" : "sm:pr-6"
            }`}
          >
            <p className="text-sm text-[#191919]/60 tabular-nums">0{i + 1}</p>
            <h3 className="mt-2 font-serif text-2xl text-[#191919]">{r.role}</h3>
            <p className={`mt-4 ${body}`}>{r.does}</p>
            <p className="mt-3 text-sm md:text-[15px] text-[#191919] leading-relaxed">{r.gets}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

/* 2. How */

const STEPS = [
  {
    name: "Open",
    text: "The importer locks the funds in one transaction: Multicall3From batches the approval and the opening, and Arc's Memo tags it with the purchase-order reference.",
  },
  {
    name: "Ship",
    text: "The exporter ships against a credit that is already fully funded. Each tranche lists its required documents and who may attest each one.",
  },
  {
    name: "Present",
    text: "The attestor signs the document's hash offchain. Anyone can relay the signature, so attesting is gasless. The file stays on the attestor's device.",
  },
  {
    name: "Settle",
    text: "When the last required document lands, the exporter is paid in that same transaction. Final in under a second. A discrepant document can be waived by the importer.",
  },
  {
    name: "Expire",
    text: "Tranches that never shipped go back to the importer after expiry. Extending the expiry needs both sides to agree.",
  },
];

function Box({ children, ink }: { children: ReactNode; ink?: boolean }) {
  return (
    <div
      className={`flex-1 border px-4 py-3 text-center text-sm ${
        ink ? "border-[#191919] bg-[#191919] text-white" : "border-gray-300 bg-white text-[#191919]"
      }`}
    >
      {children}
    </div>
  );
}

function Arrow({ caption }: { caption: string }) {
  return (
    <div className="flex flex-row sm:flex-col lg:flex-row items-center justify-center gap-2 py-2 sm:py-0 sm:px-3 lg:py-2 lg:px-0 text-[11px] text-[#191919]/60">
      <ArrowRight className="w-4 h-4 text-gray-400 rotate-90 sm:rotate-0 lg:rotate-90" aria-hidden="true" />
      <span>{caption}</span>
    </div>
  );
}

function HashDiagram() {
  return (
    <figure className="border border-gray-200 bg-[#F4F3F3] p-5 sm:p-8">
      <figcaption className={label}>Your document never leaves your device</figcaption>
      <div className="mt-6 flex flex-col sm:flex-row lg:flex-col items-stretch">
        <Box>
          <FileText className="w-4 h-4 mx-auto mb-2 text-gray-500" aria-hidden="true" />
          bill_of_lading.pdf
          <span className="block mt-1 text-[11px] text-[#191919]/60">on your device</span>
        </Box>
        <Arrow caption="hashed locally" />
        <Box>
          <span className="block font-mono text-xs whitespace-nowrap">0x7a3f...c91e</span>
          <span className="block mt-1 text-[11px] text-[#191919]/60">fingerprint (hash)</span>
        </Box>
        <Arrow caption="signed, relayed" />
        <Box ink>
          Arc
          <span className="block mt-1 text-[11px] text-white/70">only the hash is recorded</span>
        </Box>
      </div>
      <p className="mt-5 text-xs text-[#191919]/60">Illustrative hash. Anyone holding the file can recompute it and check it matches.</p>
    </figure>
  );
}

export function How() {
  return (
    <Section id="how" micro="How it works" heading="How a credit settles" tinted>
      <div className="grid lg:grid-cols-[1fr_1fr] gap-12 lg:gap-16 items-start">
        <ol className="border-l border-gray-300">
          {STEPS.map((s, i) => (
            <li key={s.name} className="relative pl-8 pb-10 last:pb-0">
              <span className="absolute -left-[5px] top-1.5 w-[9px] h-[9px] bg-[#191919]" aria-hidden="true" />
              <p className="text-sm text-[#191919]/60 tabular-nums">Step 0{i + 1}</p>
              <h3 className="mt-1 font-serif text-2xl text-[#191919]">{s.name}</h3>
              <p className={`mt-2 ${body}`}>{s.text}</p>
            </li>
          ))}
        </ol>
        <div className="lg:sticky lg:top-28">
          <HashDiagram />
        </div>
      </div>
    </Section>
  );
}

/* 3. Financing + reputation */

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 border-b border-gray-200 last:border-b-0">
      <dt className="text-sm text-[#191919]/70">{k}</dt>
      <dd className={`text-sm tabular-nums text-right ${strong ? "font-semibold text-[#191919]" : "text-[#191919]"}`}>{v}</dd>
    </div>
  );
}

function MockCard({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="mt-8 border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
        <span className="text-sm font-medium text-[#191919]">{heading}</span>
        <span className="text-[11px] uppercase tracking-[0.2em] text-[#191919]/60">Example</span>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

export function Financing() {
  return (
    <Section id="financing" micro="Financing" heading="Cash before the goods arrive">
      <div className="grid md:grid-cols-2 gap-12 md:gap-16">
        <div>
          <h3 className="font-serif text-2xl sm:text-3xl text-[#191919]">Paid before you ship</h3>
          <p className={`mt-4 ${body}`}>
            Assignment of proceeds, as in UCP 600 article 39. A financier buys the right to a tranche's proceeds
            before shipment, at a discount. The payment is escrowed, the exporter is paid now, and the financier
            collects the face value when the documents land. The right can be resold.
          </p>
          <MockCard heading="Offer on tranche 1 of 3">
            <dl>
              <Row k="Pay today" v="9,775.04 USDC" strong />
              <Row k="Collect on delivery" v="10,000.00 USDC" />
              <Row k="Offer funds" v="Escrowed in the contract" />
            </dl>
          </MockCard>
        </div>
        <div>
          <h3 className="font-serif text-2xl sm:text-3xl text-[#191919]">A track record that travels</h3>
          <p className={`mt-4 ${body}`}>
            Every settled, expired or cancelled tranche writes an ERC-8004 reputation entry to the canonical
            registry on Arc. Read back filtered by the Credoc contract, it becomes a portable history that
            financiers use to price receivables.
          </p>
          <MockCard heading="Exporter track record">
            <dl>
              <Row k="Delivered" v="2" strong />
              <Row k="Expired" v="1" />
              <Row k="Cancelled" v="0" />
            </dl>
            <p className="mt-3 text-xs text-[#191919]/60">Settled through Credoc only, read from ERC-8004.</p>
          </MockCard>
        </div>
      </div>
      <p className="mt-8 text-xs text-[#191919]/60">Figures in these cards are illustrative, not quotes or real accounts.</p>
    </Section>
  );
}

/* 4. Why Arc */

const PRIMITIVES = [
  { name: "Native USDC and EURC", use: "Credits are funded in Circle's own stablecoins, in dollars or in euros." },
  { name: "USDC as gas", use: "Fees are paid in dollars, around 0.01 USDC per transaction. Nobody needs a volatile token." },
  { name: "Sub-second finality", use: "Deterministic finality means a settled tranche is final, not probably final, in under a second." },
  { name: "Memo", use: "The purchase-order reference is attached to the opening and indexed, so both sides can reconcile it." },
  { name: "Multicall3From", use: "The token approval and the opening are batched, so a credit opens in one transaction." },
  { name: "ERC-8004 registries", use: "Each outcome becomes portable reputation in the canonical registry, readable by anyone." },
];

const COMPARE: [string, string, string][] = [
  ["Document examination", "Up to 5 banking days (UCP 600 art. 14(b))", "Settles in the same transaction as the last document"],
  ["Access", "Bank relationship required", "Any wallet"],
  ["Ticket size", "Minimum tickets are common", "No minimum"],
  ["Payment route", "Through correspondent banks", "Direct, contract to exporter"],
];

export function Arc() {
  return (
    <Section
      id="arc"
      micro="Why Arc"
      heading="Built on Arc, for a reason"
      intro="Arc is Circle's layer 1, where USDC is the gas token and finality is deterministic. Credoc uses its primitives directly."
      tinted
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-gray-200 border border-gray-200">
        {PRIMITIVES.map((p) => (
          <div key={p.name} className="bg-white p-6 sm:p-8">
            <h3 className="font-medium text-[#191919]">{p.name}</h3>
            <p className={`mt-2 ${body}`}>{p.use}</p>
          </div>
        ))}
      </div>

      <div className="mt-16 sm:mt-20">
        <h3 className="font-serif text-2xl sm:text-3xl text-[#191919]">Bank letter of credit vs Credoc</h3>
        <p className="mt-3 text-sm text-[#191919]/70">
          The trade finance gap is about 2.5 trillion USD, and about 41% of SME applications are rejected (Asian
          Development Bank).
        </p>
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-sm border-t border-gray-300">
            <thead>
              <tr className="border-b border-gray-300">
                <th scope="col" className="py-3 pr-4 font-medium text-[#191919]/60 sr-only sm:not-sr-only">
                  Aspect
                </th>
                <th scope="col" className="py-3 pr-4 font-medium text-[#191919]">Bank letter of credit</th>
                <th scope="col" className="py-3 font-medium text-[#191919]">Credoc</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([k, bank, us]) => (
                <tr key={k} className="border-b border-gray-200 align-top">
                  <th scope="row" className="py-4 pr-4 font-normal text-[#191919]/60 hidden sm:table-cell">
                    {k}
                  </th>
                  <td className="py-4 pr-4 text-[#191919]/70">{bank}</td>
                  <td className="py-4 text-[#191919]">{us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

/* 5. FAQ */

const FAQS = [
  ["Who holds the funds?", "The smart contract, never Credoc. Funds can only move to the exporter against the required documents, to a financier who bought the proceeds, or back to the importer after expiry."],
  ["What if the exporter never ships?", "Nothing is paid. After the expiry date, every unshipped tranche goes back to the importer."],
  ["What if a document is late or has a discrepancy?", "Both sides can agree to extend the expiry (UCP 600 art. 10). If a document is discrepant, the importer can waive it (UCP 600 art. 16) and the tranche settles."],
  ["Do attestors need crypto?", "No. Attestors sign offchain (EIP-712) and anyone can relay the signature, so they need no wallet funds."],
  ["Are my documents public?", "No. Only their hash is recorded onchain. The files never leave your device, and anyone holding a file can check it against the hash."],
  ["Which currencies?", "USDC and EURC, both native on Arc and issued by Circle."],
  ["What is UCP 600 here?", "UCP 600 is the set of rules most bank letters of credit follow. Credoc mirrors the parts that matter in code: irrevocability (only the payee can cancel), expiry extensions that need both sides, waivers of discrepancies, and assignment of proceeds."],
  ["Is it audited?", "An independent review was done and all findings were fixed with regression tests. It is not a formal third-party audit."],
];

export function Faq() {
  return (
    <Section id="faq" micro="FAQ" heading="Questions, answered">
      <div className="max-w-3xl border-t border-gray-200">
        {FAQS.map(([q, a]) => (
          <details key={q} className="group border-b border-gray-200">
            <summary
              className={`flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[#191919] font-medium [&::-webkit-details-marker]:hidden ${focusRing}`}
            >
              {q}
              <ChevronDown
                className="w-4 h-4 shrink-0 text-gray-400 group-open:rotate-180 transition-transform duration-200"
                aria-hidden="true"
              />
            </summary>
            <p className={`pb-5 pr-8 ${body}`}>{a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* 6. CTA */

export function CtaBand() {
  const inkRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#191919]";
  return (
    <section aria-labelledby="cta-title" className="bg-[#191919] text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-20 sm:py-28 text-center">
        <h2 id="cta-title" className="font-serif font-normal text-3xl sm:text-5xl leading-tight tracking-tight">
          Your next shipment, settled in a second.
        </h2>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
          <a
            href="/app/"
            className={`px-6 sm:px-8 py-3 sm:py-3.5 bg-white text-[#191919] text-sm font-medium rounded-lg hover:bg-white/90 transition-colors duration-200 ${inkRing}`}
          >
            Launch app
          </a>
          {/* TODO: replace with the real Credoc repository URL. */}
          <a
            href="https://github.com/"
            className={`px-6 sm:px-8 py-3 sm:py-3.5 border border-white/30 text-white text-sm font-medium rounded-lg hover:bg-white/10 transition-colors duration-200 ${inkRing}`}
          >
            Read the code
          </a>
        </div>
      </div>
    </section>
  );
}

/* 7. Footer */

export function Footer() {
  return (
    <footer className="border-t border-gray-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 flex flex-col md:flex-row gap-8 md:items-start md:justify-between">
        <div>
          <a href="#top" className={`inline-flex items-center gap-2.5 rounded ${focusRing}`}>
            <LogoMark className="w-5 h-5 text-[#191919]" />
            <span className="font-semibold tracking-tight text-[#191919]">Credoc</span>
          </a>
          <p className="mt-3 text-sm text-[#191919]/70">Built on Arc. MIT licensed.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {[
              ["#product", "Product"],
              ["#how", "How it works"],
              ["#financing", "Financing"],
              ["#arc", "Why Arc"],
              ["#faq", "FAQ"],
              ["/app/", "Launch app"],
            ].map(([href, text]) => (
              <li key={href}>
                <a href={href} className={`text-[#191919]/70 hover:text-[#191919] transition-colors duration-200 rounded ${focusRing}`}>
                  {text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-10">
        <p className="pt-6 border-t border-gray-200 text-xs text-[#191919]/60">
          Credoc never holds funds. Smart contracts are provided as is.
        </p>
      </div>
    </footer>
  );
}
