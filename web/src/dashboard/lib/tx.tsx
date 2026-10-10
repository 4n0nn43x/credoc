import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import { Credoc } from "@credoc/sdk";
import { CREDOC_ADDRESS, explorerTx } from "../../shared/config";
import { humanError } from "../../shared/errors";
import { shortHex } from "../../shared/format";
import { publicClient } from "./clients";
import { useStore } from "./store";
import { useWallet } from "./wallet";

/**
 * One toast per user action, updated in place: confirm in wallet, sent (hash), confirmed in N s (measured
 * from submission to receipt, which on Arc is final), or failed with a human reason. Never shows success
 * before the receipt.
 */

type ToastState = "wallet" | "sent" | "confirmed" | "failed" | "info";
type Toast = { id: number; title: string; state: ToastState; hash?: Hex; seconds?: number; message?: string };

type TxApi = {
  /** Runs one business action (it may send several transactions). Resolves true on success. */
  run: (title: string, action: (credoc: Credoc) => Promise<unknown>) => Promise<boolean>;
  notify: (
    title: string,
    state: "confirmed" | "failed" | "info",
    message?: string,
    tx?: { hash: Hex; seconds?: number },
  ) => void;
  toasts: Toast[];
  dismiss: (id: number) => void;
};

const Ctx = createContext<TxApi | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const { wallet, wrongChain, refreshBalances } = useWallet();
  const { refresh } = useStore();

  const update = (id: number, patch: Partial<Toast>) =>
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = (t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    return id;
  };

  const notify = useCallback<TxApi["notify"]>((title, state, message, tx) => {
    const id = push({ title, state, message, hash: tx?.hash, seconds: tx?.seconds });
    if (state !== "failed") setTimeout(() => dismiss(id), 6000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismiss]);

  const run = useCallback<TxApi["run"]>(
    async (title, action) => {
      if (!CREDOC_ADDRESS) {
        notify(title, "failed", "No contract configured for this network.");
        return false;
      }
      if (!wallet) {
        notify(title, "failed", "Connect a wallet to sign.");
        return false;
      }
      if (wrongChain) {
        notify(title, "failed", "Your wallet is on another network. Switch to Arc first.");
        return false;
      }
      const id = push({ title, state: "wallet" });
      let sentAt = 0;
      const credoc = new Credoc(publicClient as never, CREDOC_ADDRESS, wallet as never, {
        onSubmitted: (hash) => {
          sentAt = performance.now();
          update(id, { state: "sent", hash });
        },
        onConfirmed: (hash) => {
          update(id, { hash, seconds: (performance.now() - sentAt) / 1000 });
        },
      });
      try {
        await action(credoc);
        update(id, { state: "confirmed" });
        setTimeout(() => dismiss(id), 6000);
        await Promise.all([refresh(), refreshBalances()]);
        return true;
      } catch (e) {
        update(id, { state: "failed", message: humanError(e) });
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, wrongChain, refresh, refreshBalances, notify, dismiss],
  );

  return (
    <Ctx.Provider value={{ run, notify, toasts, dismiss }}>
      {children}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function useTx(): TxApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTx outside TxProvider");
  return v;
}

const ICON: Record<ToastState, string> = {
  wallet: "ti ti-wallet",
  sent: "ti ti-loader-2 credoc-spin",
  confirmed: "ti ti-circle-check text-success",
  failed: "ti ti-alert-circle text-danger",
  info: "ti ti-info-circle",
};

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toast-container position-fixed bottom-0 end-0 p-3" style={{ zIndex: 1090 }} aria-live="polite">
      {toasts.map((t) => {
        const link = t.hash ? explorerTx(t.hash) : null;
        return (
          <div key={t.id} className="toast show credoc-toast" role="status">
            <div className="toast-body d-flex gap-2 align-items-start">
              <i className={`${ICON[t.state]} fs-18 mt-1`} aria-hidden="true" />
              <div className="flex-grow-1">
                <div className="fw-semibold text-dark">{t.title}</div>
                <div className="text-muted fs-13">
                  {t.state === "wallet" && "Confirm in your wallet…"}
                  {t.state === "sent" && "Sent. Waiting for the block…"}
                  {t.state === "confirmed" &&
                    (t.seconds !== undefined ? `Final in ${t.seconds.toFixed(2)} s` : (t.message ?? "Done"))}
                  {(t.state === "failed" || t.state === "info") && t.message}
                </div>
                {t.hash && (
                  <div className="fs-12 mt-1 font-monospace">
                    {link ? (
                      <a href={link} target="_blank" rel="noreferrer" className="link-dark">
                        {shortHex(t.hash)} <i className="ti ti-external-link" />
                      </a>
                    ) : (
                      <span className="text-muted">{shortHex(t.hash)}</span>
                    )}
                  </div>
                )}
              </div>
              <button type="button" className="btn-close btn-close-sm" aria-label="Dismiss" onClick={() => dismiss(t.id)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
