import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tap/shared": path.join(dir, "../shared/src/index.ts"),
    },
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    // 開発は vite（5173）+ wrangler dev（8787）。/api は Worker に投げる（SPEC §11）
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/a": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
