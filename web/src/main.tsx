import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installSessionBoundary } from "./lib/session-boundary";
import App from "./App";
import EnvironmentNotice from "./components/EnvironmentNotice";
import "./styles/tokens.css";
import "./styles/workspace.css";

const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  let choice = "system";
  try { choice = localStorage.getItem("tap:theme") || "system"; } catch { /* OS fallback */ }
  document.documentElement.dataset.theme = choice === "system" ? (colorScheme.matches ? "dark" : "light") : choice;
}
applyTheme();
colorScheme.addEventListener("change", applyTheme);
window.addEventListener("themechange", event => {
  const choice = (event as CustomEvent<string>).detail;
  if (choice) document.documentElement.dataset.theme = choice === "system" ? (colorScheme.matches ? "dark" : "light") : choice;
  else applyTheme();
});

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

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <EnvironmentNotice outsideWorkspace />
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
