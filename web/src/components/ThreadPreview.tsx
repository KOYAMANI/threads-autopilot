/**
 * 見本にした投稿を、ツリーの形の縮小版で見せる（作る画面の「伝えたいこと」手順。DECISIONS 2026-10-21）。
 *
 * 全文表示（PostViewer）と同じ並び（左にアバターと縦線、右に @名前 1/3・本文・表示回数）だが、
 * 本文は2行で切る。どのツリーを型にしているかが分かればよく、読むのは「全文を見る」で開く。
 */
import { useState } from "react";
import type { AccountSummary } from "@tap/shared";
import AccountAvatar from "./AccountAvatar";
import { fmtN, md } from "../lib/format";

export type PreviewSegment = { text: string; views?: number };

export default function ThreadPreview({
  label,
  account,
  segments,
  postedAt,
  tz,
  onOpen,
}: {
  /** 「見本」「元の投稿」「貼り付けた投稿」 */
  label: string;
  /** 貼り付けのときは null（アバターを出さない） */
  account: AccountSummary | null;
  /** 1投稿目から順に。2つ目以降はツリーの続き */
  segments: PreviewSegment[];
  postedAt?: string;
  tz: string;
  /**
   * 全文表示（PostViewer）を開く。無いとき（貼り付けた他人の投稿など、数字も投稿日も無いもの）は
   * その場で2行の切り詰めを外して全文を出す（2026-10-21）
   */
  onOpen?: () => void;
}) {
  const total = segments.reduce((n, s) => n + (s.views ?? 0), 0);
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`thread-preview${expanded ? " expanded" : ""}`} aria-label={label}>
      <div className="thread-preview-head">
        <span className="thread-preview-label">{label}</span>
        {postedAt && <span className="num">{md(postedAt, tz)}</span>}
        {total > 0 && <span className="num">表示 {fmtN(total)}</span>}
        {segments.length > 1 && <span>{segments.length}投稿のツリー</span>}
        {onOpen ? (
          <button type="button" className="btn-link" onClick={onOpen}>
            全文を見る
          </button>
        ) : (
          <button type="button" className="btn-link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "たたむ" : "全文を見る"}
          </button>
        )}
      </div>
      <ol className="thread-preview-list">
        {segments.map((s, i) => (
          <li key={i} className="thread-preview-post">
            <div className="thread-preview-rail" aria-hidden="true">
              {account ? <AccountAvatar account={account} /> : <span className="thread-preview-dot" />}
            </div>
            <div className="thread-preview-body">
              <div className="thread-preview-meta">
                {account && <strong>@{account.username}</strong>}
                {segments.length > 1 && <span>{i + 1}/{segments.length}</span>}
                {s.views !== undefined && <span className="num">表示 {fmtN(s.views)}</span>}
              </div>
              <p className="thread-preview-text">{s.text || "（本文なし）"}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
