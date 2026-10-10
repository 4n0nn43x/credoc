import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Addr, Amount, Card, Empty, PageTitle, Skeleton, StatusBadge, When } from "../components/ui";
import { CreditStyles, who } from "../components/credit-kit";
import { sameAddress } from "../../shared/format";
import { type Role, paidAmount, presentedCount, requiredCount, rolesOf, status } from "../lib/model";
import { type CreditRow, useStore } from "../lib/store";
import { useWallet } from "../lib/wallet";

const TABS: { key: string; label: string; role?: Role | "financing" }[] = [
  { key: "all", label: "All" },
  { key: "importing", label: "Importing", role: "importer" },
  { key: "exporting", label: "Exporting", role: "exporter" },
  { key: "financing", label: "Financing", role: "financing" },
  { key: "attesting", label: "Attesting", role: "attestor" },
];

export function Credits() {
  const { status: loadStatus, credits, offers, now } = useStore();
  const { address: me } = useWallet();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = params.get("tab") ?? "all";
  const q = params.get("q") ?? "";
  const t = now();

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const roles = useMemo(() => new Map(credits.map((c) => [c.id, rolesOf(c, me, offers)])), [credits, me, offers]);
  const inTab = (c: CreditRow, key: string) => {
    const def = TABS.find((x) => x.key === key)!;
    if (!def.role) return true;
    const r = roles.get(c.id)!;
    // financing: I bought the proceeds (payee but not the exporter) or I made an offer
    if (def.role === "financing") return r.has("financier") || (r.has("payee") && !r.has("exporter"));
    return r.has(def.role);
  };

  const needle = q.trim().toLowerCase();
  const match = (c: CreditRow) =>
    !needle ||
    c.ref.toLowerCase().includes(needle) ||
    `#${c.id}` === needle ||
    c.id.toString() === needle ||
    [c.applicant, c.beneficiary, c.payee].some((a) => a.toLowerCase().includes(needle) || who(a).toLowerCase().includes(needle));
  const rows = credits.filter((c) => inTab(c, tab) && match(c));

  const counterparty = (c: CreditRow) => (sameAddress(c.applicant, me) ? c.beneficiary : c.applicant);

  return (
    <>
      <CreditStyles />
      <PageTitle
        title="Credits"
        subtitle="Every letter of credit on this contract, with your role on each."
        actions={
          <Link to="/credits/new" className="btn btn-dark">
            <i className="ti ti-plus me-1" /> Open a credit
          </Link>
        }
      />
      <Card bodyClass="p-0">
        <div className="d-flex flex-column flex-md-row gap-2 align-items-md-center justify-content-between px-3 pt-3">
          <ul className="nav nav-tabs nav-bordered border-0 flex-nowrap" style={{ overflowX: "auto", overflowY: "hidden" }} role="tablist">
            {TABS.map((x) => {
              const n = credits.filter((c) => inTab(c, x.key)).length;
              if (x.role && !me) return null;
              return (
                <li key={x.key} className="nav-item">
                  <button
                    type="button"
                    className={`nav-link ${tab === x.key ? "active" : ""}`}
                    onClick={() => set("tab", x.key === "all" ? "" : x.key)}
                    role="tab"
                    aria-selected={tab === x.key}
                  >
                    {x.label} <span className="text-muted num ms-1">{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="position-relative" style={{ minWidth: 240 }}>
            <i className="ti ti-search position-absolute text-muted" style={{ left: 10, top: 9 }} />
            <input
              className="form-control form-control-sm ps-4"
              placeholder="Search PO, id, party"
              value={q}
              onChange={(e) => set("q", e.target.value)}
              aria-label="Search credits"
            />
          </div>
        </div>
        <div className="border-top border-dashed mt-2" />
        {loadStatus === "loading" ? (
          <div className="p-3">
            <Skeleton lines={6} />
          </div>
        ) : credits.length === 0 ? (
          <Empty
            icon="ti-file-certificate"
            title="No credits yet"
            action={
              <Link to="/credits/new" className="btn btn-outline-dark">
                Open your first credit
              </Link>
            }
          >
            A letter of credit locks the importer's money in the contract and releases it to the exporter, shipment by
            shipment, the moment independent attestors confirm the shipping documents.
          </Empty>
        ) : rows.length === 0 ? (
          <Empty icon="ti-search" title="No credit matches" action={<button className="btn btn-light btn-sm" onClick={() => setParams({}, { replace: true })}>Clear filters</button>}>
            {q ? `Nothing matches "${q}" in this tab.` : "You have no credit in this role yet."}
          </Empty>
        ) : (
          <div className="table-responsive">
            <table className="table table-hover table-centered table-nowrap mb-0">
              <thead className="bg-light bg-opacity-50">
                <tr className="fs-12 text-muted text-uppercase">
                  <th className="ps-3">Credit</th>
                  <th>Counterparty</th>
                  <th>Amount</th>
                  <th>Documents</th>
                  <th>Expiry</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const paid = paidAmount(c);
                  const pct = c.total ? Number((paid * 1000n) / c.total) / 10 : 0;
                  const go = () => navigate(`/credits/${c.id}`);
                  return (
                    <tr key={c.id.toString()} role="link" tabIndex={0} style={{ cursor: "pointer" }} onClick={go} onKeyDown={(e) => e.key === "Enter" && go()}>
                      <td className="ps-3">
                        <div className="fw-medium text-dark">{c.ref || "No reference"}</div>
                        <div className="fs-12 text-muted num">#{c.id.toString()}</div>
                      </td>
                      <td>
                        <Addr address={counterparty(c)} me={me} plain />
                      </td>
                      <td>
                        <Amount value={c.total} token={c.token} />
                        <div className="credit-progress mt-1" title={`${pct}% paid`}>
                          <span style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td className="num">
                        {presentedCount(c)}/{requiredCount(c)} <span className="text-muted fs-12">documents in</span>
                      </td>
                      <td>
                        <When ts={c.expiry} now={t} />
                      </td>
                      <td>
                        <StatusBadge s={status(c, t)} />
                      </td>
                      <td className="text-end pe-3">
                        <Link to={`/credits/${c.id}`} className="text-muted" aria-label={`Open credit ${c.id}`} onClick={(e) => e.stopPropagation()}>
                          <i className="ti ti-chevron-right fs-18" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
