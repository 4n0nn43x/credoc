import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type Account,
  type Address,
  type Chain,
  type Transport,
  type WalletClient,
  createTestClient,
  createWalletClient,
  custom,
  http,
  numberToHex,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC } from "@credoc/sdk";
import { IS_LOCAL, chain } from "../../shared/config";
import { type PersonaId, PERSONAS, personaKey } from "../../shared/demo";
import { publicClient } from "./clients";

export type Wallet = WalletClient<Transport, Chain, Account>;

type State = {
  address: Address | null;
  wallet: Wallet | null;
  /** false until the previous session (demo persona or browser wallet) has been restored or ruled out */
  ready: boolean;
  kind: "injected" | "demo" | null;
  persona: PersonaId | null;
  wrongChain: boolean;
  hasInjected: boolean;
  balances: { usdc: bigint; eurc: bigint } | null;
  connect: () => Promise<void>;
  usePersona: (id: PersonaId) => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  refreshBalances: () => Promise<void>;
};

const Ctx = createContext<State | null>(null);
/** Remembers how the user signed in: "injected" or a demo persona id. Never a key or an address. */
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
  const [persona, setPersona] = useState<PersonaId | null>(null);
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

  const usePersona = useCallback(async (id: PersonaId) => {
    if (!IS_LOCAL) throw new Error("Demo personas exist only on the local fork");
    const account = privateKeyToAccount(personaKey(id));
    // attestors stay at zero balance on purpose: they only sign, the relayer pays
    const unfunded = id === "forwarder" || id === "inspector";
    if (!unfunded) {
      const bal = await publicClient.getBalance({ address: account.address });
      if (bal < parseUnits("1000", 18)) {
        const test = createTestClient({ chain, mode: "anvil", transport: http() });
        await test.setBalance({ address: account.address, value: parseUnits("25000", 18) }); // native USDC
      }
    }
    setWallet(createWalletClient({ account, chain, transport: http() }));
    setAddress(account.address);
    setKind("demo");
    setPersona(id);
    setChainId(chain.id);
    remember(id);
  }, []);

  const bindInjected = useCallback(async (addr: Address) => {
    const eth = window.ethereum!;
    setWallet(createWalletClient({ account: addr, chain, transport: custom(eth) }) as Wallet);
    setAddress(addr);
    setKind("injected");
    setPersona(null);
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
    setPersona(null);
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
            blockExplorerUrls: IS_LOCAL ? undefined : ["https://explorer.arc.io"],
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
      if (IS_LOCAL && saved && PERSONAS.some((p) => p.id === saved)) return usePersona(saved as PersonaId);
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
  }, [usePersona, bindInjected, disconnect]);

  const value = useMemo<State>(
    () => ({
      address,
      wallet,
      ready,
      kind,
      persona,
      wrongChain: kind === "injected" && chainId !== null && chainId !== chain.id,
      hasInjected,
      balances,
      connect,
      usePersona,
      disconnect,
      switchChain,
      refreshBalances,
    }),
    [address, wallet, ready, kind, persona, chainId, hasInjected, balances, connect, usePersona, disconnect, switchChain, refreshBalances],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
