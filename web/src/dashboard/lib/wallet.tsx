import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type Account,
  type Address,
  type Chain,
  type Transport,
  type WalletClient,
  createWalletClient,
  custom,
  numberToHex,
} from "viem";
import { ARC } from "@credoc/sdk";
import { chain } from "../../shared/config";
import { publicClient } from "./clients";

export type Wallet = WalletClient<Transport, Chain, Account>;

type State = {
  address: Address | null;
  wallet: Wallet | null;
  /** false until the previous session has been restored or ruled out */
  ready: boolean;
  kind: "injected" | null;
  wrongChain: boolean;
  hasInjected: boolean;
  balances: { usdc: bigint; eurc: bigint } | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  refreshBalances: () => Promise<void>;
};

const Ctx = createContext<State | null>(null);
/** Remembers that the user signed in with a browser wallet. Never a key or an address. */
const SESSION_KEY = "credoc.session";
const remember = (v: string | null) => {
  try {
    if (v) localStorage.setItem(SESSION_KEY, v);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage blocked: the session is simply not remembered */
  }
};

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [kind, setKind] = useState<State["kind"]>(null);
  const kindRef = useRef<State["kind"]>(null); // read by long-lived wallet event listeners
  kindRef.current = kind;
  const [chainId, setChainId] = useState<number | null>(null);
  const [balances, setBalances] = useState<State["balances"]>(null);
  const [ready, setReady] = useState(false);
  const hasInjected = typeof window !== "undefined" && !!window.ethereum;

  const refreshBalances = useCallback(async () => {
    if (!address) return setBalances(null);
    const read = (token: Address) =>
      publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [address] });
    try {
      const [usdc, eurc] = await Promise.all([read(ARC.usdc), read(ARC.eurc)]);
      setBalances({ usdc, eurc });
    } catch {
      setBalances(null);
    }
  }, [address]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  const bindInjected = useCallback(async (addr: Address) => {
    const eth = window.ethereum!;
    setWallet(createWalletClient({ account: addr, chain, transport: custom(eth) }) as Wallet);
    setAddress(addr);
    setKind("injected");
    setChainId(Number(await eth.request({ method: "eth_chainId" })));
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or Rabby.");
    const [addr] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
    if (addr) {
      await bindInjected(addr);
      remember("injected");
    }
  }, [bindInjected]);

  const disconnect = useCallback(() => {
    setWallet(null);
    setAddress(null);
    setKind(null);
    remember(null);
  }, []);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const id = numberToHex(chain.id);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: id,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http as string[],
            blockExplorerUrls: ["https://explorer.arc.io"],
          },
        ],
      });
    }
    setChainId(chain.id);
  }, []);

  // restore the previous session without prompting, then follow injected account and network changes
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    const restore = async () => {
      if (saved === "injected" && window.ethereum) {
        // eth_accounts never opens a popup: it only returns accounts the user already authorized
        const [addr] = (await window.ethereum.request({ method: "eth_accounts" })) as Address[];
        if (addr) return bindInjected(addr);
        remember(null);
      }
    };
    void restore()
      .catch(() => remember(null))
      .finally(() => setReady(true));
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onAccounts = (accs: string[]) => {
      if (kindRef.current !== "injected") return;
      if (accs[0]) void bindInjected(accs[0] as Address);
      else disconnect();
    };
    const onChain = (id: string) => setChainId(Number(id));
    eth.on("accountsChanged", onAccounts as never);
    eth.on("chainChanged", onChain as never);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts as never);
      eth.removeListener?.("chainChanged", onChain as never);
    };
  }, [bindInjected, disconnect]);

  const value = useMemo<State>(
    () => ({
      address,
      wallet,
      ready,
      kind,
      wrongChain: kind === "injected" && chainId !== null && chainId !== chain.id,
      hasInjected,
      balances,
      connect,
      disconnect,
      switchChain,
      refreshBalances,
    }),
    [address, wallet, ready, kind, chainId, hasInjected, balances, connect, disconnect, switchChain, refreshBalances],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
