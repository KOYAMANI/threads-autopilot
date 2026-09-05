/**
 * ルーティング（SPEC §12.1）。M1 は /login と /reset、/app/* は認証ガードのみ。
 * 各画面（Home / Create / Queue / Autopilot / Settings）と /connect は M3 以降。
 */
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import Login from "./screens/Login";
import { useMe, useLogout } from "./api/auth";

function Loading() {
  return (
    <main style={{ padding: "calc(var(--sp) * 6) calc(var(--sp) * 2)" }}>
      <p className="muted">読み込んでいます…</p>
    </main>
  );
}

/** 未認証は /login へ。アカウント0件のときの /connect 送りは M3 で足す。 */
function RequireAuth({ children }: { children: ReactElement }) {
  const { data, isPending, isError } = useMe();
  const location = useLocation();
  if (isPending) return <Loading />;
  if (isError || !data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

/** M3 で本実装する画面のプレースホルダ。 */
function AppPlaceholder() {
  const { data } = useMe();
  const logout = useLogout();
  return (
    <main style={{ padding: "calc(var(--sp) * 4) calc(var(--sp) * 2)" }}>
      <h1 style={{ fontSize: 22 }}>ログインできています</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        {data?.user.email}
      </p>
      <div className="card" style={{ marginTop: "calc(var(--sp) * 3)" }}>
        <p className="muted">
          ホーム・作る・キュー・オートパイロット・設定の各画面は M3 以降で作ります
          （プロトタイプ到着後）。
        </p>
        <div style={{ marginTop: "calc(var(--sp) * 3)" }}>
          <button className="btn" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
            ログアウト
          </button>
        </div>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* メールのリンクは /login?reset=<token>。/reset でも同じ画面を出す */}
      <Route path="/reset" element={<Login />} />
      <Route
        path="/app/*"
        element={
          <RequireAuth>
            <AppPlaceholder />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/app/home" replace />} />
    </Routes>
  );
}
