import { useEffect, useState } from "react";
import { type Address, isAddress } from "viem";

/** White label: who this domain belongs to, served by the Node server from partners.json (see server/index.ts). */
export type Brand = { name: string; partner: Address | null; integratorFeeBps: number };
export const DEFAULT_BRAND: Brand = { name: "Credoc", partner: null, integratorFeeBps: 0 };

/** Fetched once per page load. Any failure (Vite dev has no such route) means plain Credoc. */
let pending: Promise<Brand> | null = null;
function loadBrand(): Promise<Brand> {
  pending ??= fetch("/brand.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((b: Partial<Brand> | null) => {
      const fee = b?.integratorFeeBps ?? 0;
      const partner = typeof b?.partner === "string" && isAddress(b.partner) ? b.partner : null;
      // same rules as the contract: a fee needs a partner, never above 0.5%
      if (!b || typeof b.name !== "string" || !b.name || !Number.isInteger(fee) || fee < 0 || fee > 50 || (fee > 0 && !partner))
        return DEFAULT_BRAND;
      return { name: b.name, partner, integratorFeeBps: fee };
    })
    .catch(() => DEFAULT_BRAND);
  return pending;
}

export function useBrand(): Brand {
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  useEffect(() => {
    let live = true;
    void loadBrand().then((b) => live && setBrand(b));
    return () => {
      live = false;
    };
  }, []);
  return brand;
}
