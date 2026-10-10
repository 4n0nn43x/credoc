import { type Hex, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Demo personas for the LOCAL fork only. Keys are derived from public seeds so the seed script and the
 * browser agree without sharing secrets: never fund these on mainnet.
 */
export const PERSONAS = [
  { id: "importer", name: "Cotonou Foods", role: "Importer", city: "Cotonou, Benin" },
  { id: "exporter", name: "Mekong Cashew Co.", role: "Exporter", city: "Ho Chi Minh City, Vietnam" },
  { id: "financier", name: "Harbor Trade Capital", role: "Financier", city: "Lisbon, Portugal" },
  { id: "forwarder", name: "Bluewater Forwarding", role: "Freight forwarder", city: "Ho Chi Minh City, Vietnam" },
  { id: "inspector", name: "Delta Inspection", role: "Inspector", city: "Ho Chi Minh City, Vietnam" },
  { id: "exporter2", name: "Accra Cocoa Traders", role: "Exporter", city: "Accra, Ghana" },
  { id: "relayer", name: "Credoc relayer", role: "Relayer", city: "" },
] as const;

export type PersonaId = (typeof PERSONAS)[number]["id"];

export const personaKey = (id: PersonaId): Hex => keccak256(stringToHex(`credoc-demo:${id}`));
export const personaAddress = (id: PersonaId) => privateKeyToAccount(personaKey(id)).address;

/** Address book: demo names on the local fork, nothing on mainnet. */
export function demoName(address: string): string | null {
  const a = address.toLowerCase();
  for (const p of PERSONAS) if (personaAddress(p.id).toLowerCase() === a) return p.name;
  return null;
}
