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

type Field = "email" | "password" | "license";

/** API のエラーを、直すべき欄に結びつける。どの欄でもないものは null（フォームの下に出す）。 */
function errorField(e: unknown, mode: Mode): Field | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === "EMAIL_TAKEN") return "email";
  if (e.code === "WEAK_PASSWORD") return "password";
  if (e.code === "LICENSE_INVALID" || e.code === "LICENSE_REVOKED") return mode === "register" ? "license" : null;
  return null;
}

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
    <main className="auth-layout">
      <aside className="auth-story"><div className="brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div>
        <div><h2>伝わる投稿を。<br />続けられる仕組みを。</h2><p>振り返る、書く、届ける。<br />あなたのThreadsを、ひとつの場所で。</p>
        <div className="auth-flow"><span>01<b>分析する</b></span><span>02<b>投稿をつくる</b></span><span>03<b>予約する</b></span></div></div>
        <small>Threads オートパイロット</small></aside>
      <div className="auth-form-wrap"><div className="auth-form-inner">
      <div className="brand auth-mobile-brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div>
      <h1 style={{ fontSize: 24 }}>{title}</h1>
      <p className="muted" style={{ marginTop: 6, marginBottom: "calc(var(--sp) * 3)" }}>
        {lead}
      </p>
      <div className="auth-form">{children}</div>
      </div></div>
    </main>
  );
}

function AuthForm() {
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "register" ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<Field | null>(null);
  // ログインの失敗はメールとパスワードのどちらが違うか言えない（言わない）ので、両方に印をつける
  const [loginFailed, setLoginFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(params.get("changed") === "1" ? "パスワードを変更しました。新しいパスワードでログインしてください。" : null);

  const login = useLogin();
  const register = useRegister();
  const forgot = useForgot();
  const busy = login.isPending || register.isPending || forgot.isPending;

  const switchTo = (next: Mode) => {
    setMode(next);
    setParams(next === "register" ? { mode: "register" } : {}, { replace: true });
    setPassword("");
    setError(null);
    setField(null);
    setLoginFailed(false);
    setNotice(null);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setField(null);
    setLoginFailed(false);
    setNotice(null);
    try {
      if (mode === "forgot") {
        await forgot.mutateAsync(email);
        setNotice("再設定リンクを送りました。メールをご確認ください（届かない場合は迷惑メールもご確認ください）");
        return;
      }
      if (mode === "register") {
        await register.mutateAsync({ email, password });
      } else {
        await login.mutateAsync({ email, password });
      }
      // The auth hook replaces the document after clearing the previous user state.
    } catch (err) {
      setError(errorMessage(err));
      setField(errorField(err, mode));
      setLoginFailed(err instanceof ApiError && err.code === "LOGIN_FAILED");
    }
  }

  const invalid = (f: Field) => field === f || (loginFailed && f !== "license");
  const fieldError = (f: Field) =>
    field === f && error ? <span className="field-error" role="alert">{error}</span> : null;

  const title = mode === "register" ? "はじめる" : mode === "forgot" ? "パスワードの再設定" : "ログイン";
  const lead =
    mode === "register"
      ? "登録は無料。まずは1アカウントから始められます"
      : mode === "forgot"
        ? "登録したメールアドレスに再設定リンクを送ります"
        : "Threads オートパイロット";

  return (
    <Shell title={title} lead={lead}>
      {mode === "register" && <div className="registration-guide"><strong>登録後にすること</strong><ol><li>発信の目標を選ぶ</li><li>Threadsアカウントをつなぐ</li><li>必要なら自分のGemini APIキーをつなぐ</li></ol><p>講座生は、登録したアカウントへ運営が有料版を適用します。</p></div>}
      <form onSubmit={onSubmit}>
        <label className="field">
          <span>メールアドレス</span>
          <input
            className="input"
            type="email"
            name="email"
            autoComplete="email"
            required
            aria-invalid={invalid("email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {fieldError("email")}
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
              aria-invalid={invalid("password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {fieldError("password")}
          </label>
        )}

        {error && !field && (
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
          <button aria-busy={busy} className="btn" type="submit" disabled={busy}>
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
              初めての方はこちら
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
          <button aria-busy={reset.isPending} className="btn" type="submit" disabled={reset.isPending}>
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
