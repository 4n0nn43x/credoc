import { type Address, type Chain, isAddress } from "viem";
import { arc } from "viem/chains";

/** "mainnet" talks to Arc (chainId 5042); "local" to an arc-anvil fork of it, same chainId, local RPC. */
export const NETWORK = (import.meta.env.VITE_NETWORK ?? "local") as "mainnet" | "local";
export const IS_LOCAL = NETWORK === "local";

const rpc = import.meta.env.VITE_RPC_URL || (IS_LOCAL ? "http://127.0.0.1:8545" : arc.rpcUrls.default.http[0]);

export const chain: Chain = {
  ...arc,
  name: IS_LOCAL ? "Arc (local fork)" : "Arc",
  rpcUrls: { default: { http: [rpc] } },
};

const configured = import.meta.env.VITE_CREDOC_ADDRESS ?? "";
export const CREDOC_ADDRESS: Address | null = isAddress(configured) ? configured : null;
export const FROM_BLOCK = BigInt(import.meta.env.VITE_CREDOC_FROM_BLOCK || "0");

export const EXPLORER = "https://explorer.arc.io";
/** Explorer links only make sense on mainnet: a local fork's transactions are not public. */
export const explorerTx = (hash: string) => (IS_LOCAL ? null : `${EXPLORER}/tx/${hash}`);
export const explorerAddress = (a: string) => (IS_LOCAL ? null : `${EXPLORER}/address/${a}`);
