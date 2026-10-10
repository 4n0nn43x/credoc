import type { Plugin } from "vite";
import { relayPresentation } from "./_relay-core";

/** Serves POST /api/relay from the Vite dev server with the same code as the Vercel function. */
export function relayDevPlugin(env: Record<string, string>): Plugin {
  return {
    name: "credoc-relay-dev",
    configureServer(server) {
      server.middlewares.use("/api/relay", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        let raw = "";
        req.on("data", (c) => {
          raw += c;
          if (raw.length > 16_384) req.destroy();
        });
        req.on("end", async () => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            body = null;
          }
          const r = await relayPresentation(body, {
            rpcUrl: env.VITE_RPC_URL,
            contract: env.VITE_CREDOC_ADDRESS,
            relayerKey: env.RELAYER_KEY,
          });
          res.statusCode = r.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(r.body));
        });
      });
    },
  };
}
