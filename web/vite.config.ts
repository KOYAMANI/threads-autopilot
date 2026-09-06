import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    /**
     * PWA（SPEC §12.4）。Service Worker は**静的資産だけ**をキャッシュし、
     * API はキャッシュしない — 数字とキューは常に最新でないと、取り消したはずの投稿が
     * 残って見えるなどの誤解が起きる。
     *
     * `navigateFallbackDenylist` で `/api/*` と `/a/*`（メールからの承認/取消、SPEC §7.9）を
     * SW の SPA フォールバックから外す。`/a/*` は Worker が HTML を返す経路なので、
     * SW に横取りされるとログイン不要の導線が壊れる。
     */
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png", "icon.svg"],
      manifest: {
        name: "Threads オートパイロット",
        short_name: "オートパイロット",
        description: "Threads の投稿を、見る・作る・出す・学ぶまで1つの画面で回す",
        lang: "ja",
        start_url: "/app/home",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#F2F3F0",
        theme_color: "#F2F3F0",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 静的資産だけ。runtimeCaching は置かない（＝API は素通し）
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/a\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
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
    rollupOptions: {
      output: {
        /**
         * チャンク分け（SPEC §13 M7 / DECISIONS の M7 送り分）。
         *
         * recharts（＋依存の d3-*）はホームのグラフでしか使わないのに 300KB 近くある。
         * 1本のバンドルに混ぜると、ログイン画面を出すだけでグラフのコードまで
         * 落とすことになる。別チャンクにして、ホームに入ったときに初めて読ませる
         * （画面側は `React.lazy` で分けてある。`App.tsx`）。
         *
         * react / react-dom も分ける。アプリのコードだけ更新したとき、
         * ブラウザに残っている react のチャンクを使い回せるため。
         */
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-|internmap|decimal\.js)/.test(id)) {
            return "charts";
          }
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
});
