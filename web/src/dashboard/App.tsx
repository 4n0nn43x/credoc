import { HashRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { StoreProvider } from "./lib/store";
import { TxProvider } from "./lib/tx";
import { WalletProvider } from "./lib/wallet";
import { Overview } from "./pages/Overview";
import { Credits } from "./pages/Credits";
import { NewCredit } from "./pages/NewCredit";
import { CreditDetail } from "./pages/CreditDetail";
import { Attest } from "./pages/Attest";
import { Verify } from "./pages/Verify";
import { Market } from "./pages/Market";
import { Identity } from "./pages/Identity";
import { Activity } from "./pages/Activity";
import { Login } from "./pages/Login";
import { Plans } from "./pages/Plans";
import { Admin } from "./pages/Admin";
import { useWallet } from "./lib/wallet";
import { trackPageView } from "../shared/track";
import { useEffect } from "react";

/** One first-party page view per route (see shared/track.ts). */
function PageViews() {
  const { pathname } = useLocation();
  useEffect(trackPageView, [pathname]);
  return null;
}

/** Private pages need a connected wallet; the previous session is restored before deciding, so no flash of login. */
function RequireWallet() {
  const { address, ready } = useWallet();
  const { pathname, search } = useLocation();
  if (!ready) {
    return (
      <div className="d-flex justify-content-center py-5 text-muted" aria-busy="true">
        <i className="ti ti-loader-2 credoc-spin fs-24" />
      </div>
    );
  }
  if (!address) return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <Outlet />;
}

/**
 * Hash routing: the dashboard is a static page under /app/, no server rewrites needed.
 * Public on purpose: a credit's tracking page and the document verifier are meant to be shared with people who
 * have no wallet (a customs broker, a bank, a buyer's accountant).
 */
export function App() {
  return (
    <WalletProvider>
      <StoreProvider>
        <TxProvider>
          <HashRouter>
            <PageViews />
            <Routes>
              <Route path="login" element={<Login />} />
              <Route element={<Layout />}>
                <Route path="track/:id" element={<CreditDetail />} />
                <Route path="verify" element={<Verify />} />
                <Route element={<RequireWallet />}>
                  <Route index element={<Overview />} />
                  <Route path="credits" element={<Credits />} />
                  <Route path="credits/new" element={<NewCredit />} />
                  <Route path="credits/:id" element={<CreditDetail />} />
                  <Route path="attest" element={<Attest />} />
                  <Route path="market" element={<Market />} />
                  <Route path="identity" element={<Identity />} />
                  <Route path="activity" element={<Activity />} />
                  <Route path="plans" element={<Plans />} />
                  <Route path="admin" element={<Admin />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Route>
            </Routes>
          </HashRouter>
        </TxProvider>
      </StoreProvider>
    </WalletProvider>
  );
}
