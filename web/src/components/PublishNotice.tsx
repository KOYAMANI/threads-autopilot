/**
 * 「いま投稿・予約できない理由」と、その場で直す手段（キュー・作る画面で共通）。
 *
 * `canPublish` が false になる理由は3つある（worker/src/lib/accounts.ts）:
 * つなぎ直しが要る / 長期トークンの期限切れ / それ以外（無効化など）。
 * 理由ごとに文言と出口を変える — 期限切れなのに「連携してください」と出すと、
 * 連携済みの人が何をすればよいか分からなくなる。
 */
import { useNavigate } from "react-router-dom";
import type { AccountSummary } from "@tap/shared";
import { useRefreshToken } from "../api/accounts";
import { ApiError } from "../api/client";
import { useToast } from "./Toast";

/** いま投稿できない理由の見出しと本文。シートの見出しにも使う。 */
export function publishBlock(account: AccountSummary): { title: string; body: string; expired: boolean } {
  const expired = account.status === "ok" && account.tokenExpiresInDays === 0;
  const title =
    account.status === "needs_reauth"
      ? "Threads との接続が切れています"
      : expired
        ? "Threads のトークンの期限が切れています"
        : "いまは予約・投稿できません";
  const body =
    account.status === "needs_reauth"
      ? "つなぎ直すと、予約と投稿ができるようになります。"
      : expired
        ? "延長すると、予約と投稿ができるようになります。"
        : "設定の「診断」で原因を確かめられます。";
  return { title, body, expired };
}

export default function PublishNotice({
  account,
  plain = false,
  onLater,
}: {
  account: AccountSummary;
  /**
   * 枠を付けずに中身だけ出す（シートの中に置くとき。見出しはシートが持つ）。
   * 主な出口（延長 / つなぎ直す / 設定）を主ボタンにし、`onLater` があれば「あとで」を並べる
   */
  plain?: boolean;
  onLater?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useRefreshToken(account.id);

  if (account.canPublish) return null;

  const { title, body, expired } = publishBlock(account);
  const reconnect = account.status === "needs_reauth" || expired;
  const extend = () =>
    refresh.mutate(undefined, {
      onSuccess: (r) => toast.show(r.message, r.refreshed ? "ok" : "bad"),
      onError: (e) => toast.show(e instanceof ApiError ? e.message : "延長できませんでした", "bad"),
    });
  const goFix = () => navigate(reconnect ? "/connect?add=1" : "/app/settings");

  if (plain) {
    return (
      <div className="publish-plain" role="status">
        <p className="muted">{body}</p>
        <div className="sheet-row">
          {onLater && (
            <button type="button" className="btn btn-sub" onClick={onLater}>
              あとで
            </button>
          )}
          {expired ? (
            <button type="button" className="btn" aria-busy={refresh.isPending} disabled={refresh.isPending} onClick={extend}>
              {refresh.isPending ? "延長しています…" : "トークンを延長する"}
            </button>
          ) : (
            <button type="button" className="btn" onClick={goFix}>
              {reconnect ? "つなぎ直す" : "設定を開く"}
            </button>
          )}
        </div>
        {expired && (
          <div className="sheet-link">
            <button type="button" className="btn-link" onClick={goFix}>
              つなぎ直す
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="notice notice-warn" role="status">
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <div className="notice-actions">
        {expired && (
          <button
            type="button"
            className="btn btn-sub btn-fit"
            aria-busy={refresh.isPending}
            disabled={refresh.isPending}
            onClick={extend}
          >
            {refresh.isPending ? "延長しています…" : "トークンを延長する"}
          </button>
        )}
        <button type="button" className="btn-link" onClick={goFix}>
          {reconnect ? "つなぎ直す" : "設定を開く"}
        </button>
      </div>
    </div>
  );
}
