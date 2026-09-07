/**
 * ルーティング（SPEC §12.1）。
 * 未認証で `/app/*` → `/login`。アカウント0件で `/app/*` → `/connect`。
 * 選択中アカウントは `localStorage.activeAccountId`（components/Shell.tsx）。
 */
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Suspense, lazy } from "react";
import type { ReactElement } from "react";
import Shell from "./components/Shell";
import { ToastProvider } from "./components/Toast";
import Login from "./screens/Login";
import { useMe } from "./api/auth";

/**
 * ログイン後の画面は遅延読み込みにする（M7）。ログイン画面を出すだけで
 * ホームのグラフ（recharts、gzip で 100KB 近い）まで落とすのを避けるため。
 * チャンクの束ね方は `vite.config.ts` の `manualChunks`。
 */
const Connect = lazy(() => import("./screens/Connect"));
const Home = lazy(() => import("./screens/Home"));
const Create = lazy(() => import("./screens/Create"));
const Queue = lazy(() => import("./screens/Queue"));
const Autopilot = lazy(() => import("./screens/Autopilot"));
const Settings = lazy(() => import("./screens/Settings"));

function Loading() {
  return (
    <main className="screen-plain">
      <p className="muted">読み込んでいます…</p>
    </main>
  );
}

/** 未認証は /login、アカウント0件は /connect（SPEC §12.1）。 */
function RequireAuth({ children }: { children: ReactElement }) {
  const { data, isPending, isError } = useMe();
  const location = useLocation();

  if (isPending) return <Loading />;
  if (isError || !data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (data.accounts.length === 0 && !["/app/home", "/app/settings"].includes(location.pathname)) return <Navigate to="/connect" replace />;
  return children;
}

/** /connect も認証は要る（アカウント0件でも通す）。 */
function RequireLogin({ children }: { children: ReactElement }) {
  const { data, isPending, isError } = useMe();
  const location = useLocation();

  if (isPending) return <Loading />;
  if (isError || !data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<Loading />}>
        <Routes>
        <Route path="/login" element={<Login />} />
        {/* メールのリンクは /login?reset=<token>。/reset でも同じ画面を出す */}
        <Route path="/reset" element={<Login />} />

        <Route
          path="/connect"
          element={
            <RequireLogin>
              <Connect />
            </RequireLogin>
          }
        />

        <Route
          path="/app"
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/app/home" replace />} />
          <Route path="home" element={<Home />} />
          <Route path="create" element={<Create />} />
          <Route path="queue" element={<Queue />} />
          <Route path="autopilot" element={<Autopilot />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/app/home" replace />} />
        </Route>

          <Route path="*" element={<Navigate to="/app/home" replace />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
