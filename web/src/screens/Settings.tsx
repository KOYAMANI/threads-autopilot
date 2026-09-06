/**
 * 設定（SPEC §12.3 Settings）。M7 で全部そろった。
 *
 * 上から: アカウント（最大3・追加・診断・トークン延長・外す）→ AIキー（BYOK）→
 * 通知 → リンク一覧 → ライセンス → データの書き出し → 退会。
 *
 * 「キーをこの端末にだけ保存」を **ONにしようとした時点で、保存前に確認を出す**
 * （SPEC §12.3 / DECISIONS の M3「トーストでの事後通知にしない」）:
 *   「この端末にだけ保存すると、オートパイロットは使えません…それでもよろしいですか？」
 * OK なら `localStorage.aiKey` に置き、サーバーには `storeOnServer=false` を送る。
 *
 * 取り返しのつかない操作（アカウントを外す・退会）は確認シートを挟む。退会だけは
 * さらにパスワードの再入力を求める（SPEC §7.8）。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AccountSummary, AiProvider, DiagnoseStep } from "@tap/shared";
import { AI_DEFAULT_MODEL } from "@tap/shared";
import {
  downloadCsv,
  useAccounts,
  useDeleteAccount,
  useDeleteUser,
  useDiagnose,
  useLicense,
  useLinks,
  useRefreshToken,
} from "../api/accounts";
import {
  readClientKey,
  useAiSettings,
  useSaveAiSettings,
  useTestAi,
  writeClientKey,
} from "../api/ai";
import { useNotifications, usePutNotifications } from "../api/autopilot";
import { ApiError } from "../api/client";
import Sheet from "../components/Sheet";
import { useToast } from "../components/Toast";
import { useShell } from "../components/Shell";
import { pushSupported, subscribePush, unsubscribePush } from "../lib/push";

const PROVIDERS: Array<{ key: AiProvider; label: string; note: string }> = [
  { key: "gemini", label: "Gemini", note: "無料枠あり。YouTube の動画をそのまま読めます" },
  { key: "openrouter", label: "OpenRouter", note: "モデルを選べます。動画は読めません" },
];

export default function Settings() {
  return (
    <>
      <h1>設定</h1>
      <AccountsCard />
      <AiKeyCard />
      <NotificationCard />
      <LinksCard />
      <LicenseCard />
      <ExportCard />
      <DangerCard />
    </>
  );
}

/* ── アカウント（SPEC §7.1 / §12.3） ─────────────────── */

function AccountsCard() {
  const toast = useToast();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const remove = useDeleteAccount();
  const [confirmRemove, setConfirmRemove] = useState<AccountSummary | null>(null);
  const [diagFor, setDiagFor] = useState<AccountSummary | null>(null);

  const list = accounts.data ?? [];

  return (
    <section className="card section">
      <div className="section-head">
        <h2>アカウント</h2>
        <span className="muted">{list.length} / 3</span>
      </div>

      {accounts.isPending && <p className="muted">読み込んでいます…</p>}

      {list.map((a) => (
        <AccountRow
          key={a.id}
          account={a}
          onDiagnose={() => setDiagFor(a)}
          onRemove={() => setConfirmRemove(a)}
        />
      ))}

      <button
        type="button"
        className="btn btn-sub section"
        disabled={list.length >= 3}
        onClick={() => navigate("/connect?add=1")}
      >
        {list.length >= 3 ? "つなげるのは3つまでです" : "＋ アカウントを追加"}
      </button>

      {diagFor && <DiagnoseSheet account={diagFor} onClose={() => setDiagFor(null)} />}

      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={`@${confirmRemove?.username ?? ""} を外しますか？`}
      >
        <p>
          このアカウントの投稿の記録・数字・キュー・学習・リンクが消えます。Threads
          側の投稿は消えません。
        </p>
        <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            onClick={() => {
              const target = confirmRemove;
              if (!target) return;
              remove.mutate(target.id, {
                onSuccess: () => {
                  setConfirmRemove(null);
                  toast.show(`@${target.username} を外しました`, "ok");
                  // 0件になったら接続画面へ（SPEC §12.1）
                  if ((accounts.data ?? []).length <= 1) navigate("/connect");
                },
                onError: (e) =>
                  toast.show(e instanceof ApiError ? e.message : "外せませんでした", "bad"),
              });
            }}
          >
            {remove.isPending ? "外しています…" : "外す"}
          </button>
          <button type="button" className="btn btn-sub" onClick={() => setConfirmRemove(null)}>
            やめる
          </button>
        </div>
      </Sheet>
    </section>
  );
}

function AccountRow({
  account,
  onDiagnose,
  onRemove,
}: {
  account: AccountSummary;
  onDiagnose: () => void;
  onRemove: () => void;
}) {
  const toast = useToast();
  const refresh = useRefreshToken(account.id);

  const days = account.tokenExpiresInDays;
  const tokenNote =
    account.status === "needs_reauth"
      ? "つなぎ直しが必要です"
      : days === null
        ? "短期トークン（長期化されていません）"
        : `トークンはあと${days}日`;

  return (
    <div className="acct-row">
      <div className="acct-head">
        <span className="dot" style={{ background: account.color }} aria-hidden="true" />
        <span className="acct-name">
          <span className="t">@{account.username}</span>
          <span className={account.status === "needs_reauth" ? "n bad" : "n"}>{tokenNote}</span>
        </span>
      </div>
      <div className="acct-actions">
        <button type="button" className="btn-quiet" onClick={onDiagnose}>
          診断
        </button>
        <button
          type="button"
          className="btn-quiet"
          disabled={refresh.isPending}
          onClick={() =>
            refresh.mutate(undefined, {
              onSuccess: (r) => toast.show(r.message, r.refreshed ? "ok" : "bad"),
              onError: (e) =>
                toast.show(e instanceof ApiError ? e.message : "延長できませんでした", "bad"),
            })
          }
        >
          {refresh.isPending ? "延長中…" : "トークン延長"}
        </button>
        <button type="button" className="btn-quiet danger" onClick={onRemove}>
          外す
        </button>
      </div>
    </div>
  );
}

/** 6段の点検（SPEC §7.1 `GET /accounts/:id/diagnose`）。開いた時点で1回走らせる。 */
function DiagnoseSheet({ account, onClose }: { account: AccountSummary; onClose: () => void }) {
  const diagnose = useDiagnose(account.id);
  const [steps, setSteps] = useState<DiagnoseStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = diagnose.mutate;

  useEffect(() => {
    setSteps(null);
    setError(null);
    run(undefined, {
      onSuccess: (s) => setSteps(s),
      onError: (e) =>
        setError(e instanceof ApiError ? e.message : "点検できませんでした"),
    });
  }, [run, account.id]);

  return (
    <Sheet open onClose={onClose} title={`@${account.username} の点検`}>
      {steps === null && error === null && <p className="muted">点検しています…</p>}
      {error !== null && (
        <p className="msg msg-bad" role="status">
          {error}
        </p>
      )}
      {steps?.map((s) => (
        <div key={s.name} className="diag-step">
          <span className={s.ok ? "diag-mark ok" : "diag-mark bad"} aria-hidden="true">
            {s.ok ? "✓" : "✕"}
          </span>
          <span className="diag-body">
            <span className="t">{s.name}</span>
            <span className="n">{s.detail}</span>
          </span>
        </div>
      ))}
      <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
        <button
          type="button"
          className="btn btn-sub"
          disabled={diagnose.isPending}
          onClick={() =>
            run(undefined, {
              onSuccess: (s) => setSteps(s),
              onError: (e) =>
                setError(e instanceof ApiError ? e.message : "点検できませんでした"),
            })
          }
        >
          {diagnose.isPending ? "点検しています…" : "もう一度点検する"}
        </button>
        <button type="button" className="btn btn-sub" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Sheet>
  );
}

/* ── AIキー（SPEC §7.6 / §12.3） ─────────────────────── */

function AiKeyCard() {
  const toast = useToast();
  const settings = useAiSettings();
  const save = useSaveAiSettings();
  const test = useTestAi();
  const accounts = useAccounts();

  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [storeOnServer, setStoreOnServer] = useState(true);
  const [confirmLocal, setConfirmLocal] = useState(false);

  // サーバーの状態を初期値にする（キー本体は返ってこない）
  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    if (s.provider) setProvider(s.provider);
    setModel(s.model ?? "");
    setStoreOnServer(s.storeOnServer);
  }, [settings.data]);

  const s = settings.data;
  const hasClientKey = readClientKey() !== null;
  const apOn = (accounts.data ?? []).filter((a) => a.autopilotEnabled);

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function commit(nextStoreOnServer: boolean) {
    const trimmed = key.trim();
    if (!nextStoreOnServer && trimmed === "" && !hasClientKey) {
      toast.show("この端末に保存するキーを入力してください", "bad");
      return;
    }
    save.mutate(
      {
        provider,
        model: model.trim() === "" ? undefined : model.trim(),
        // 端末保存のときはサーバーへキーを送らない
        key: nextStoreOnServer && trimmed !== "" ? trimmed : undefined,
        storeOnServer: nextStoreOnServer,
      },
      {
        onSuccess: () => {
          // 端末保存にしたときだけ localStorage に置く。サーバー保存に戻したら消す
          if (nextStoreOnServer) writeClientKey(null);
          else if (trimmed !== "") writeClientKey(trimmed);
          setKey("");
          setStoreOnServer(nextStoreOnServer);
          setConfirmLocal(false);
          toast.show("保存しました", "ok");
        },
        onError: (e) => fail(e, "保存できませんでした"),
      },
    );
  }

  /** ONにしようとした時点で確認を出す（SPEC §12.3。事後のトーストにしない） */
  function onToggleLocal(next: boolean) {
    if (next) {
      setConfirmLocal(true);
      return;
    }
    setStoreOnServer(true);
  }

  function runTest() {
    const clientKey = storeOnServer ? undefined : (key.trim() || readClientKey() || undefined);
    test.mutate(
      { clientKey },
      {
        onSuccess: (r) => toast.show(`つながりました（${r.model} / ${r.latencyMs}ms）`, "ok"),
        onError: (e) => fail(e, "つながりませんでした"),
      },
    );
  }

  return (
    <>
      <section className="card section">
        <div className="section-head">
          <h2>AIのプロバイダ</h2>
          <span className="muted">買い手のキーで動きます</span>
        </div>
        <div className="choices" style={{ marginTop: "var(--sp)" }}>
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              className="choice"
              role="radio"
              aria-checked={provider === p.key}
              onClick={() => {
                setProvider(p.key);
                setModel(AI_DEFAULT_MODEL[p.key]);
              }}
            >
              <span className="choice-title">{p.label}</span>
              <span className="choice-note">{p.note}</span>
            </button>
          ))}
        </div>

        <label className="field" htmlFor="ai-model">
          <span>モデル</span>
          <input
            id="ai-model"
            className="input"
            value={model}
            placeholder={AI_DEFAULT_MODEL[provider]}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>

        <label className="field" htmlFor="ai-key">
          <span>APIキー</span>
          <input
            id="ai-key"
            className="input"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              s?.hasKey
                ? "登録済み。変えるときだけ入力してください"
                : hasClientKey && s && !s.storeOnServer
                  ? "この端末に保存済み。変えるときだけ入力してください"
                  : "貼り付けてください"
            }
            onChange={(e) => setKey(e.target.value)}
          />
        </label>

        <p className="muted section">
          {s?.hasKey
            ? "いまはサーバーに保存しています。オートパイロットが使えます。"
            : s && !s.storeOnServer
              ? "いまはこの端末にだけ保存しています。オートパイロットは使えません。"
              : "まだキーがありません。"}
        </p>

        <div className="choices section">
          <button
            type="button"
            className="choice"
            role="switch"
            aria-checked={!storeOnServer}
            onClick={() => onToggleLocal(storeOnServer)}
          >
            <span className="choice-title">キーをこの端末にだけ保存</span>
            <span className="choice-note">
              サーバーに預けません。かわりにオートパイロットは使えません
            </span>
          </button>
        </div>

        <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
          <button
            type="button"
            className="btn"
            disabled={save.isPending}
            onClick={() => commit(storeOnServer)}
          >
            {save.isPending ? "保存しています…" : "保存する"}
          </button>
          <button
            type="button"
            className="btn btn-sub"
            disabled={test.isPending}
            onClick={runTest}
          >
            {test.isPending ? "試しています…" : "つながるか試す"}
          </button>
        </div>
      </section>

      <Sheet
        open={confirmLocal}
        onClose={() => setConfirmLocal(false)}
        title="この端末にだけ保存しますか？"
      >
        <p>
          この端末にだけ保存すると、オートパイロットは使えません（サーバーが自動生成のときにキーを読めないため）。それでもよろしいですか？
        </p>
        {apOn.length > 0 && (
          <p className="msg msg-warn section" role="status">
            いまオートパイロットがONのアカウント: {apOn.map((a) => `@${a.username}`).join("、")}
          </p>
        )}
        <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
          <button
            type="button"
            className="btn"
            disabled={save.isPending}
            onClick={() => commit(false)}
          >
            この端末にだけ保存する
          </button>
          <button type="button" className="btn btn-sub" onClick={() => setConfirmLocal(false)}>
            やめる
          </button>
        </div>
      </Sheet>
    </>
  );
}

/* ── 通知（SPEC §7.8 / §10.5） ──────────────────────── */

const DIGEST_HOURS = [7, 8, 9, 12, 18, 21];

function NotificationCard() {
  const toast = useToast();
  const notifications = useNotifications();
  const put = usePutNotifications();
  const settings = notifications.data?.notifications ?? null;
  const vapid = notifications.data?.vapidPublicKey ?? null;

  const [pushBusy, setPushBusy] = useState(false);

  const patch = (body: Parameters<typeof put.mutate>[0], ok: string) => {
    put.mutate(body, {
      onSuccess: () => toast.show(ok, "ok"),
      onError: (e) =>
        toast.show(e instanceof ApiError ? e.message : "保存できませんでした", "bad"),
    });
  };

  /**
   * プッシュは「設定の値」だけでなく **端末の購読**も切り替える（SPEC §7.8）。
   * 許可が下りなかったら設定は変えない（オンに見えて届かない状態を作らない）。
   */
  const togglePush = async (currentlyOn: boolean) => {
    if (!vapid) return;
    setPushBusy(true);
    try {
      const res = currentlyOn ? await unsubscribePush() : await subscribePush(vapid);
      if (!res.ok) {
        toast.show(res.message, "bad");
        return;
      }
      patch(
        { pushEnabled: !currentlyOn },
        currentlyOn ? "プッシュを止めました" : "この端末に通知します",
      );
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <section className="card section">
      <div className="section-head">
        <h2>通知</h2>
      </div>

      {notifications.isPending && <p className="muted">読み込んでいます…</p>}

      {settings && (
        <>
          <button
            type="button"
            role="switch"
            className="switch-row"
            aria-checked={settings.emailEnabled}
            disabled={put.isPending}
            onClick={() =>
              patch(
                { emailEnabled: !settings.emailEnabled },
                settings.emailEnabled ? "メールを止めました" : "メールを送ります",
              )
            }
          >
            <span className="body">
              <span className="t">メールで知らせる</span>
              <span className="n">
                自動投稿の下書き・投稿の失敗・トークンの期限。承認と取消のリンクが付きます
              </span>
            </span>
            <span className="state">{settings.emailEnabled ? "オン" : "オフ"}</span>
          </button>

          <button
            type="button"
            role="switch"
            className="switch-row"
            aria-checked={settings.pushEnabled}
            disabled={put.isPending || pushBusy || !vapid || !pushSupported()}
            onClick={() => void togglePush(settings.pushEnabled)}
          >
            <span className="body">
              <span className="t">この端末に通知する（プッシュ）</span>
              <span className="n">
                {!vapid
                  ? "サーバーに鍵が設定されていないので、いまは使えません"
                  : !pushSupported()
                    ? "この端末では通知を使えません"
                    : "ホーム画面に追加した端末に届きます"}
              </span>
            </span>
            <span className="state">{settings.pushEnabled ? "オン" : "オフ"}</span>
          </button>

          <label className="field section">
            <span>まとめて知らせる時刻</span>
            <div className="chips" role="radiogroup" aria-label="通知の時刻">
              {DIGEST_HOURS.map((h) => (
                <button
                  key={h}
                  type="button"
                  role="radio"
                  className="chip"
                  aria-checked={settings.digestHour === h}
                  aria-pressed={settings.digestHour === h}
                  onClick={() => patch({ digestHour: h }, `${h}時に知らせます`)}
                >
                  {h}時
                </button>
              ))}
            </div>
            <span className="muted" style={{ display: "block", marginTop: "var(--sp)" }}>
              前日の投稿数・表示回数・いいね・失敗を、この時刻に1通にまとめて送ります。
            </span>
          </label>
        </>
      )}
    </section>
  );
}

/* ── リンク一覧（SPEC §7.5 / §12.3） ─────────────────── */

function LinksCard() {
  const { account } = useShell();
  const links = useLinks(account?.id ?? null);
  const list = links.data ?? [];

  return (
    <section className="card section">
      <div className="section-head">
        <h2>リンク</h2>
        <span className="muted">@{account?.username ?? ""}</span>
      </div>
      {links.isPending && <p className="muted">読み込んでいます…</p>}
      {!links.isPending && list.length === 0 && (
        <p className="muted">
          まだありません。投稿に入れたURLは、同期のときに自動で拾って並びます。
        </p>
      )}
      {list.map((l) => (
        <div key={l.id} className="link-row">
          <span className="link-body">
            <span className="t">{l.label}</span>
            <span className="n">{l.url}</span>
          </span>
          <span className="state">{l.enabledForAp ? "自動で使う" : "使わない"}</span>
        </div>
      ))}
    </section>
  );
}

/* ── ライセンス（SPEC §1 / §5.4） ────────────────────── */

const LICENSE_LABEL: Record<string, string> = {
  active: "有効",
  unused: "未使用",
  revoked: "無効（返金・退会などで停止）",
};

function LicenseCard() {
  const license = useLicense();
  const l = license.data;

  return (
    <section className="card section">
      <div className="section-head">
        <h2>ライセンス</h2>
      </div>
      {license.isPending && <p className="muted">読み込んでいます…</p>}
      {l && (
        <>
          <div className="switch-row" aria-hidden="false">
            <span className="body">
              <span className="t">キー</span>
              <span className="n">
                安全のため末尾4桁だけ出しています。全体は購入時のメールをご確認ください
              </span>
            </span>
            <span className="state num">TAP-••••-••••-{l.keyTail}</span>
          </div>
          <div className="switch-row" aria-checked={l.status === "active"}>
            <span className="body">
              <span className="t">状態</span>
              <span className="n">
                発行 {l.issuedAt.slice(0, 10)}
                {l.activatedAt ? ` / 登録 ${l.activatedAt.slice(0, 10)}` : ""}
              </span>
            </span>
            <span className="state">{LICENSE_LABEL[l.status] ?? l.status}</span>
          </div>
        </>
      )}
    </section>
  );
}

/* ── 書き出し（SPEC §7.8） ──────────────────────────── */

function ExportCard() {
  const toast = useToast();
  const accounts = useAccounts();
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <section className="card section">
      <div className="section-head">
        <h2>データの書き出し</h2>
      </div>
      <p className="muted">
        投稿と数字（表示回数・いいね・推定クリック・48時間後の断面）を CSV
        で保存します。Excel でそのまま開けます。
      </p>
      {(accounts.data ?? []).map((a) => (
        <button
          key={a.id}
          type="button"
          className="btn btn-sub section"
          disabled={busy !== null}
          onClick={() => {
            setBusy(a.id);
            downloadCsv(a.id, a.username)
              .then(() => toast.show("CSV を保存しました", "ok"))
              .catch((e: unknown) =>
                toast.show(
                  e instanceof ApiError ? e.message : "書き出しに失敗しました",
                  "bad",
                ),
              )
              .finally(() => setBusy(null));
          }}
        >
          {busy === a.id ? "書き出しています…" : `@${a.username} を CSV で保存`}
        </button>
      ))}
    </section>
  );
}

/* ── 退会（SPEC §7.8） ──────────────────────────────── */

function DangerCard() {
  const toast = useToast();
  const navigate = useNavigate();
  const del = useDeleteUser();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");

  return (
    <>
      <section className="card section">
        <div className="section-head">
          <h2>退会</h2>
        </div>
        <p className="muted">
          アカウント・投稿の記録・数字・キュー・参考情報・AIキー・Threads
          のトークンを全部消します。ライセンスキーも無効になり、もう使えません。取り消せません。
        </p>
        <button
          type="button"
          className="btn btn-danger section"
          onClick={() => {
            setPassword("");
            setOpen(true);
          }}
        >
          退会する
        </button>
      </section>

      <Sheet open={open} onClose={() => setOpen(false)} title="本当に退会しますか？">
        <p>
          消したデータは戻せません。必要なら先に「データの書き出し」で CSV
          を保存してください。
        </p>
        <p className="msg msg-warn section" role="status">
          ライセンスキーも無効になります。同じキーで登録し直すことはできません。
        </p>
        <label className="field" htmlFor="delete-password">
          <span>確認のため、パスワードをもう一度入力してください</span>
          <input
            id="delete-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
          <button
            type="button"
            className="btn btn-danger"
            disabled={del.isPending || password === ""}
            onClick={() =>
              del.mutate(password, {
                onSuccess: () => {
                  setOpen(false);
                  toast.show("退会しました。ご利用ありがとうございました", "ok");
                  // 認証はもう無いので、状態を持ち越さずに読み込み直す
                  window.location.href = "/login";
                },
                onError: (e) =>
                  toast.show(
                    e instanceof ApiError ? e.message : "退会できませんでした",
                    "bad",
                  ),
              })
            }
          >
            {del.isPending ? "退会しています…" : "すべて消して退会する"}
          </button>
          <button
            type="button"
            className="btn btn-sub"
            onClick={() => {
              setOpen(false);
              navigate("/app/settings");
            }}
          >
            やめる
          </button>
        </div>
      </Sheet>
    </>
  );
}
