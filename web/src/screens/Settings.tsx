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
import { AI_DEFAULT_MODEL } from "@tap/shared";
import {
  downloadCsv,
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
    <div className="page-heading"><div><h1>設定</h1><p className="muted">つないだアカウント、AIキー、通知、ログイン情報をここで変えられます。</p></div></div>
    <div className="settings-tabs" role="tablist" aria-label="設定の種類">{tabs.map(t => <button key={t.id} id={`settings-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="settings-panel" className="settings-tab" tabIndex={tab === t.id ? 0 : -1} onKeyDown={e => {
      const i = tabs.findIndex(v => v.id === t.id);
      const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); const id = tabs[next]!.id; setTab(id); document.getElementById(`settings-tab-${id}`)?.focus(); }
    }} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
    <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} className="settings-content" key={tab}>
      {tab === "connections" && <><AccountsCard /><AiKeyCard /><ExportCard /></>}
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
  // どの欄の誤りか（欄の下に理由を出す）。欄に結びつかない誤りは下のメッセージに出す
  const [errorField, setErrorField] = useState<"current" | "next" | "confirmation" | null>(null);
  const fieldError = (f: "current" | "next" | "confirmation") => errorField === f && error ? <span className="field-error" role="alert">{error}</span> : null;
  return <section className="card section password-card">
    <div className="section-head"><h2>パスワードを変更</h2><span className="tag">ログイン情報</span></div>
    <p className="muted">{data?.user.email}</p>
    <form onSubmit={async e => {
      e.preventDefault(); setError(null); setErrorField(null);
      if (next !== confirmation) { setError("新しいパスワードが一致しません。同じものを2回入力してください"); setErrorField("confirmation"); return; }
      try { await change.mutateAsync({ current_password: current, new_password: next }); }
      catch (e) {
        setError(e instanceof ApiError ? e.message : "変更できませんでした。もう一度お試しください");
        const code = e instanceof ApiError ? e.code : "";
        setErrorField(code === "PASSWORD_INCORRECT" ? "current" : code === "WEAK_PASSWORD" || code === "PASSWORD_UNCHANGED" ? "next" : null);
      }
    }}>
      <label className="field"><span>現在のパスワード</span><input className="input" type="password" autoComplete="current-password" required maxLength={200} aria-invalid={errorField === "current"} value={current} onChange={e => setCurrent(e.target.value)} />{fieldError("current")}</label>
      <div className="password-fields">
        <label className="field"><span>新しいパスワード</span><input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={200} required aria-invalid={errorField === "next"} value={next} onChange={e => setNext(e.target.value)} />{fieldError("next") ?? <small className="muted">8〜200文字で入力してください。</small>}</label>
        <label className="field"><span>新しいパスワード（確認）</span><input className="input" type="password" autoComplete="new-password" minLength={8} maxLength={200} required aria-invalid={errorField === "confirmation"} value={confirmation} onChange={e => setConfirmation(e.target.value)} />{fieldError("confirmation")}</label>
      </div>
      <p className="security-note">変更すると、すべての端末からログアウトします。新しいパスワードでログインし直してください。</p>
      {error && !errorField && <p className="msg msg-bad" role="alert">{error}</p>}
      <button aria-busy={change.isPending} type="submit" className="btn btn-fit" disabled={change.isPending}>{change.isPending ? "変更しています…" : "パスワードを変更"}</button>
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
          このアプリからアカウントの投稿の記録・数字・キュー・学習・リンクが消えます。
        </p>
        <div
          className="section"
          style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}
        >
          <button aria-busy={remove.isPending}
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
        : days === 0
          ? "トークンの期限が切れています"
          : `トークンはあと${days}日`;
  // 期限切れ・14日を切ったら、延長を一番目立つ操作にする
  const urgent = days !== null && days <= 14;

  return (
    <div className="acct-row">
      <div className="acct-head">
        <AccountAvatar account={account} />
        <span className="acct-name">
          <span className="t">@{account.username}</span>
          <span className={account.status === "needs_reauth" || days === 0 ? "n bad" : "n"}>
            {tokenNote}
          </span>
        </span>
      </div>
      <div className="acct-actions">
        <button type="button" className="btn-quiet" onClick={onDiagnose}>
          診断
        </button>
        <button aria-busy={refresh.isPending}
          type="button"
          className={urgent ? "btn btn-fit" : "btn-quiet"}
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
        <button aria-busy={diagnose.isPending}
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
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider ?? "gemini");
      setModel(settings.data.model ?? "");
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
        キーはサーバーで暗号化して保存します。
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
        <input
          className="input"
          value={model}
          placeholder={AI_DEFAULT_MODEL[provider]}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      <label className="field">
        <span>APIキー</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={key}
          aria-invalid={keyError !== null}
          aria-describedby={keyError ? "ai-key-error" : undefined}
          onChange={(e) => {
            setKey(e.target.value);
            setKeyError(null);
          }}
          placeholder={
            settings.data?.hasKey
              ? "登録済み。変更するときだけ入力"
              : "APIキーを入力"
          }
        />
        {keyError && <span className="field-error" id="ai-key-error" role="alert">{keyError}</span>}
      </label>
      <div className="section" style={{ display: "grid", gap: 12 }}>
        <button aria-busy={save.isPending}
          className="btn"
          disabled={save.isPending}
          onClick={() => {
            if (!key.trim() && !settings.data?.hasKey) {
              setKeyError("APIキーを入力してください。プロバイダの管理画面で発行できます");
              return;
            }
            save.mutate(
              {
                provider,
                model: model || undefined,
                key: key.trim() || undefined,
                storeOnServer: true,
              },
              {
                onSuccess: () => {
                  setKey("");
                  toast.show("暗号化して保存しました", "ok");
                },
                onError: (e) => setKeyError(e instanceof Error ? e.message : "保存できませんでした"),
              },
            );
          }}
        >
          {save.isPending ? "保存中…" : "保存する"}
        </button>
        <button aria-busy={test.isPending}
          className="btn btn-sub"
          disabled={dirty || !settings.data?.hasKey || test.isPending}
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
          {test.isPending ? "確認しています…" : "保存した設定で接続確認"}
        </button>
        {dirty ? (
          <p className="btn-hint" style={{ marginTop: 0 }}>接続確認の前に、変更を保存してください。</p>
        ) : !settings.data?.hasKey && (
          <p className="btn-hint" style={{ marginTop: 0 }}>キーを保存すると、接続を確認できます。</p>
        )}
        {settings.data?.hasKey && (
          <button
            className="btn btn-sub danger"
            disabled={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "保存したAIキーを削除しますか？AI で作る・直すが使えなくなります。",
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
                投稿の失敗・トークンの期限を知らせます
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
  // 「自動投稿の候補に含める」のスイッチは、オートパイロットの入口を閉じているあいだ出さない（DECISIONS 2026-10-21）
  return <details className="section link-editor"><summary><span className="link-editor-name">{link.label}</span><span className="muted">名前の設定</span></summary>
    <form onSubmit={e => { e.preventDefault(); if (label.trim()) save({ label: label.trim() }); }}>
      <label className="field"><span>リンクの名前</span><input className="input" value={label} maxLength={100} onChange={e => setLabel(e.target.value)} placeholder="例：自分のBrain" /></label>
      <p className="muted" style={{ overflowWrap: "anywhere" }}>{link.url}</p>
      <button className="btn btn-sub" type="submit" disabled={update.isPending || !label.trim() || label.trim() === link.label}>名前を保存</button>
    </form>
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
      <p className="muted">名前を保存すると、アナリティクスのリンク一覧にも反映されます。項目を開くと、名前を変更できます。</p>
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
                セキュリティのため末尾4桁のみ表示
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

/**
 * CSV の書き出し。Google スプレッドシート連携を入れたときに外していたが、戻した
 * （DECISIONS 2026-10-21）。アカウントはドロップダウンで選び（最初は見ているアカウント）、
 * ボタン1つで保存する。保存の実体は `downloadCsv`。
 */
function ExportCard() {
  const toast = useToast();
  const { account } = useShell();
  const accounts = useAccounts();
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = accounts.data ?? [];
  const selectedId = chosen && list.some((a) => a.id === chosen) ? chosen : (account?.id ?? list[0]?.id ?? null);
  const selected = list.find((a) => a.id === selectedId) ?? null;

  return (
    <section className="card section">
      <div className="section-head">
        <h2>CSV で書き出す</h2>
      </div>
      <p className="muted">
        投稿と数字（表示回数・いいね・推定クリック・48時間後の断面）を CSV で保存します。
      </p>
      {list.length === 0 && !accounts.isPending && (
        <p className="muted">Threads のアカウントをつなぐと、ここから書き出せます。</p>
      )}
      {list.length > 0 && (
        <>
          <label className="field" htmlFor="export-account">
            <span>アカウント</span>
            <select
              id="export-account"
              className="input"
              value={selectedId ?? ""}
              disabled={busy}
              onChange={(e) => setChosen(e.target.value)}
            >
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-sub section"
            disabled={busy || !selected}
            onClick={() => {
              if (!selected) return;
              setBusy(true);
              downloadCsv(selected.id, selected.username)
                .then(() => toast.show("CSV を保存しました", "ok"))
                .catch((e: unknown) =>
                  toast.show(e instanceof ApiError ? e.message : "書き出しに失敗しました", "bad"),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "書き出しています…" : "CSV で保存"}
          </button>
        </>
      )}
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
          このアプリ内の情報を全て削除します。この操作は取り消せません。
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
          <button aria-busy={del.isPending}
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
