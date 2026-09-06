/**
 * 箱1: 自分の投稿から（design-v0.2 §3-4 / SPEC §12.3 Create）。
 *
 * 過去投稿を検索・指標で並べ替え、複数選択する。使い方は2つ:
 *   「型として使う」   … 文体の見本（`pickMode='template'`）
 *   「リライト元にする」… 1本目を書き直す（`pickMode='rewrite'`。選ぶのは1本）
 *
 * 指定が無いときはサーバー側が上位3本（型が重ならないように）を見本にする（SPEC §10.2）。
 */
import { useState } from "react";
import type { PostSummary } from "@tap/shared";
import type { AiPickMode } from "@tap/shared";
import { usePostPicker, type PostSort } from "../api/ai";
import { fmtN, md } from "../lib/format";

const SORTS: Array<{ key: PostSort; label: string }> = [
  { key: "new", label: "新しい順" },
  { key: "views", label: "表示回数" },
  { key: "likes", label: "いいね" },
  { key: "clicks", label: "クリック" },
];

export default function PostPicker({
  accountId,
  tz,
  picks,
  pickMode,
  onChange,
}: {
  accountId: string | null;
  tz: string;
  picks: string[];
  pickMode: AiPickMode;
  onChange: (next: { picks: string[]; pickMode: AiPickMode }) => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<PostSort>("views");
  const [open, setOpen] = useState(false);
  const list = usePostPicker(accountId, { q, sort });
  const posts: PostSummary[] = list.data?.posts ?? [];

  function toggle(id: string) {
    if (pickMode === "rewrite") {
      onChange({ pickMode, picks: picks[0] === id ? [] : [id] });
      return;
    }
    onChange({
      pickMode,
      picks: picks.includes(id) ? picks.filter((p) => p !== id) : [...picks, id],
    });
  }

  function setMode(mode: AiPickMode) {
    // リライトは1本だけ
    onChange({ pickMode: mode, picks: mode === "rewrite" ? picks.slice(0, 1) : picks });
  }

  return (
    <section className="card section">
      <div className="section-head">
        <h2>自分の投稿から</h2>
        <button type="button" className="btn-quiet" onClick={() => setOpen((v) => !v)}>
          {open ? "閉じる" : picks.length > 0 ? `${picks.length}本を選択中` : "選ぶ"}
        </button>
      </div>

      <div className="choices" style={{ marginTop: "var(--sp)" }}>
        <button
          type="button"
          className="choice"
          role="radio"
          aria-checked={pickMode === "template"}
          onClick={() => setMode("template")}
        >
          <span className="choice-title">型として使う</span>
          <span className="choice-note">
            語尾・一人称・改行の癖だけ真似ます。選ばなければ上位3本を使います
          </span>
        </button>
        <button
          type="button"
          className="choice"
          role="radio"
          aria-checked={pickMode === "rewrite"}
          onClick={() => setMode("rewrite")}
        >
          <span className="choice-title">リライト元にする</span>
          <span className="choice-note">1本を選んで、内容を保ったまま別の切り口で書き直します</span>
        </button>
      </div>

      {open && (
        <>
          <label className="field" htmlFor="picker-q">
            <span>本文で探す</span>
            <input
              id="picker-q"
              className="input"
              value={q}
              placeholder="キーワード"
              onChange={(e) => setQ(e.target.value)}
            />
          </label>

          <div className="chips" style={{ marginTop: "var(--sp)" }}>
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                className="chip"
                aria-pressed={sort === s.key}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {list.isPending && <p className="muted section">読み込んでいます…</p>}
          {!list.isPending && posts.length === 0 && (
            <p className="muted section">投稿が見つかりませんでした。</p>
          )}

          <div className="choices section">
            {posts.map((p) => (
              <button
                key={p.id}
                type="button"
                className="choice"
                role="checkbox"
                aria-checked={picks.includes(p.id)}
                onClick={() => toggle(p.id)}
              >
                <span className="choice-title">{p.text.slice(0, 40) || "（本文なし）"}</span>
                <span className="choice-note">
                  {md(p.postedAt, tz)} ・ 表示 {fmtN(p.views)} ・ いいね {fmtN(p.likes)} ・{" "}
                  {p.hook}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {!open && picks.length > 0 && (
        <p className="muted section">
          {pickMode === "rewrite" ? "リライト元" : "文体の見本"}に {picks.length} 本を選んでいます。
        </p>
      )}
    </section>
  );
}
