/**
 * Login（SPEC §12.1 `/login`）。
 * 登録 / ログインの切替、「パスワードを忘れた」導線、`?reset=<token>` の再設定フォーム。
 * 見た目は M3（prototype 到着後）に作り直す。ここは動く導線を置くだけ。
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { useForgot, useLogin, useRegister, useReset } from "../api/auth";

type Mode = "login" | "register" | "forgot";

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "処理に失敗しました。しばらくしてからもう一度お試しください";
}

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // メールのリンクは /login?reset=<token>（SPEC §5.1）。/reset?token=... でも受ける
  const resetToken = params.get("reset") ?? params.get("token");
  return resetToken ? (
    <ResetForm token={resetToken} onDone={() => navigate("/login", { replace: true })} />
  ) : (
    <AuthForm />
  );
}

function Shell({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <main style={{ padding: "calc(var(--sp) * 4) calc(var(--sp) * 2)" }}>
      <h1 style={{ fontSize: 24 }}>{title}</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: "calc(var(--sp) * 3)" }}>
        {lead}
      </p>
      <div className="card">{children}</div>
    </main>
  );
}

function AuthForm() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const login = useLogin();
  const register = useRegister();
  const forgot = useForgot();
  const busy = login.isPending || register.isPending || forgot.isPending;

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      if (mode === "forgot") {
        await forgot.mutateAsync(email);
        setNotice("再設定リンクを送りました。メールをご確認ください（届かない場合は迷惑メールもご確認ください）");
        return;
      }
      if (mode === "register") {
        await register.mutateAsync({ email, password, license_key: licenseKey });
      } else {
        await login.mutateAsync({ email, password });
      }
      navigate("/app/home", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const title = mode === "register" ? "はじめる" : mode === "forgot" ? "パスワードの再設定" : "ログイン";
  const lead =
    mode === "register"
      ? "購入時のライセンスキーで登録します"
      : mode === "forgot"
        ? "登録したメールアドレスに再設定リンクを送ります"
        : "Threads オートパイロット";

  return (
    <Shell title={title} lead={lead}>
      <form onSubmit={onSubmit} noValidate>
        <label className="field">
          <span>メールアドレス</span>
          <input
            className="input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        {mode !== "forgot" && (
          <label className="field">
            <span>パスワード{mode === "register" ? "（8文字以上）" : ""}</span>
            <input
              className="input"
              type="password"
              name="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
              minLength={mode === "register" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}

        {mode === "register" && (
          <label className="field">
            <span>ライセンスキー</span>
            <input
              className="input"
              type="text"
              name="license_key"
              placeholder="TAP-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              required
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
            />
          </label>
        )}

        {error && (
          <p className="msg msg-bad" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="msg msg-ok" role="status">
            {notice}
          </p>
        )}

        <div style={{ marginTop: "calc(var(--sp) * 3)" }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "送信中…" : mode === "register" ? "登録する" : mode === "forgot" ? "リンクを送る" : "ログイン"}
          </button>
        </div>
      </form>

      <div
        style={{
          marginTop: "calc(var(--sp) * 2)",
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        {mode === "login" && (
          <>
            <button className="btn btn-quiet" type="button" onClick={() => switchTo("register")}>
              ライセンスキーで登録
            </button>
            <button className="btn btn-quiet" type="button" onClick={() => switchTo("forgot")}>
              パスワードを忘れた
            </button>
          </>
        )}
        {mode !== "login" && (
          <button className="btn btn-quiet" type="button" onClick={() => switchTo("login")}>
            ログインに戻る
          </button>
        )}
      </div>
    </Shell>
  );
}

function ResetForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const reset = useReset();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await reset.mutateAsync({ token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (done) {
    return (
      <Shell title="設定しました" lead="新しいパスワードでログインしてください">
        <p className="muted">すべての端末からログアウトしました。もう一度ログインしてください。</p>
        <div style={{ marginTop: "calc(var(--sp) * 3)" }}>
          <button className="btn" type="button" onClick={onDone}>
            ログイン画面へ
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="新しいパスワード" lead="8文字以上で設定してください">
      <form onSubmit={onSubmit} noValidate>
        <label className="field">
          <span>新しいパスワード</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p className="msg msg-bad" role="alert">
            {error}
          </p>
        )}

        <div style={{ marginTop: "calc(var(--sp) * 3)" }}>
          <button className="btn" type="submit" disabled={reset.isPending}>
            {reset.isPending ? "設定中…" : "設定する"}
          </button>
        </div>
      </form>
      <div style={{ marginTop: "calc(var(--sp) * 2)" }}>
        <button className="btn btn-quiet" type="button" onClick={onDone}>
          ログインに戻る
        </button>
      </div>
    </Shell>
  );
}
