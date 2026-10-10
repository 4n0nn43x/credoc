import { useState } from "react";
import { Card, Empty, PageTitle, Skeleton } from "../components/ui";
import { CreditStyles, EventLine, type EventCategory, describe } from "../components/credit-kit";
import { dateShort } from "../../shared/format";
import { useStore } from "../lib/store";
import { useWallet } from "../lib/wallet";

const FILTERS: { key: EventCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "opened", label: "Opened" },
  { key: "documents", label: "Documents" },
  { key: "payments", label: "Payments" },
  { key: "financing", label: "Financing" },
  { key: "closures", label: "Closures" },
];

export function Activity() {
  const { status, events, byId, offers, now } = useStore();
  const { address } = useWallet();
  const [filter, setFilter] = useState<EventCategory | "all">("all");
  const t = now();

  const all = events.flatMap((e) => {
    const d = describe(e, byId, offers, address);
    return d ? [{ e, d }] : [];
  });
  const shown = all.filter((x) => filter === "all" || x.d.category === filter);
  const days = new Map<string, typeof shown>();
  for (const x of shown) {
    const k = dateShort(x.e.time);
    days.set(k, [...(days.get(k) ?? []), x]);
  }

  return (
    <>
      <CreditStyles />
      <PageTitle title="Activity" subtitle="Everything that happened on the contract, newest first. Each line links to its transaction." />
      <ul className="nav nav-pills gap-1 mb-3 flex-nowrap" style={{ overflowX: "auto", overflowY: "hidden" }}>
        {FILTERS.map((f) => (
          <li key={f.key} className="nav-item">
            <button type="button" className={`nav-link py-1 px-3 ${filter === f.key ? "active bg-dark" : "text-dark"}`} onClick={() => setFilter(f.key)}>
              {f.label}{" "}
              <span className="num opacity-75 ms-1">{f.key === "all" ? all.length : all.filter((x) => x.d.category === f.key).length}</span>
            </button>
          </li>
        ))}
      </ul>
      {status === "loading" ? (
        <Card>
          <Skeleton lines={8} />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <Empty icon="ti-activity" title={all.length ? "Nothing of this type" : "No activity yet"}>
            {all.length
              ? "Try another filter."
              : "When a credit is opened, documents are attested or payments released, each step appears here with its transaction."}
          </Empty>
        </Card>
      ) : (
        [...days.entries()].map(([day, items]) => (
          <Card key={day} title={<span className="micro-label">{day}</span>} bodyClass="py-0">
            <ul className="list-group list-group-flush">
              {items.map(({ e, d }) => (
                <EventLine key={`${e.tx}-${e.logIndex}`} e={e} d={d} now={t} />
              ))}
            </ul>
          </Card>
        ))
      )}
    </>
  );
}
