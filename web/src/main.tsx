import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installSessionBoundary } from "./lib/session-boundary";
import App from "./App";
import EnvironmentNotice from "./components/EnvironmentNotice";
import { registerSW } from "virtual:pwa-register";
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

installSessionBoundary(() => queryClient.clear());

/**
 * PWA の更新（SPEC §12.4）。新しい版の Service Worker が入れ替わったら、そのページを読み込み直す。
 * これが無いと、デプロイ直後の1回目はキャッシュの古い画面が開き、古い画面が無くなった部品を
 * 探して白紙になっていた（2026-10-20、ステージング）。
 */
registerSW({ immediate: true });

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <EnvironmentNotice />
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
