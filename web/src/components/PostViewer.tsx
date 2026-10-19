/**
 * 投稿を全画面で読むビュー（ホームの投稿・キューの1件で共通）。
 *
 * 一覧の行は2〜3行で切れるので、タップしたらツリーの続きまで本文を全部見せる。
 * 本文を中央の1列に置き、操作は下の帯にまとめる（行の「…」シートはそのまま残す）。
 * 入れ物（閉じる・Esc・フォーカス・動き）は FullScreen。
 */
import type { ReactNode } from "react";
import type { AccountSummary } from "@tap/shared";
import AccountAvatar from "./AccountAvatar";
import FullScreen from "./FullScreen";

export type ViewerSegment = { text: string; views?: number; note?: string };
export type ViewerStat = { label: string; value: string };

export default function PostViewer({
  open,
  onClose,
  account,
  title,
  meta,
  segments,
  stats,
  children,
  actions,
  headerActions,
  showCount = false,
  escapeDisabled = false,
}: {
  open: boolean;
  onClose: () => void;
  account: AccountSummary;
  /** 上の帯の見出し（例: 「6/12 21:00 の投稿」） */
  title: string;
  /** 本文の上に出す状態・タグ */
  meta?: ReactNode;
  /** 1投稿目から順に。2つ目以降はツリーの続き */
  segments: ViewerSegment[];
  stats?: ViewerStat[];
  /** 本文の下に足すもの（失敗の理由など） */
  children?: ReactNode;
  actions?: ReactNode;
  /** 上の帯の右端（「Threads で開く」「その他の操作」など、主役でない操作） */
  headerActions?: ReactNode;
  /** 下書き・予約では文字数を出す（Threads は1投稿500字まで） */
  showCount?: boolean;
  /** 上にシートが重なっている間は Esc をシートに譲る */
  escapeDisabled?: boolean;
}) {
  return (
    <FullScreen
      open={open}
      onClose={onClose}
      title={title}
      headerActions={headerActions}
      footer={actions}
      escapeDisabled={escapeDisabled}
    >
      <article className="viewer-page">
        {meta && <div className="viewer-meta">{meta}</div>}
        <ol className="viewer-thread">
          {segments.map((s, i) => (
            <li key={i} className="viewer-post">
              <div className="viewer-rail" aria-hidden="true">
                <AccountAvatar account={account} />
              </div>
              <div className="viewer-body">
                <div className="viewer-head">
                  <strong>@{account.username}</strong>
                  {segments.length > 1 && <span className="muted">{i + 1}/{segments.length}</span>}
                </div>
                <p className="viewer-text">{s.text || "（本文なし）"}</p>
                {(s.views !== undefined || s.note || showCount) && (
                  <div className="viewer-foot num">
                    {s.views !== undefined && <span>{s.views.toLocaleString("ja-JP")} 表示</span>}
                    {s.note && <span>{s.note}</span>}
                    {showCount && (
                      <span className={[...s.text].length > 500 ? "over" : undefined}>
                        {[...s.text].length}/500字
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>

        {stats && stats.length > 0 && (
          <dl className="viewer-stats">
            {stats.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd className="num">{s.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </article>
    </FullScreen>
  );
}
