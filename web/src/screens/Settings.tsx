import AccountAvatar from "../components/AccountAvatar";
/**
 * 設定（SPEC §12.3 Settings）。M7 で全部そろった。
 *
 * 上から: アカウント（最大3・追加・診断・トークン延長・外す）→ AIキー（BYOK）→
 * 通知 → リンク一覧 → ライセンス → 退会。
 *
 * 取り返しのつかない操作（アカウントを外す・退会）は確認シートを挟む。退会だけは
 * さらにパスワードの再入力を求める（SPEC §7.8）。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AccountSummary, AiProvider, DiagnoseStep, LinkSummary } from "@tap/shared";
import { AI_DEFAULT_MODEL, AI_MODELS } from "@tap/shared";
import {
  useUpdateLink,
  useAccounts,
  useDeleteAccount,
  useDeleteUser,
  useDiagnose,
  useLicense,
  useLinks,
  useRefreshToken,
} from "../api/accounts";
import {
  useDeleteAiKey,
  useAiSettings,
  useSaveAiSettings,
  useTestAi,
} from "../api/ai";
import { useNotifications, usePutNotifications } from "../api/autopilot";
import { ApiError } from "../api/client";
import { useChangePassword, useMe } from "../api/auth";
import Sheet from "../components/Sheet";
import Pagination, { usePagination } from "../components/Pagination";
import { useToast } from "../components/Toast";
import { useShell } from "../components/Shell";
import {
  useGoogleStatus,
  useGoogleConnect,
  useGoogleSync,
  useGoogleDisconnect,
  useGoogleRepair,
} from "../api/google";
import { pushSupported, subscribePush, unsubscribePush } from "../lib/push";

const PROVIDERS: Array<{ key: AiProvider; label: string; note: string }> = [
  {
    key: "gemini",
    label: "Gemini",
    note: "無料枠あり。YouTube の動画をそのまま読めます",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    note: "モデルを選べます。動画は読めません",
  },
];

export default function Settings() {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get("tab") === "links" ? "links" : "connections");
  const tabs = [{ id: "connections", label: "接続とAI" }, { id: "links", label: "リンク" }, { id: "notifications", label: "通知" }, { id: "security", label: "ログインとセキュリティ" }];
  return <>
    <div className="page-heading"><div><p className="eyebrow">WORKSPACE SETTINGS</p><h1>設定</h1><p className="muted">アカウントと、あなたの投稿環境を管理します。</p></div></div>
    <div className="settings-tabs" role="tablist" aria-label="設定の種類">{tabs.map(t => <button key={t.id} id={`settings-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="settings-panel" className="settings-tab" tabIndex={tab === t.id ? 0 : -1} onKeyDown={e => {
      const i = tabs.findIndex(v => v.id === t.id);
      const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); const id = tabs[next]!.id; setTab(id); document.getElementById(`settings-tab-${id}`)?.focus(); }
    }} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
    {new URLSearchParams(window.location.search).get("google") === "failed" && <p className="msg msg-bad" role="alert">Google連携が完了しませんでした。ログイン状態とアクセス許可を確認して、もう一度連携してください。</p>}
    <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} className="settings-content" key={tab}>
      {tab === "connections" && <><AccountsCard /><AiKeyCard /><GoogleSheetsCard /></>}
      {tab === "links" && <LinksCard />}
      {tab === "notifications" && <NotificationCard />}
      {tab === "security" && <><PasswordCard /><LicenseCard /><DangerCard /></>}
    </div>
  </>;
}

function PasswordCard() {
  const { data } = useMe();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <section className="card section password-card">
    <div className="section-head"><h2>パスワードを変更</h2><span className="tag">ログイン情報</span></div>
    <p className="muted">{data?.user.email}</p>
    <form onSubmit={async e => {
      e.preventDefault(); setError(null);
      if (next !== confirmation) { setError("新しいパスワードが一致しません"); return; }
      try { await change.mutateAsync({ current_password: current, new_password: next }); }
      catch (e) { setError(e instanceof ApiError ? e.message : "変更できませんでした。もう一度お試しください"); }
    }}>
      <label className="field"><span>現在のパスワード</span><input className="input" type="password" autoComplete="current-password" required maxLength={200} value={current} onChange={e => setCurrent(e.target.value)} /></label>
      <div className="password-fields">
        <label className="field"><span>新しいパスワード</span><input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={200} required value={next} onChange={e => setNext(e.target.value)} /><small className="muted">8〜200文字で入力してください。</small></label>
        <label className="field"><span>新しいパスワード（確認）</span><input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={200} required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
      </div>
      <p className="security-note">変更すると、すべての端末からログアウトします。新しいパスワードでログインし直してください。</p>
      {error && <p className="msg msg-bad" role="alert">{error}</p>}
      <button type="submit" className="btn btn-fit" disabled={change.isPending}>{change.isPending ? "変更しています…" : "パスワードを変更"}</button>
    </form>
  </section>;
}

/* ── アカウント（SPEC §7.1 / §12.3） ─────────────────── */

function AccountsCard() {
  const toast = useToast();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const remove = useDeleteAccount();
  const [confirmRemove, setConfirmRemove] = useState<AccountSummary | null>(
    null,
  );
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

      {diagFor && (
        <DiagnoseSheet account={diagFor} onClose={() => setDiagFor(null)} />
      )}

      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={`@${confirmRemove?.username ?? ""} を外しますか？`}
      >
        <p>
          このアカウントの投稿の記録・数字・キュー・学習・リンクが消えます。Threads
          側の投稿は消えません。
        </p>
        <div
          className="section"
          style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}
        >
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
                  toast.show(
                    e instanceof ApiError ? e.message : "外せませんでした",
                    "bad",
                  ),
              });
            }}
          >
            {remove.isPending ? "外しています…" : "外す"}
          </button>
          <button
            type="button"
            className="btn btn-sub"
            onClick={() => setConfirmRemove(null)}
          >
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
        ? "有効期限未確認（長期トークンは延長で確認）"
        : `トークンはあと${days}日`;

  return (
    <div className="acct-row">
      <div className="acct-head">
        <AccountAvatar account={account} />
        <span className="acct-name">
          <span className="t">@{account.username}</span>
          <span className={account.status === "needs_reauth" ? "n bad" : "n"}>
            {tokenNote}
          </span>
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
              onSuccess: (r) =>
                toast.show(r.message, r.refreshed ? "ok" : "bad"),
              onError: (e) =>
                toast.show(
                  e instanceof ApiError ? e.message : "延長できませんでした",
                  "bad",
                ),
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
function DiagnoseSheet({
  account,
  onClose,
}: {
  account: AccountSummary;
  onClose: () => void;
}) {
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
      {steps === null && error === null && (
        <p className="muted">点検しています…</p>
      )}
      {error !== null && (
        <p className="msg msg-bad" role="status">
          {error}
        </p>
      )}
      {steps?.map((s) => (
        <div key={s.name} className="diag-step">
          <span
            className={s.ok ? "diag-mark ok" : "diag-mark bad"}
            aria-hidden="true"
          >
            {s.ok ? "✓" : "✕"}
          </span>
          <span className="diag-body">
            <span className="t">{s.name}</span>
            <span className="n">{s.detail}</span>
          </span>
        </div>
      ))}
      <div
        className="section"
        style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}
      >
        <button
          type="button"
          className="btn btn-sub"
          disabled={diagnose.isPending}
          onClick={() =>
            run(undefined, {
              onSuccess: (s) => setSteps(s),
              onError: (e) =>
                setError(
                  e instanceof ApiError ? e.message : "点検できませんでした",
                ),
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
  const toast = useToast(),
    settings = useAiSettings(),
    save = useSaveAiSettings(),
    test = useTestAi(),
    remove = useDeleteAiKey();
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [model, setModel] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [key, setKey] = useState("");
  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider ?? "gemini");
      setModel(settings.data.model ?? "");
      setAccepted(false);
    }
  }, [settings.data]);
  const dirty =
    key.trim() !== "" ||
    provider !== (settings.data?.provider ?? "gemini") ||
    model !== (settings.data?.model ?? "");
  function error(e: unknown) {
    toast.show(e instanceof Error ? e.message : "処理に失敗しました", "bad");
  }
  return (
    <section className="card section">
      <h2>AIキー</h2>
      <p className="muted">
        キーはサーバーで暗号化して保存し、AI実行時に復号して使用します。ブラウザやスプレッドシートには保存しません。
      </p>
      {!settings.data?.storeOnServer && (
        <p className="msg msg-warn">
          端末保存は終了しました。キーを再入力して保存してください。
        </p>
      )}
      <label className="field">
        <span>プロバイダ</span>
        <select
          className="input"
          value={provider}
          onChange={(e) => {
            const p = e.target.value as AiProvider;
            setProvider(p);
            setModel(AI_DEFAULT_MODEL[p]);
            setAccepted(false);
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>モデル</span>
        <select className="input" value={model || AI_DEFAULT_MODEL[provider]} onChange={e => { setModel(e.target.value); setAccepted(false); }}>
          {model && !AI_MODELS[provider].some(item => item.id === model) && <option value={model} disabled>以前のモデル（選び直してください）</option>}
          {AI_MODELS[provider].map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>APIキー</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => { setKey(e.target.value); setAccepted(false); }}
          placeholder={
            settings.data?.hasKey
              ? "登録済み。変更するときだけ入力"
              : "APIキーを入力"
          }
        />
      </label>
      <p className="muted section">{provider === "gemini" ? "送信先はGoogleです。無料枠のキーも利用できます。無料枠では入力・出力がGoogleの製品や機械学習の改善に使われ、人が確認する場合があります。個人情報・機密情報は入力しないでください。利用枠はGoogle側の設定に従い、上限に達すると生成を停止します。当アプリが課金を有効にすることはありません。" : "送信先はOpenRouterとAmazon Bedrock（米国の推論経路）です。Claude Sonnet 4.6を利用します。他の提供会社への自動切り替えを止め、学習利用不可・ZDRに対応する経路だけを利用します。対応経路がなければ生成は停止します。"} 参考投稿・参考資料・指示・本文を生成と修正のために送信します。自動運用を有効にした場合も同じ条件です。国外で処理される場合があります。</p>
      {!settings.data?.dataPolicyAccepted && settings.data?.hasKey && <p className="msg msg-warn">登録済みのキーは保持しています。以下を確認して保存するまでAI生成・修正・自動生成は停止しています。</p>}
      <label className="field"><span><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /> 送信先と<a href="/legal/privacy.html" target="_blank" rel="noreferrer">データの利用条件</a>を確認しました</span></label>
      <div className="section" style={{ display: "grid", gap: 12 }}>
        <button
          className="btn"
          disabled={save.isPending || !accepted}
          onClick={() =>
            save.mutate(
              {
                provider,
                model: model || undefined,
                key: key.trim() || undefined,
                storeOnServer: true,
                acceptDataPolicy: true,
              },
              {
                onSuccess: () => {
                  setKey("");
                  toast.show("暗号化して保存しました", "ok");
                },
                onError: error,
              },
            )
          }
        >
          {save.isPending ? "保存中…" : "保存する"}
        </button>
        <button
          className="btn btn-sub"
          disabled={dirty || !settings.data?.hasKey || !settings.data?.dataPolicyAccepted || test.isPending}
          onClick={() =>
            test.mutate(
              {},
              {
                onSuccess: (r) =>
                  toast.show(`つながりました（${r.model}）`, "ok"),
                onError: error,
              },
            )
          }
        >
          保存した設定で接続確認
        </button>
        {dirty && (
          <p className="muted">接続確認の前に変更を保存してください。</p>
        )}
        {settings.data?.hasKey && (
          <button
            className="btn btn-sub danger"
            disabled={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "保存したAIキーを削除し、自動運用を停止しますか？",
                )
              )
                remove.mutate(undefined, {
                  onSuccess: () => toast.show("キーを削除しました", "ok"),
                  onError: error,
                });
            }}
          >
            AIキーを削除する
          </button>
        )}
      </div>
    </section>
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
        toast.show(
          e instanceof ApiError ? e.message : "保存できませんでした",
          "bad",
        ),
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
      const res = currentlyOn
        ? await unsubscribePush()
        : await subscribePush(vapid);
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
                settings.emailEnabled
                  ? "メールを止めました"
                  : "メールを送ります",
              )
            }
          >
            <span className="body">
              <span className="t">メールで知らせる</span>
              <span className="n">
                自動投稿の下書き・投稿の失敗・トークンの期限。承認と取消のリンクが付きます
              </span>
            </span>
            <span className="state">
              {settings.emailEnabled ? "オン" : "オフ"}
            </span>
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
            <span className="state">
              {settings.pushEnabled ? "オン" : "オフ"}
            </span>
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
            <span
              className="muted"
              style={{ display: "block", marginTop: "var(--sp)" }}
            >
              前日の投稿数・表示回数・いいね・失敗を、この時刻に1通にまとめて送ります。
            </span>
          </label>
        </>
      )}
    </section>
  );
}

/* ── リンク一覧（SPEC §7.5 / §12.3） ─────────────────── */

function EditableLink({ accountId, link }: { accountId: string; link: LinkSummary }) {
  const [label, setLabel] = useState(link.label);
  const update = useUpdateLink(accountId);
  const toast = useToast();
  useEffect(() => { setLabel(link.label); }, [link.label]);
  function save(patch: { label?: string; enabledForAp?: boolean }) {
    update.mutate({ id: link.id, patch }, {
      onSuccess: () => toast.show("リンク設定を保存しました", "ok"),
      onError: e => toast.show(e instanceof ApiError ? e.message : "保存できませんでした", "bad"),
    });
  }
  return <details className="section link-editor"><summary><span className="link-editor-name">{link.label}</span><span className="muted">名前・自動投稿の設定</span></summary>
    <form onSubmit={e => { e.preventDefault(); if (label.trim()) save({ label: label.trim() }); }}>
      <label className="field"><span>リンクの名前</span><input className="input" value={label} maxLength={100} onChange={e => setLabel(e.target.value)} placeholder="例：自分のBrain" /></label>
      <p className="muted" style={{ overflowWrap: "anywhere" }}>{link.url}</p>
      <button className="btn btn-sub" type="submit" disabled={update.isPending || !label.trim() || label.trim() === link.label}>名前を保存</button>
    </form>
    <button className="btn btn-sub section" type="button" role="switch" aria-checked={link.enabledForAp} disabled={update.isPending} onClick={() => save({ enabledForAp: !link.enabledForAp })}>自動投稿の候補に含める：{link.enabledForAp ? "オン" : "オフ"}</button>
  </details>;
}

function LinksCard() {
  const { account } = useShell();
  const links = useLinks(account?.id ?? null);
  const list = links.data ?? [];
  const [search, setSearch] = useState("");
  const filtered = list.filter(l => `${l.label} ${l.url}`.toLowerCase().includes(search.trim().toLowerCase()));
  const paging = usePagination(filtered, `${account?.id}:${search}`);

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
      <p className="muted">名前を保存すると、アナリティクスのリンク一覧にも反映されます。項目を開くと、名前と自動投稿で使うかを変更できます。</p>
      <label className="field section"><span>リンクを探す</span><input className="input" type="search" placeholder="名前・URLで検索" value={search} onChange={e => setSearch(e.target.value)} /></label>
      {account && paging.items.map(l => <EditableLink key={account.id + l.id} accountId={account.id} link={l} />)}
      {search && !filtered.length && <p className="muted">一致するリンクがありません。</p>}
      <Pagination label="リンク設定" paging={paging} />
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

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="本当に退会しますか？"
      >
        <p>
          消したデータは戻せません。必要な記録を手元に残してから退会してください。
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
        <div
          className="section"
          style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}
        >
          <button
            type="button"
            className="btn btn-danger"
            disabled={del.isPending || password === ""}
            onClick={() =>
              del.mutate(password, {
                onSuccess: () => {
                  setOpen(false);
                  toast.show(
                    "退会しました。ご利用ありがとうございました",
                    "ok",
                  );
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

function GoogleSheetsCard() {
  const status = useGoogleStatus(),
    connect = useGoogleConnect(),
    sync = useGoogleSync(),
    disconnect = useGoogleDisconnect(),
    repair = useGoogleRepair(),
    toast = useToast();
  const data = status.data;
  const error = (e: unknown) =>
    toast.show(e instanceof Error ? e.message : "処理に失敗しました", "bad");
  return (
    <section className="card section">
      <h2>Googleスプレッドシート</h2>
      <p>
        Googleと連携すると、あなたのドライブに専用の管理表を作成します。投稿・分析・下書き・参考情報・予約結果を約1時間ごとに同期します。
      </p>
      <p className="muted">
        アプリに保存した記録を表へ反映します。表の編集はアプリに戻りません。APIキーやThreadsトークンは書き出しません。アプリ管理の5タブは上書きされます。自由な編集・集計は「自由メモ」や追加のタブで行ってください。
      </p>
      {status.isPending && <p>連携状態を確認しています…</p>}
      {status.isError && (
        <p className="msg msg-bad">連携状態を取得できませんでした。</p>
      )}
      {data && !data.configured && (
        <p className="msg msg-warn">Google連携は管理者による設定待ちです。</p>
      )}
      {data?.lastError && (
        <p role="status" className="msg msg-warn">
          {data.lastError}
        </p>
      )}
      {data?.connected && (
        <p>
          最終同期：
          {data.lastSyncAt
            ? new Date(data.lastSyncAt).toLocaleString()
            : "初回の作成・同期を待っています"}
        </p>
      )}
      {data?.spreadsheetUrl && (
        <p>
          <a
            className="btn btn-sub"
            href={data.spreadsheetUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            管理用スプレッドシートを開く ↗
          </a>
        </p>
      )}
      <div className="section" style={{ display: "grid", gap: 12 }}>
        <button
          className="btn"
          disabled={!data?.configured || connect.isPending}
          onClick={() => connect.mutate(undefined, { onError: error })}
        >
          {data?.connected ? "Googleと再連携" : "Googleと連携して管理表を作る"}
        </button>
        {data?.connected && (
          <>
            <button
              className="btn btn-sub"
              disabled={sync.isPending || data.status !== "connected"}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: () =>
                    toast.show("同期を受け付けました。順番に反映します", "ok"),
                  onError: error,
                })
              }
            >
              今すぐ同期
            </button>
            {data.status === "needs_attention" && (
              <button
                className="btn btn-sub"
                disabled={repair.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "アクセスできる管理表を探し、なければ再作成します。元の表の独自編集は復元できません。続けますか？",
                    )
                  )
                    repair.mutate(undefined, {
                      onSuccess: () =>
                        toast.show("管理表の復旧を受け付けました", "ok"),
                      onError: error,
                    });
                }}
              >
                管理表を復旧する
              </button>
            )}
            <button
              className="btn btn-sub danger"
              disabled={disconnect.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "連携を解除しますか？スプレッドシートは残り、自動同期が停止します。",
                  )
                )
                  disconnect.mutate(undefined, { onError: error });
              }}
            >
              連携を解除
            </button>
            <p className="muted">
              解除後もスプシはあなたのドライブに残ります。Google側のアクセス許可も取り消す場合は、Googleアカウントの連携設定から行ってください。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
