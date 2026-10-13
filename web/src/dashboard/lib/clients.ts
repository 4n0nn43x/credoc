import { createPublicClient, http } from "viem";
import { Credoc, documentaryCreditAbi } from "@credoc/sdk";
import { CREDOC_ADDRESS, chain } from "../../shared/config";

// Reads go through the site's own /api/rpc in production: browser shields and extensions block cross-site calls to
// the public Arc RPC. The wallet keeps the public URL (wallet.tsx) to add the network. Dev talks to the RPC directly.
const readRpc = import.meta.env.PROD && !import.meta.env.VITE_RPC_URL ? `${location.origin}/api/rpc` : undefined;
// Arc finalizes in under a second: poll every 500 ms (viem's default of 4 s would hide that finality from the user)
export const publicClient = createPublicClient({ chain, transport: http(readRpc, { batch: true }), pollingInterval: 500 });

/** Read-only client; writes go through useTx(), which builds one bound to the connected wallet. */
export const reader = CREDOC_ADDRESS ? new Credoc(publicClient as never, CREDOC_ADDRESS) : null;

/** Credoc's settlement fee and the reduced one for plan holders, in basis points. */
export async function readFees(): Promise<{ feeBps: number; proFeeBps: number } | null> {
  if (!CREDOC_ADDRESS) return null;
  const rd = (functionName: "feeBps" | "proFeeBps") =>
    publicClient.readContract({ address: CREDOC_ADDRESS!, abi: documentaryCreditAbi, functionName }) as Promise<number>;
  const [feeBps, proFeeBps] = await Promise.all([rd("feeBps"), rd("proFeeBps")]);
  return { feeBps: Number(feeBps), proFeeBps: Number(proFeeBps) };
}
