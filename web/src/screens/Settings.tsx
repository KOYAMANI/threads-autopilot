import AiErrorNotice from "../components/AiErrorNotice";
import AccountAvatar from "../components/AccountAvatar";
/**
 * 設定（SPEC §12.3 Settings）。M7 で全部そろった。
 *
 * 上から: アカウント（最大3・追加・診断・トークン延長・外す）→ AIキー（BYOK）→
 * 通知 → リンク一覧 → 利用プラン → 退会。
 *
 * 取り返しのつかない操作（アカウントを外す・退会）は確認シートを挟む。退会だけは
 * さらにパスワードの再入力を求める（SPEC §7.8）。
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AccountSummary, AiProvider, DiagnoseStep, LinkSummary, UserGoal } from "@tap/shared";
import { AI_DEFAULT_MODEL, AI_MODELS } from "@tap/shared";
import {
  useUpdateLink,
  useAccounts,
  useDeleteAccount,
  useDeleteUser,
  downloadCsv,
  useDiagnose,
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
import { useClaudeConnection } from "../api/claude";
import { ApiError } from "../api/client";
import { useChangePassword, useMe, useSaveProfile } from "../api/auth";
import Sheet from "../components/Sheet";
import Pagination, { usePagination } from "../components/Pagination";
import { useToast } from "../components/Toast";
import { useShell } from "../components/Shell";
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
  const navigate = useNavigate();
  const ai = useAiSettings();
  const me = useMe();
  const accounts = useAccounts();
  const notifications = useNotifications();
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("tap:theme") || "system"; } catch { return "system"; } });
  const requested = new URLSearchParams(window.location.search).get("tab");
  const [active, setActive] = useState(() => requested === "connections" || requested === "ai" || requested === "google" || requested === "links" ? "connections" : requested === "account" || requested === "security" || requested === "danger" ? "account" : requested === "notifications" ? "notifications" : "general");
  const themeCard = <section className="card section"><div className="section-head"><h2>表示</h2><span className="muted">テーマ</span></div><div className="theme-options" role="radiogroup" aria-label="テーマ">{[{id:"system",label:"端末に合わせる"},{id:"light",label:"ライト"},{id:"dark",label:"ダーク"}].map(t => <button type="button" role="radio" aria-checked={theme === t.id} key={t.id} onClick={() => {setTheme(t.id);try { localStorage.setItem("tap:theme", t.id); } catch { /* Keep this session usable without storage. */ } window.dispatchEvent(new CustomEvent("themechange", {detail:t.id}));}}><span className={`theme-preview theme-preview-${t.id}`} aria-hidden="true"><i /><b /><em /></span>{t.label}</button>)}</div></section>;
  const groups = [
    { id: "general", label: "一般", summary: `${accounts.data?.length ?? "—"}アカウント`, content: <><AccountsCard /><ProfileCard />{themeCard}<PlanCard /></> },
    { id: "connections", label: "連携・データ", summary: ai.isPending ? "確認中…" : ai.data?.hasKey ? "AI接続済み・CSV" : "AI・CSV", content: <><AiKeyCard /><ClaudeCard /><ExportCard /><LinksCard /></> },
    { id: "notifications", label: "通知", summary: notifications.data ? `メール ${notifications.data.notifications.emailEnabled ? "オン" : "オフ"}・プッシュ ${notifications.data.notifications.pushEnabled ? "オン" : "オフ"}` : "確認中…", content: <NotificationCard /> },
    { id: "account", label: "アカウント", summary: "ログイン・退会", content: <><PasswordCard /><DangerCard /></> },
  ];
  const current = groups.find(group => group.id === active) ?? groups[0]!;
  const select = (id: string) => { setActive(id); window.history.replaceState(null, "", `${window.location.pathname}?tab=${id}`); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return <>
    <div className="page-heading"><div><h1>設定</h1><p className="muted">アカウントと投稿環境を管理します。</p></div><button type="button" className="btn btn-sub btn-fit" onClick={() => navigate("/onboarding")}>初期設定を見る</button></div>
    {me.data && !me.data.profile.onboardingCompleted && <div className="msg msg-warn settings-onboarding-return"><span>初期設定の途中です。Geminiの設定後、オンボーディングへ戻って完了してください。</span><button type="button" className="btn btn-sub btn-fit" onClick={() => navigate("/onboarding")}>初期設定へ戻る</button></div>}
    <div className="settings-layout">
      <nav className="settings-index" aria-label="設定の項目">{groups.map(g => <button type="button" aria-current={active === g.id ? "page" : undefined} key={g.id} onClick={() => select(g.id)}><span>{g.label}</span><small>{g.summary}</small></button>)}</nav>
      <section className="settings-panel" aria-labelledby="settings-panel-title"><div className="settings-panel-title"><p className="eyebrow">SETTINGS</p><h2 id="settings-panel-title">{current.label}</h2></div><div className="settings-list">{current.content}</div></section>
    </div>
  </>;
}


const PROFILE_GOALS: Array<{ id: UserGoal; label: string; detail: string }> = [
  { id: "monetize", label: "収益化", detail: "アフィリエイト・コンテンツ・講座販売" },
  { id: "shop", label: "店舗・サービス", detail: "店舗・サロン・相談・予約" },
  { id: "awareness", label: "認知・採用", detail: "個人発信・経営者・企業広報・採用" },
];

function ProfileCard() {
  const me = useMe();
  const save = useSaveProfile();
  const toast = useToast();
  const [goal, setGoal] = useState<UserGoal | null>(null);
  const [activity, setActivity] = useState("");
  const [audience, setAudience] = useState("");
  useEffect(() => {
    if (!me.data) return;
    setGoal(me.data.profile.goal);
    setActivity(me.data.profile.activity);
    setAudience(me.data.profile.audience);
  }, [me.data]);

  return <section className="card section">
    <div className="section-head"><h2>発信目的</h2><span className="tag">Tipsに反映</span></div>
    <p className="muted">ここで選んだ目的に合わせて、投稿ヒントの内容を切り替えます。</p>
    <div className="profile-goal-options" role="radiogroup" aria-label="発信目的">{PROFILE_GOALS.map(item => <button type="button" role="radio" aria-checked={goal === item.id} className={goal === item.id ? "is-active" : ""} key={item.id} onClick={() => setGoal(item.id)}><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div>
    <label className="field"><span>取り組んでいること</span><input className="input" maxLength={200} value={activity} onChange={event => setActivity(event.target.value)} placeholder="例：AI活用の講座販売" /></label>
    <label className="field"><span>どんな人に、何を届けたい？</span><textarea className="input" rows={3} maxLength={300} value={audience} onChange={event => setAudience(event.target.value)} placeholder="例：副業を始めたい人へ、最初の一歩を届けたい" /></label>
    {save.error && <p className="msg msg-bad" role="alert">{save.error instanceof ApiError ? save.error.message : "保存できませんでした"}</p>}
    <button type="button" className="btn btn-fit" disabled={!goal || save.isPending} onClick={async () => {
      if (!goal) return;
      try {
        await save.mutateAsync({ goal, activity, audience, onboardingCompleted: me.data?.profile.onboardingCompleted ?? false });
        toast.show("発信目的を保存しました", "ok");
      } catch { /* mutation state renders the error */ }
    }}>{save.isPending ? "保存しています…" : "発信目的を保存"}</button>
  </section>;
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
  const me = useMe();
  const remove = useDeleteAccount();
  const [confirmRemove, setConfirmRemove] = useState<AccountSummary | null>(
    null,
  );
  const [diagFor, setDiagFor] = useState<AccountSummary | null>(null);

  const list = accounts.data ?? [];
  const accountLimit = me.data?.entitlement.accountLimit ?? 1;

  return (
    <section className="card section">
      <div className="section-head">
        <h2>アカウント</h2>
        <span className="muted">{list.length} / {accountLimit}</span>
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
        disabled={list.length >= accountLimit}
        onClick={() => navigate("/connect?add=1")}
      >
        {list.length >= accountLimit ? `つなげるのは${accountLimit}つまでです` : "＋ アカウントを追加"}
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
          側の投稿は消えません。Meta側で連携を解除しただけでは、この一覧からは消えません。
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
  const [model, setModel] = useState<string>(AI_DEFAULT_MODEL.gemini);
  const [accepted, setAccepted] = useState(false);
  const [key, setKey] = useState("");
  const [failure, setFailure] = useState<unknown>(null);
  const [testResult, setTestResult] = useState("");
  useEffect(() => {
    if (settings.data) {
      const savedProvider = settings.data.provider ?? "gemini";
      setProvider(savedProvider);
      setModel(settings.data.model ?? AI_DEFAULT_MODEL[savedProvider]);
      setAccepted(false);
    }
  }, [settings.data]);
  const dirty =
    key.trim() !== "" ||
    provider !== (settings.data?.provider ?? "gemini") ||
    model !== (settings.data?.model ?? AI_DEFAULT_MODEL[settings.data?.provider ?? "gemini"]);
  function error(e: unknown) {
    setFailure(e);
    toast.show(e instanceof Error ? e.message : "処理に失敗しました", "bad");
  }
  return (
    <section className="card section">
      <h2>AIキー</h2>
      <p className="muted">
        キーはサーバーで暗号化して保存し、AI実行時に復号して使用します。ブラウザには保存しません。
      </p>
      {settings.isPending && <p>保存状態を確認しています…</p>}
      <AiErrorNotice error={failure || settings.error} />
      {settings.data?.hasKey && <div className="msg section" role="status"><strong>AIキー：保存済み</strong><p>{settings.data.provider} / {settings.data.model}</p><p>保存日時：{settings.data.savedAt ? new Date(settings.data.savedAt).toLocaleString() : "記録なし"}</p><p>{testResult || (settings.data.lastTest ? `最終接続確認：${settings.data.lastTest.success ? "成功" : "失敗"}（${new Date(settings.data.lastTest.at).toLocaleString()}）` : "この設定での接続確認の記録はまだありません")}</p></div>}
      {settings.data && <>
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
        <span>使用モデル</span>
        <select className="input" value={model} onChange={(e) => { setModel(e.target.value); setAccepted(false); }}>
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
      <p className="muted section">{provider === "gemini" ? "送信先はGoogleです。料金・無料枠・利用上限は、選んだモデルとGoogle側の設定に従います。無料枠では入力・出力がGoogleの製品や機械学習の改善に使われ、人が確認する場合があります。個人情報・機密情報は入力しないでください。上限に達すると生成を停止し、当アプリが課金を有効にすることはありません。" : "送信先はOpenRouterとAmazon Bedrock（米国の推論経路）です。Claude Sonnet 4.6を利用します。他の提供会社への自動切り替えを止め、学習利用不可・ZDRに対応する経路だけを利用します。対応経路がなければ生成は停止します。"} 参考投稿・参考資料・指示・本文を生成と修正のために送信します。自動運用を有効にした場合も同じ条件です。国外で処理される場合があります。</p>
      {!settings.data?.dataPolicyAccepted && settings.data?.hasKey && <p className="msg msg-warn">登録済みのキーは保持しています。以下を確認して保存するまでAI生成・修正・自動生成は停止しています。</p>}
      <label className="field"><span><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} /> 送信先と<a href="/legal/privacy.html" target="_blank" rel="noreferrer">データの利用条件</a>を確認しました</span></label>
      <div className="section" style={{ display: "grid", gap: 12 }}>
        <button
          className="btn"
          disabled={save.isPending || test.isPending || remove.isPending || !accepted || (!key.trim() && (!settings.data?.hasKey || provider !== settings.data.provider))}
          onClick={() =>
            save.mutate(
              {
                provider,
                model,
                key: key.trim() || undefined,
                storeOnServer: true,
                acceptDataPolicy: true,
              },
              {
                onSuccess: () => {
                  setKey("");  setFailure(null); setTestResult("");
                  toast.show("暗号化して保存しました", "ok");
                },
                onError: error,
              },
            )
          }
        >
          {save.isPending ? "保存中…" : "保存する"}
        </button>
      </div></>}
      <div className="section" style={{display:"grid", gap:12}}>
        <button
          className="btn btn-sub"
          disabled={dirty || !settings.data?.hasKey || !settings.data?.dataPolicyAccepted || test.isPending || save.isPending || remove.isPending}
          onClick={() =>
            test.mutate(
              {},
              {
                onSuccess: (r) => {setFailure(null);setTestResult(`接続確認：成功（${r.model}、${r.latencyMs}ms）`); toast.show(`つながりました（${r.model}）`, "ok");},
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
                  onSuccess: () => {setFailure(null);setTestResult("");setKey("");toast.show("キーを削除しました", "ok");},
                  onError: error,
                });
            }}
          >
            AIキーを削除する
          </button>
        )}
      </div>
      <p className="muted section">このアプリの直近24時間のAI操作：{settings.data?.requestsLast24h ?? "—"}件（記録開始後の接続確認・生成・修正の受付数。Googleへの呼び出し回数や残量ではありません）</p>
      <p className="muted section">接続確認も利用枠を消費します。3案生成では複数回呼び出すため、生成回数とGoogleのAPI回数は一致しません。このアプリではGoogle側の残量を取得していません。</p>
      <a href="https://aistudio.google.com/usage" target="_blank" rel="noreferrer">Google AI Studioで利用量・上限を確認 ↗</a>
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

function PlanCard() {
  const me = useMe();
  const entitlement = me.data?.entitlement;
  const planLabel = entitlement?.plan === "academy" ? "講座生" : entitlement?.plan === "pro" ? "Pro" : "無料";
  return (
    <section className="card section">
      <div className="section-head">
        <h2>利用プラン</h2>
        <span className="tag">{planLabel}</span>
      </div>
      {me.isPending && <p className="muted">読み込んでいます…</p>}
      {entitlement && (
        <>
          <div className="switch-row">
            <span className="body">
              <span className="t">Threadsアカウント</span>
              <span className="n">連携できるアカウント数</span>
            </span>
            <span className="state num">{entitlement.accountLimit}件まで</span>
          </div>
          <div className="switch-row">
            <span className="body">
              <span className="t">投稿ヒント</span>
              <span className="n">AIを使わないため、どのプランでも利用できます</span>
            </span>
            <span className="state">利用できます</span>
          </div>
          <div className="switch-row">
            <span className="body">
              <span className="t">Geminiによる作成・バズ診断</span>
              <span className="n">β版は自分のGemini APIキーを使用します</span>
            </span>
            <span className="state">接続後に利用</span>
          </div>
          <div className="switch-row" aria-disabled="true">
            <span className="body">
              <span className="t">運営のAIキーを使う</span>
              <span className="n">β版では停止中。設定だけ保持して、後から解放できます</span>
            </span>
            <span className="state">準備中</span>
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
          のトークンを全部消します。取り消せません。
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
        <p className="msg msg-warn section" role="status">連携データと下書きを含む、すべての保存データが削除されます。</p>
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

/** Claude 連携の画面への入口。スマホではタブに出さないので、ここから開く（DECISIONS 2026-10-20） */
function ClaudeCard() {
  const navigate = useNavigate();
  const connection = useClaudeConnection();
  const data = connection.data;
  if (data && !data.configured) return null;
  return <section className="card section">
    <div className="section-head"><h2>Claude 連携</h2><span className="muted">{data?.verifiedAt ? "つながっています" : data?.connected ? "あと少し" : "未連携"}</span></div>
    <p className="muted">自分の Claude（claude.ai）で、投稿の3案づくりや直しができます。AI キーは要りません。</p>
    <button type="button" className="btn btn-sub btn-fit section" onClick={() => navigate("/app/claude")}>{data?.verifiedAt ? "連携を見る" : "Claude と連携する"}</button>
  </section>;
}

function ExportCard() {
  const accounts = useAccounts();
  const toast = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const list = accounts.data ?? [];

  async function download(account: AccountSummary) {
    setDownloading(account.id);
    try {
      await downloadCsv(account.id, account.username);
      toast.show(`@${account.username} のCSVを書き出しました`, "ok");
    } catch (error) {
      toast.show(error instanceof ApiError ? error.message : "CSVを書き出せませんでした", "bad");
    } finally {
      setDownloading(null);
    }
  }

  return <section className="card section export-card">
    <div className="section-head"><h2>CSV出力</h2><span className="muted">投稿データ</span></div>
    <p className="muted">投稿本文、投稿日、表示回数、いいねなどをCSVで保存できます。</p>
    {accounts.isPending && <p className="muted section">アカウントを確認しています…</p>}
    <div className="export-account-list section">
      {list.map(account => <div className="export-account-row" key={account.id}>
        <div><AccountAvatar account={account} /><span><strong>@{account.username}</strong><small>このアカウントの投稿データ</small></span></div>
        <button type="button" className="btn btn-sub btn-fit" disabled={downloading !== null} onClick={() => void download(account)}>
          {downloading === account.id ? "書き出しています…" : "CSVを書き出す"}
        </button>
      </div>)}
    </div>
    {!accounts.isPending && list.length === 0 && <p className="muted section">Threadsアカウントを接続すると書き出せます。</p>}
  </section>;
}
