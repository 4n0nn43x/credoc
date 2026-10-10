import { type Address, type Chain, isAddress } from "viem";
import { arc } from "viem/chains";

/** Arc mainnet (chainId 5042). VITE_RPC_URL only overrides the RPC endpoint (e.g. a private provider). */
const rpc = import.meta.env.VITE_RPC_URL || arc.rpcUrls.default.http[0];

export const chain: Chain = { ...arc, rpcUrls: { default: { http: [rpc] } } };

const configured = import.meta.env.VITE_CREDOC_ADDRESS ?? "";
export const CREDOC_ADDRESS: Address | null = isAddress(configured) ? configured : null;
export const FROM_BLOCK = BigInt(import.meta.env.VITE_CREDOC_FROM_BLOCK || "0");

export const EXPLORER = "https://explorer.arc.io";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
