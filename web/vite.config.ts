import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { relayDevPlugin } from "./api/_dev-plugin";

// Two entries on purpose: the landing uses Tailwind (with its preflight), the dashboard uses the
// Osen/Bootstrap stylesheet. Loading both on one page would make their resets fight.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), relayDevPlugin(env)],
    resolve: { dedupe: ["viem", "react", "react-dom"] },
    build: {
      rollupOptions: {
        input: {
          landing: resolve(__dirname, "index.html"),
          app: resolve(__dirname, "app/index.html"),
        },
      },
    },
  };
});
