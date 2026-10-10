/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_CREDOC_ADDRESS?: string;
  readonly VITE_CREDOC_FROM_BLOCK?: string;
}

interface Window {
  ethereum?: import("viem").EIP1193Provider;
}
