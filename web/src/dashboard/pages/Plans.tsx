import { useEffect, useState } from "react";
import { type Address, isAddress } from "viem";
import { ARC, type PlanName, type PlanStatus } from "@credoc/sdk";
import { amount, dateShort, pct, sameAddress } from "../../shared/format";
import { Amount, Card, Empty, PageTitle, Skeleton } from "../components/ui";
import { FeeNote, SignButton } from "../components/form-kit";
import { reader, readFees } from "../lib/clients";
import { useTx } from "../lib/tx";
import { useWallet } from "../lib/wallet";

const PLANS: { name: PlanName; title: string; icon: string; who: string; includes: (pro: string) => string[] }[] = [
  {
    name: "attestor",
    title: "Attestor",
    icon: "ti-signature",
    who: "Forwarders and inspectors",
    includes: () => [
      "Unlimited gasless presentations through the relayer (5 free per 30 days without a plan)",
      "Your importer can pay it for you",
    ],
  },
  {
    name: "importer",
    title: "Importer",
    icon: "ti-file-certificate",
    who: "Buyers who open credits",
    includes: (pro) => [
      `${pro} settlement fee on credits opened while the plan is active`,
      "Gasless presentations for every attestor of your credits",
      "Refunds stay free",
    ],
  },
  {
    name: "financier",
    title: "Financier",
    icon: "ti-building-bank",
    who: "Buyers of receivables",
    includes: (pro) => [
      `${pro} fee on proceeds you collect while the plan is active`,
      "Applies to every receivable you bought, old or new",
      "Resales stay free",
    ],
  },
];

type Loaded = { status: PlanStatus | null; fees: { feeBps: number; proFeeBps: number } | null };

/** Prepaid plans (CredocPass): 30-day periods in USDC, twelve for the price of ten. Pay as you go needs none. */
export function Plans() {
  const { address } = useWallet();
  const { run } = useTx();
  const [data, setData] = useState<Loaded | "error" | null>(null);
  const [version, setVersion] = useState(0);
  const [sponsor, setSponsor] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!reader || !address) return;
    let live = true;
    Promise.all([reader.plans(address), readFees()])
      .then(([status, fees]) => live && setData({ status, fees }))
      .catch(() => live && setData("error"));
    return () => {
      live = false;
    };
  }, [address, version]);

  const sponsored = isAddress(sponsor) && !sameAddress(sponsor, address) ? (sponsor as Address) : null;
  const buy = async (plan: PlanName, periods: number, account?: Address) => {
    const key = `${plan}-${periods}-${account ?? ""}`;
    setBusy(key);
    const label = `${PLANS.find((p) => p.name === plan)!.title} plan, ${periods * 30} days${account ? " (sponsored)" : ""}`;
    const ok = await run(label, (c) => c.buyPlan(plan, periods, account));
    setBusy(null);
    if (ok) setVersion((v) => v + 1);
  };

  const title = (
    <PageTitle
      title="Plans"
      subtitle="Pay as you go needs no plan. A plan is prepaid in USDC by periods of 30 days, and a year of 12 periods costs 10."
    />
  );
  if (!reader || data === null || data === "error" || data.status === null) {
    return (
      <>
        {title}
        <Card>
          {reader && data === null ? (
            <Skeleton />
          ) : data === "error" ? (
            <Empty icon="ti-alert-circle" title="Cannot read the plans">The network did not answer. Try again in a moment.</Empty>
          ) : (
            <Empty icon="ti-crown" title="Plans are not enabled on this deployment yet.">
              Every credit settles pay as you go in the meantime: {data && data.fees ? pct(data.fees.feeBps) : "a small fee"} of each paid shipment, refunds free.
            </Empty>
          )}
        </Card>
      </>
    );
  }

  const { status, fees } = data;
  const pro = fees ? pct(fees.proFeeBps) : "Reduced";
  return (
    <>
      {title}
      <div className="row g-3 mb-3">
        {PLANS.map((p) => {
          const s = status[p.name];
          const onSale = s.price > 0n;
          return (
            <div key={p.name} className="col-lg-4">
              <div className="card h-100 mb-0">
                <div className="card-body d-flex flex-column">
                  <div className="d-flex justify-content-between align-items-start gap-2 mb-2">
                    <div>
                      <div className="micro-label">{p.who}</div>
                      <h4 className="font-serif fs-24 text-dark mt-1 mb-0">{p.title}</h4>
                    </div>
                    <i className={`ti ${p.icon} fs-24 text-muted`} aria-hidden="true" />
                  </div>
                  <div className="mb-3">
                    {onSale ? (
                      <>
                        <Amount value={s.price} token={ARC.usdc} serif className="fs-24 text-dark" />
                        <span className="text-muted fs-13"> / 30 days</span>
                      </>
                    ) : (
                      <span className="text-muted">Not on sale yet</span>
                    )}
                  </div>
                  <ul className="list-unstyled fs-13 text-muted d-grid gap-2 mb-3">
                    {p.includes(pro).map((x) => (
                      <li key={x} className="d-flex gap-2">
                        <i className="ti ti-check text-dark mt-1" aria-hidden="true" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto">
                    <div className="fs-13 mb-2">
                      {s.active ? (
                        <span className="badge-soft tone-success">
                          <i className="ti ti-circle-check" aria-hidden="true" /> Active until {dateShort(s.until)}
                        </span>
                      ) : (
                        <span className="badge-soft tone-secondary">
                          <i className="ti ti-circle-dashed" aria-hidden="true" /> Not active
                          {s.until > 0n && <>, ended {dateShort(s.until)}</>}
                        </span>
                      )}
                    </div>
                    <div className="d-grid gap-2">
                      <SignButton className="btn btn-dark" onClick={() => void buy(p.name, 1)} busy={busy === `${p.name}-1-`} disabled={!onSale || !!busy}>
                        {s.active ? "Extend" : "Buy"} 30 days
                      </SignButton>
                      <SignButton className="btn btn-outline-dark" onClick={() => void buy(p.name, 12)} busy={busy === `${p.name}-12-`} disabled={!onSale || !!busy}>
                        {onSale ? `360 days for ${amount(s.price * 10n)} USDC` : "360 days"}
                      </SignButton>
                    </div>
                    {p.name === "attestor" && onSale && (
                      <div className="mt-3 pt-3 border-top border-dashed">
                        <label className="form-label fs-13" htmlFor="plan-sponsor">Sponsor an attestor</label>
                        <div className="d-grid gap-2">
                          <input
                            id="plan-sponsor"
                            className="form-control form-control-sm font-monospace"
                            placeholder="Forwarder address, 0x…"
                            value={sponsor}
                            onChange={(e) => setSponsor(e.target.value.trim())}
                          />
                          <SignButton
                            className="btn btn-sm btn-outline-dark"
                            onClick={() => void buy("attestor", 1, sponsored!)}
                            busy={busy === `attestor-1-${sponsored}`}
                            disabled={!sponsored || !!busy}
                          >
                            Pay 30 days for this address
                          </SignButton>
                        </div>
                        <div className="form-text">You pay, the plan goes to that address. Importers do this for their forwarder.</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="row g-3">
        <div className="col-lg-6">
          <Card title="Pay as you go">
            <p className="fs-13 text-muted mb-2">
              Without a plan, Credoc keeps {fees ? pct(fees.feeBps) : "a small fee"} of each shipment paid to the exporter. Refunds are free and there is no minimum.
              A plan holder pays {pro.toLowerCase()} instead, as described above.
            </p>
            <FeeNote />
          </Card>
        </div>
        <div className="col-lg-6">
          <Card title="Verified attestor">
            <div className="d-flex gap-3 align-items-start">
              <i className={`ti ${status.verified ? "ti-rosette-discount-check text-success" : "ti-rosette"} fs-24`} aria-hidden="true" />
              <p className="fs-13 text-muted mb-0">
                {status.verified ? (
                  <>
                    <span className="text-dark fw-semibold">This address is verified.</span> The badge is public: anyone can check it onchain before naming you as attestor.
                  </>
                ) : (
                  <>
                    <span className="text-dark fw-semibold">Not verified.</span> The badge is granted after a business verification (KYB) of the company behind the address. It is never sold with a plan.
                  </>
                )}
              </p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
