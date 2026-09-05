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
    //
    // `/a` を素の文字列で書くと **前方一致** になり、SPA 側の `/app/*`（SPEC §12.1）まで
    // Worker に流れてしまう。Worker は `/app/home` を ASSETS に渡すので、開発中なのに
    // ビルド済みの `web/dist` が返り、vite の更新が画面に出なくなる。
    // `^` 始まりのキーは正規表現として扱われるので、`/a/` だけを厳密に拾う（SPEC §7.9）。
    proxy: {
      "^/api(/|$)": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "^/a/": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
