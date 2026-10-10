import { HashRouter, Route, Routes } from "react-router-dom";
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

/** Hash routing: the dashboard is a static page under /app/, no server rewrites needed. */
export function App() {
  return (
    <WalletProvider>
      <StoreProvider>
        <TxProvider>
          <HashRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Overview />} />
                <Route path="credits" element={<Credits />} />
                <Route path="credits/new" element={<NewCredit />} />
                <Route path="credits/:id" element={<CreditDetail />} />
                <Route path="track/:id" element={<CreditDetail />} />
                <Route path="attest" element={<Attest />} />
                <Route path="verify" element={<Verify />} />
                <Route path="market" element={<Market />} />
                <Route path="identity" element={<Identity />} />
                <Route path="activity" element={<Activity />} />
                <Route path="*" element={<Overview />} />
              </Route>
            </Routes>
          </HashRouter>
        </TxProvider>
      </StoreProvider>
    </WalletProvider>
  );
}
