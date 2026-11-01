import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installSessionBoundary } from "./lib/session-boundary";
import App from "./App";
import { registerSW } from "virtual:pwa-register";
import { clearCreateSession } from "./lib/create-session";
import "./styles/tokens.css";
import "./styles/workspace.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

installSessionBoundary(() => {
  queryClient.clear();
  clearCreateSession();
});

/**
 * PWA の更新（SPEC §12.4）。新しい版の Service Worker が入れ替わったら、そのページを読み込み直す。
 * これが無いと、デプロイ直後の1回目はキャッシュの古い画面が開き、古い画面が無くなった部品を
 * 探して白紙になっていた（2026-10-20、ステージング）。
 */
registerSW({
  immediate: true,
  // 開いたままのタブ・ホーム画面のアプリは、自分では新しい版を見に行かない。
  // 画面に戻ってきたときと 10 分ごとに確かめ、新しい版があれば入れ替えて読み込み直す（2026-11-02）
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => { if (navigator.onLine) void registration.update().catch(() => undefined); };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
    window.setInterval(check, 10 * 60_000);
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
