import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LogoMark } from "../../shared/Logo";
import { IS_LOCAL, chain } from "../../shared/config";
import { PERSONAS, type PersonaId } from "../../shared/demo";
import { humanError } from "../../shared/errors";
import { useWallet } from "../lib/wallet";

/** Only internal dashboard paths are accepted as a redirect target. */
const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") && next !== "/login" ? next : "/");

/**
 * Sign in = connect the wallet you trade with. There is no account and no password: the address is the identity,
 * and every action is signed by the wallet itself, so nothing else needs to be trusted.
 */
export function Login() {
  const w = useWallet();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (w.address) navigate(next, { replace: true });
  }, [w.address, next, navigate]);

  const attempt = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="auth-bg d-flex min-vh-100 justify-content-center align-items-center credoc-login">
      <div className="row g-0 justify-content-center w-100 m-3">
        <div className="col-xl-4 col-lg-5 col-md-7">
          <div className="card overflow-hidden h-100 p-xxl-4 p-3 mb-0">
            <a href="/" className="d-flex align-items-center gap-2 text-decoration-none mb-4 mx-auto">
              <LogoMark className="credoc-mark" />
              <span className="credoc-wordmark">Credoc</span>
            </a>

            <h1 className="font-serif text-center text-dark mb-2" style={{ fontSize: "2rem" }}>
              Sign in to Credoc
            </h1>
            <p className="text-muted text-center mb-4">
              Connect the wallet you trade with. No account, no password: your wallet signs every action, and Credoc
              never holds your funds or your keys.
            </p>

            {error && (
              <div className="alert alert-danger py-2 fs-13" role="alert">
                {error}
              </div>
            )}

            <div className="d-grid gap-2">
              {w.hasInjected ? (
                <button className="btn btn-dark py-2" disabled={busy !== null} onClick={() => attempt("injected", w.connect)}>
                  {busy === "injected" ? (
                    <>
                      <i className="ti ti-loader-2 credoc-spin me-1" /> Confirm in your wallet…
                    </>
                  ) : (
                    <>
                      <i className="ti ti-wallet me-1" /> Connect browser wallet
                    </>
                  )}
                </button>
              ) : (
                <a className="btn btn-outline-dark py-2" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                  <i className="ti ti-download me-1" /> Install a browser wallet (MetaMask, Rabby)
                </a>
              )}
              <p className="fs-12 text-muted text-center mb-0">
                Network: {chain.name}. Fees are paid in USDC, a few thousandths of a dollar per action.
              </p>
            </div>

            {IS_LOCAL && (
              <>
                <div className="d-flex align-items-center gap-2 my-4">
                  <hr className="flex-grow-1 my-0" />
                  <span className="micro-label">or try a demo wallet</span>
                  <hr className="flex-grow-1 my-0" />
                </div>
                <div className="list-group">
                  {PERSONAS.filter((p) => p.id !== "relayer").map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
                      disabled={busy !== null}
                      onClick={() => attempt(p.id, () => w.usePersona(p.id as PersonaId))}
                    >
                      <span>
                        <span className="d-block fw-medium text-dark">{p.name}</span>
                        <span className="d-block fs-12 text-muted">
                          {p.role}
                          {p.city && ` · ${p.city}`}
                        </span>
                      </span>
                      {busy === p.id ? <i className="ti ti-loader-2 credoc-spin" /> : <i className="ti ti-arrow-right text-muted" />}
                    </button>
                  ))}
                </div>
                <p className="fs-12 text-muted mt-2 mb-0">Demo wallets exist only on this local fork of Arc mainnet.</p>
              </>
            )}

            <div className="d-flex justify-content-between flex-wrap gap-2 mt-4 pt-3 border-top border-dashed fs-13">
              <a href="/" className="link-secondary">
                <i className="ti ti-arrow-left me-1" />
                Back to home
              </a>
              <span className="d-flex gap-3">
                <Link to="/verify" className="link-secondary">Verify a document</Link>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
